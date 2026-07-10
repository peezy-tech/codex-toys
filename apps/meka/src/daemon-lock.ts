import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const RECENT_INCOMPLETE_LOCK_MS = 10_000;
const ACQUIRE_ATTEMPTS = 64;
const CLAIM_PREFIX = "claim-";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type LockOwner = {
  version: 1;
  token: string;
  pid: number;
  cwd: string;
  startedAt: string;
  phase: "pending" | "owned";
};

type LegacyLockOwner = Omit<LockOwner, "phase">;

type InspectedClaim = {
  owner?: LockOwner;
  modifiedAt: number;
};

export type WorkspaceDaemonLock = {
  /** The unique, never-reused claim directory owned by this daemon. */
  path: string;
  token: string;
  release(): Promise<void>;
};

/**
 * Acquires one crash-recoverable daemon lock for an automation state root.
 *
 * The stable `daemon.lock` directory is only a registry. Every acquisition uses
 * a never-reused UUID claim beneath it. That makes stale cleanup and release
 * ownership-safe: neither operation ever removes a path that a later daemon can
 * acquire.
 */
export async function acquireWorkspaceDaemonLock(
  stateRoot: string,
  cwd: string,
): Promise<WorkspaceDaemonLock> {
  const registryPath = path.join(stateRoot, "daemon.lock");
  await ensureLockRegistry(registryPath);
  await rejectLegacyLock(registryPath);

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    const token = randomUUID();
    const claimPath = path.join(registryPath, `${CLAIM_PREFIX}${token}`);
    const owner: LockOwner = {
      version: 1,
      token,
      pid: process.pid,
      cwd: path.resolve(cwd),
      startedAt: new Date().toISOString(),
      phase: "pending",
    };

    await createClaim(claimPath, owner);
    try {
      const blockers = await activeClaims(registryPath, claimPath);
      const owned = blockers.find((candidate) => candidate.owner?.phase === "owned");
      if (owned?.owner) {
        await retireClaim(claimPath, token);
        throw new Error(
          `A Meka daemon already owns this automation state (pid ${owned.owner.pid}, cwd ${owned.owner.cwd})`,
        );
      }
      if (blockers.length > 0) {
        await retireClaim(claimPath, token);
        await delay(2 + Math.floor(Math.random() * 17));
        continue;
      }

      await writeOwner(claimPath, { ...owner, phase: "owned" });
      let released = false;
      return {
        path: claimPath,
        token,
        release: async () => {
          if (released) return;
          const retired = await retireClaim(claimPath, token);
          if (retired || !(await claimExists(claimPath))) released = true;
        },
      };
    } catch (error) {
      await retireClaim(claimPath, token).catch(() => undefined);
      throw error;
    }
  }
  throw new Error("Could not acquire the Meka automation-state lock due to contention");
}

async function ensureLockRegistry(registryPath: string): Promise<void> {
  await mkdir(registryPath, { recursive: true, mode: 0o700 });
  const metadata = await lstat(registryPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Meka daemon lock registry must be a real directory: ${registryPath}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`Meka daemon lock registry is not owned by the current user: ${registryPath}`);
  }
  await chmod(registryPath, 0o700);
}

async function createClaim(claimPath: string, owner: LockOwner): Promise<void> {
  await mkdir(claimPath, { mode: 0o700 });
  try {
    await chmod(claimPath, 0o700);
    await writeFile(path.join(claimPath, "owner.json"), `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    await retireClaim(claimPath).catch(() => undefined);
    throw error;
  }
}

async function writeOwner(claimPath: string, owner: LockOwner): Promise<void> {
  const temporary = path.join(claimPath, `owner.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path.join(claimPath, "owner.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function activeClaims(
  registryPath: string,
  ownClaimPath: string,
): Promise<InspectedClaim[]> {
  const blockers: InspectedClaim[] = [];
  const entries = await readdir(registryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith(CLAIM_PREFIX)) continue;
    const token = entry.name.slice(CLAIM_PREFIX.length);
    if (!UUID_PATTERN.test(token)) continue;
    const claimPath = path.join(registryPath, entry.name);
    if (claimPath === ownClaimPath) continue;

    let inspected: InspectedClaim;
    try {
      inspected = await inspectClaim(claimPath);
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    if (inspected.owner) {
      if (inspected.owner.token !== token) {
        throw new Error(`Meka daemon claim token does not match its generation: ${claimPath}`);
      }
      if (processAlive(inspected.owner.pid)) {
        blockers.push(inspected);
      } else {
        await retireClaim(claimPath, inspected.owner.token);
      }
      continue;
    }
    if (Date.now() - inspected.modifiedAt < RECENT_INCOMPLETE_LOCK_MS) {
      blockers.push(inspected);
    } else {
      await retireClaim(claimPath);
    }
  }
  return blockers;
}

async function inspectClaim(claimPath: string): Promise<InspectedClaim> {
  const metadata = await lstat(claimPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Meka daemon claim must be a real directory: ${claimPath}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`Meka daemon claim is not owned by the current user: ${claimPath}`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Meka daemon claim is not private: ${claimPath}`);
  }
  let owner: LockOwner | undefined;
  try {
    owner = parseOwner(await readFile(path.join(claimPath, "owner.json"), "utf8"));
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  return { ...(owner ? { owner } : {}), modifiedAt: metadata.mtimeMs };
}

/** Atomically moves a never-reused claim out of the registry before removal. */
async function retireClaim(claimPath: string, expectedToken?: string): Promise<boolean> {
  if (expectedToken) {
    const inspected = await inspectClaim(claimPath).catch((error) => {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (!inspected || inspected.owner?.token !== expectedToken) return false;
  }
  const quarantine = `${claimPath}.retired-${randomUUID()}`;
  try {
    await rename(claimPath, quarantine);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
  if (expectedToken) {
    const quarantined = await inspectClaim(quarantine).catch(() => undefined);
    if (quarantined?.owner?.token !== expectedToken) {
      await rename(quarantine, claimPath).catch(() => undefined);
      return false;
    }
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

async function rejectLegacyLock(registryPath: string): Promise<void> {
  const ownerPath = path.join(registryPath, "owner.json");
  let raw: string;
  try {
    raw = await readFile(ownerPath, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  const owner = parseLegacyOwner(raw);
  if (owner && processAlive(owner.pid)) {
    throw new Error(
      `A Meka daemon already owns this automation state (pid ${owner.pid}, cwd ${owner.cwd})`,
    );
  }
  // The legacy generation reused this stable path, so there is no conditional
  // unlink that can prove it was not replaced between inspection and removal.
  // Failing closed is the only ownership-safe migration behavior.
  throw new Error(
    `A legacy Meka daemon lock exists at ${registryPath}; verify no daemon is running and remove it manually`,
  );
}

function parseOwner(raw: string): LockOwner | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>;
    if (
      value.version === 1 &&
      typeof value.token === "string" &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.cwd === "string" &&
      typeof value.startedAt === "string" &&
      (value.phase === "pending" || value.phase === "owned")
    ) {
      return value as LockOwner;
    }
  } catch {
    // An owner write may still be in progress; its claim remains a blocker.
  }
  return undefined;
}

function parseLegacyOwner(raw: string): LegacyLockOwner | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LegacyLockOwner>;
    if (
      value.version === 1 &&
      typeof value.token === "string" &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.cwd === "string" &&
      typeof value.startedAt === "string"
    ) {
      return value as LegacyLockOwner;
    }
  } catch {
    // Invalid legacy state still cannot be removed safely while an old contender may run.
  }
  return undefined;
}

async function claimExists(claimPath: string): Promise<boolean> {
  try {
    await lstat(claimPath);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
