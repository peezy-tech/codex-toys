import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ShimReceipt = {
  version: 1;
  token: string;
  path: string;
  contentHash: string;
  target: string;
  updatedAt: string;
};

type RegularFile = {
  contents: string;
  mode: number;
};

type LauncherDescriptor = {
  target: string;
  contents: string;
  packageBin?: string;
};

type ShimLocations = {
  shimPath: string;
  receiptPath: string;
};

type ShimLock = {
  path: string;
  token: string;
};

type ShimLockRecord = {
  version: 1;
  token: string;
  pid: number;
  createdAt: string;
};

class ManagedPathConflict extends Error {}

const SHIM_LOCK_TIMEOUT_MS = 15_000;
const SHIM_LOCK_STALE_MS = 60_000;
const SHIM_CLAIM_PREFIX = "claim-";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type CliShimStatus = {
  state: "installed" | "external" | "not-installed" | "drifted" | "conflict";
  path: string;
  target: string;
  onPath: boolean;
  message?: string;
};

export type CliShimOptions = {
  home?: string;
  stateHome?: string;
};

/** Installs an ownership-recorded user launcher during explicit Meka setup. */
export async function installCliShim(options: CliShimOptions = {}): Promise<CliShimStatus> {
  const descriptor = launcherDescriptor();
  const locations = shimLocations(options);
  await mkdir(path.dirname(locations.shimPath), { recursive: true, mode: 0o755 });
  await ensurePrivateDirectory(path.dirname(locations.receiptPath));
  return await withShimMutationLock(locations.receiptPath, async () =>
    installCliShimUnlocked(descriptor, locations),
  );
}

async function installCliShimUnlocked(
  descriptor: LauncherDescriptor,
  locations: ShimLocations,
): Promise<CliShimStatus> {
  const receipt = await readReceipt(locations.receiptPath);
  const inspected = await readShimFile(locations.shimPath, descriptor);
  if (inspected.external) {
    return receipt
      ? status(
          "conflict",
          descriptor,
          locations,
          "A package-manager launcher replaced a path that still has a Meka ownership receipt",
        )
      : status(
          "external",
          descriptor,
          locations,
          "The current Meka package already provides this launcher; it remains package-manager owned",
        );
  }
  if (inspected.conflict) {
    return status("conflict", descriptor, locations, inspected.conflict);
  }
  const existing = inspected.file;
  if (receipt && receipt.path !== locations.shimPath) {
    return status(
      "conflict",
      descriptor,
      locations,
      `The Meka receipt belongs to another shim path: ${receipt.path}`,
    );
  }
  if (existing !== undefined) {
    const existingHash = sha256(existing.contents);
    if (!receipt) {
      return status(
        "conflict",
        descriptor,
        locations,
        "An unowned file already exists at the shim path",
      );
    }
    if (receipt.contentHash !== existingHash) {
      return status(
        "drifted",
        descriptor,
        locations,
        "The Meka-owned shim was modified; it was not overwritten",
      );
    }
    if (existing.contents === descriptor.contents) {
      if (receipt.target !== descriptor.target) {
        return status(
          "drifted",
          descriptor,
          locations,
          "The Meka receipt does not match the installed shim target",
        );
      }
      if (!hasLauncherMode(existing.mode)) {
        await chmod(locations.shimPath, 0o755);
      }
      return status("installed", descriptor, locations);
    }
  }

  const temporary = `${locations.shimPath}.${randomUUID()}.tmp`;
  let backup: string | undefined;
  let preserveBackup = false;
  try {
    await writeFile(temporary, descriptor.contents, {
      encoding: "utf8",
      mode: 0o755,
      flag: "wx",
    });
    await chmod(temporary, 0o755);

    if (existing) {
      const candidate = `${locations.shimPath}.${randomUUID()}.rollback`;
      await link(locations.shimPath, candidate);
      backup = candidate;
      const preserved = await readRegularFile(backup);
      if (!preserved || sha256(preserved.contents) !== receipt?.contentHash) {
        await rm(backup, { force: true });
        backup = undefined;
        return status(
          "drifted",
          descriptor,
          locations,
          "The owned shim changed while its replacement was being prepared",
        );
      }
      await rename(temporary, locations.shimPath);
    } else {
      await link(temporary, locations.shimPath);
    }

    const next: ShimReceipt = {
      version: 1,
      token: receipt?.token ?? randomUUID(),
      path: locations.shimPath,
      contentHash: sha256(descriptor.contents),
      target: descriptor.target,
      updatedAt: new Date().toISOString(),
    };
    try {
      await writeReceipt(locations.receiptPath, next);
    } catch (error) {
      try {
        await rollbackShimReplacement(locations.shimPath, next.contentHash, backup);
        backup = undefined;
      } catch (rollbackError) {
        preserveBackup = true;
        throw new AggregateError(
          [error, rollbackError],
          `Unable to commit the Meka CLI receipt or restore its previous shim${
            backup ? `; recovery copy: ${backup}` : ""
          }`,
        );
      }
      throw error;
    }
    if (backup) {
      await rm(backup, { force: true });
      backup = undefined;
    }
    return status("installed", descriptor, locations);
  } catch (error) {
    if (backup && !preserveBackup) {
      await rm(backup, { force: true });
      backup = undefined;
    }
    if (hasCode(error, "EEXIST")) {
      return status("conflict", descriptor, locations, "Another process created the shim path");
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function statusCliShim(options: CliShimOptions = {}): Promise<CliShimStatus> {
  const descriptor = launcherDescriptor();
  const locations = shimLocations(options);
  const [receipt, inspected] = await Promise.all([
    readReceipt(locations.receiptPath),
    readShimFile(locations.shimPath, descriptor),
  ]);
  if (inspected.external) {
    return receipt
      ? status(
          "conflict",
          descriptor,
          locations,
          "A package-manager launcher replaced a path that still has a Meka ownership receipt",
        )
      : status(
          "external",
          descriptor,
          locations,
          "The current Meka package provides this launcher",
        );
  }
  if (inspected.conflict) {
    return status("conflict", descriptor, locations, inspected.conflict);
  }
  const existing = inspected.file;
  if (receipt && receipt.path !== locations.shimPath) {
    return status(
      "conflict",
      descriptor,
      locations,
      `The Meka receipt belongs to another shim path: ${receipt.path}`,
    );
  }
  if (existing === undefined) return status("not-installed", descriptor, locations);
  if (!receipt) {
    return status("conflict", descriptor, locations, "The shim path exists but is not Meka-owned");
  }
  if (receipt.contentHash !== sha256(existing.contents)) {
    return status("drifted", descriptor, locations, "The Meka-owned shim was modified");
  }
  if (existing.contents !== descriptor.contents || receipt.target !== descriptor.target) {
    return status("drifted", descriptor, locations, "The Meka-owned shim targets another install");
  }
  if (!hasLauncherMode(existing.mode)) {
    return status(
      "drifted",
      descriptor,
      locations,
      "The Meka-owned shim is not executable with mode 0755",
    );
  }
  return status("installed", descriptor, locations);
}

export async function uninstallCliShim(options: CliShimOptions = {}): Promise<CliShimStatus> {
  const descriptor = launcherDescriptor();
  const locations = shimLocations(options);
  await ensurePrivateDirectory(path.dirname(locations.receiptPath));
  return await withShimMutationLock(locations.receiptPath, async () =>
    uninstallCliShimUnlocked(descriptor, locations),
  );
}

async function uninstallCliShimUnlocked(
  descriptor: LauncherDescriptor,
  locations: ShimLocations,
): Promise<CliShimStatus> {
  const receipt = await readReceipt(locations.receiptPath);
  const inspected = await readShimFile(locations.shimPath, descriptor);
  if (inspected.external) {
    return receipt
      ? status(
          "conflict",
          descriptor,
          locations,
          "A package-manager launcher replaced a path that still has a Meka ownership receipt",
        )
      : status(
          "external",
          descriptor,
          locations,
          "The package-manager launcher was left in place",
        );
  }
  if (inspected.conflict) {
    return status("conflict", descriptor, locations, inspected.conflict);
  }
  const existing = inspected.file;
  if (!receipt) {
    return status(
      existing === undefined ? "not-installed" : "conflict",
      descriptor,
      locations,
      existing === undefined ? undefined : "The shim path exists but is not Meka-owned",
    );
  }
  if (receipt.path !== locations.shimPath) {
    return status(
      "conflict",
      descriptor,
      locations,
      `The Meka receipt belongs to another shim path: ${receipt.path}`,
    );
  }
  if (existing !== undefined && receipt.contentHash !== sha256(existing.contents)) {
    return status("drifted", descriptor, locations, "The modified shim was left in place");
  }
  await rm(locations.shimPath, { force: true });
  await rm(locations.receiptPath, { force: true });
  return status("not-installed", descriptor, locations);
}

function launcherDescriptor(): LauncherDescriptor {
  const modulePath = fileURLToPath(import.meta.url);
  const source = path.extname(modulePath) === ".ts";
  const target = fileURLToPath(new URL(source ? "./main.ts" : "./main.js", import.meta.url));
  const args = source
    ? ["--import", import.meta.resolve("tsx"), target]
    : [target];
  const tsconfig = source
    ? fileURLToPath(new URL("../../../tsconfig.base.json", import.meta.url))
    : undefined;
  const environment = tsconfig ? `TSX_TSCONFIG_PATH=${shellQuote(tsconfig)} ` : "";
  const command = ["node", ...args].map(shellQuote).join(" ");
  const contents = `#!/bin/sh\n${environment}exec ${command} "$@"\n`;
  return {
    target,
    contents,
    ...(source
      ? {}
      : { packageBin: fileURLToPath(new URL("../bin/meka.js", import.meta.url)) }),
  };
}

function shimLocations(options: CliShimOptions): ShimLocations {
  const home = path.resolve(options.home ?? os.homedir());
  if (options.stateHome && !path.isAbsolute(options.stateHome)) {
    throw new Error("stateHome must be an absolute path");
  }
  const stateHome =
    options.stateHome && path.isAbsolute(options.stateHome)
      ? options.stateHome
      : process.env.XDG_STATE_HOME && path.isAbsolute(process.env.XDG_STATE_HOME)
      ? process.env.XDG_STATE_HOME
      : path.join(home, ".local", "state");
  return {
    shimPath: path.join(home, ".local", "bin", "meka"),
    receiptPath: path.join(stateHome, "meka", "cli-shim.json"),
  };
}

async function readReceipt(receiptPath: string): Promise<ShimReceipt | undefined> {
  const raw = await readRegularFile(receiptPath, true);
  if (raw === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw.contents) as unknown;
  } catch {
    throw new Error(`Invalid Meka CLI shim receipt: ${receiptPath}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Meka CLI shim receipt: ${receiptPath}`);
  }
  const receipt = value as Partial<ShimReceipt>;
  if (
    receipt.version !== 1 ||
    typeof receipt.token !== "string" ||
    typeof receipt.path !== "string" ||
    typeof receipt.contentHash !== "string" ||
    typeof receipt.target !== "string" ||
    typeof receipt.updatedAt !== "string"
  ) {
    throw new Error(`Invalid Meka CLI shim receipt: ${receiptPath}`);
  }
  return receipt as ShimReceipt;
}

async function writeReceipt(receiptPath: string, receipt: ShimReceipt): Promise<void> {
  const temporary = `${receiptPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(receipt)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await rename(temporary, receiptPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readRegularFile(
  filePath: string,
  requirePrivate = false,
): Promise<RegularFile | undefined> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new ManagedPathConflict(`Meka-managed path must be a regular file: ${filePath}`);
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new ManagedPathConflict(
        `Meka-managed path is not owned by the current user: ${filePath}`,
      );
    }
    if (requirePrivate && (metadata.mode & 0o077) !== 0) {
      throw new Error(`Meka-managed receipt is not private: ${filePath}`);
    }
    return {
      contents: await handle.readFile("utf8"),
      mode: metadata.mode & 0o777,
    };
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    if (hasCode(error, "ELOOP")) {
      throw new ManagedPathConflict(`Meka-managed path must be a regular file: ${filePath}`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readShimFile(
  filePath: string,
  descriptor?: LauncherDescriptor,
): Promise<{ file?: RegularFile; external?: boolean; conflict?: string }> {
  try {
    const file = await readRegularFile(filePath);
    return file ? { file } : {};
  } catch (error) {
    if (error instanceof ManagedPathConflict) {
      if (
        descriptor?.packageBin &&
        (await isCurrentPackageManagerLauncher(filePath, descriptor.packageBin))
      ) {
        return { external: true };
      }
      return { conflict: error.message };
    }
    throw error;
  }
}

async function isCurrentPackageManagerLauncher(
  shimPath: string,
  packageBin: string,
): Promise<boolean> {
  try {
    const shim = await lstat(shimPath);
    if (!shim.isSymbolicLink()) return false;
    const [resolvedShim, resolvedBin] = await Promise.all([
      realpath(shimPath),
      realpath(packageBin),
    ]);
    if (resolvedShim !== resolvedBin) return false;
    const target = await lstat(resolvedBin);
    return (
      target.isFile() &&
      !target.isSymbolicLink() &&
      (typeof process.getuid !== "function" || target.uid === process.getuid()) &&
      (target.mode & 0o111) !== 0
    );
  } catch {
    return false;
  }
}

async function rollbackShimReplacement(
  shimPath: string,
  installedHash: string,
  backup: string | undefined,
): Promise<void> {
  const inspected = await readShimFile(shimPath);
  if (inspected.conflict || !inspected.file || sha256(inspected.file.contents) !== installedHash) {
    throw new Error(
      inspected.conflict ?? `The newly installed shim changed before rollback: ${shimPath}`,
    );
  }
  if (backup) {
    await rename(backup, shimPath);
    return;
  }
  await rm(shimPath, { force: true });
}

async function withShimMutationLock<A>(
  receiptPath: string,
  use: () => Promise<A>,
): Promise<A> {
  const lock = await acquireShimLock(`${receiptPath}.lock`);
  try {
    return await use();
  } finally {
    await releaseShimLock(lock);
  }
}

async function acquireShimLock(lockPath: string): Promise<ShimLock> {
  const deadline = Date.now() + SHIM_LOCK_TIMEOUT_MS;
  await ensurePrivateDirectory(lockPath);
  await rejectLegacyShimLock(lockPath);

  for (;;) {
    const token = randomUUID();
    const claimPath = path.join(lockPath, `${SHIM_CLAIM_PREFIX}${token}`);
    try {
      await mkdir(claimPath, { mode: 0o700 });
      await chmod(claimPath, 0o700);
      await writeFile(
        path.join(claimPath, "owner.json"),
        `${JSON.stringify({
          version: 1,
          token,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        } satisfies ShimLockRecord)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      await retireShimClaim(claimPath).catch(() => undefined);
      throw error;
    }

    if (!(await hasActiveShimBlocker(lockPath, claimPath))) {
      return { path: claimPath, token };
    }
    await retireShimClaim(claimPath, token);
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the Meka CLI shim lock: ${lockPath}`);
    }
    await delay(5 + Math.floor(Math.random() * 21));
  }
}

async function releaseShimLock(lock: ShimLock): Promise<void> {
  await retireShimClaim(lock.path, lock.token);
}

async function hasActiveShimBlocker(
  registryPath: string,
  ownClaimPath: string,
): Promise<boolean> {
  for (const entry of await readdir(registryPath, { withFileTypes: true })) {
    if (!entry.name.startsWith(SHIM_CLAIM_PREFIX)) continue;
    const token = entry.name.slice(SHIM_CLAIM_PREFIX.length);
    if (!UUID_PATTERN.test(token)) continue;
    const claimPath = path.join(registryPath, entry.name);
    if (claimPath === ownClaimPath) continue;

    const inspected = await inspectShimClaim(claimPath).catch((error) => {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (!inspected) continue;
    if (inspected.owner) {
      if (inspected.owner.token !== token) {
        throw new Error(`Meka CLI shim claim token does not match its generation: ${claimPath}`);
      }
      if (processIsAlive(inspected.owner.pid)) return true;
      await retireShimClaim(claimPath, inspected.owner.token);
      continue;
    }
    if (Date.now() - inspected.modifiedAt < SHIM_LOCK_STALE_MS) return true;
    await retireShimClaim(claimPath);
  }
  return false;
}

async function rejectLegacyShimLock(registryPath: string): Promise<void> {
  try {
    await lstat(path.join(registryPath, "owner.json"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  // Old lock generations reused the registry path, so removing one after a
  // read could delete a replacement. Preserve it for explicit recovery.
  throw new Error(
    `A legacy Meka CLI shim lock exists at ${registryPath}; verify no setup is running and remove it manually`,
  );
}

async function inspectShimClaim(
  claimPath: string,
): Promise<{ owner?: ShimLockRecord; modifiedAt: number }> {
  const metadata = await lstat(claimPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Meka CLI shim claim must be a real directory: ${claimPath}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`Meka CLI shim claim is not owned by the current user: ${claimPath}`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Meka CLI shim claim is not private: ${claimPath}`);
  }
  const ownerPath = path.join(claimPath, "owner.json");
  let raw: string;
  try {
    raw = await readFile(ownerPath, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { modifiedAt: metadata.mtimeMs };
    throw error;
  }
  try {
    const value = JSON.parse(raw) as Partial<ShimLockRecord>;
    if (
      value.version === 1 &&
      typeof value.token === "string" &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.createdAt === "string"
    ) {
      return { owner: value as ShimLockRecord, modifiedAt: metadata.mtimeMs };
    }
  } catch {
    // The lock creator may be between mkdir and its private owner write.
  }
  return { modifiedAt: metadata.mtimeMs };
}

/** Moves a never-reused claim aside atomically before deleting it. */
async function retireShimClaim(claimPath: string, expectedToken?: string): Promise<boolean> {
  if (expectedToken) {
    const inspected = await inspectShimClaim(claimPath).catch((error) => {
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
    const quarantined = await inspectShimClaim(quarantine).catch(() => undefined);
    if (quarantined?.owner?.token !== expectedToken) {
      await rename(quarantine, claimPath).catch(() => undefined);
      return false;
    }
  }
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function hasLauncherMode(mode: number): boolean {
  return mode === 0o755;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Meka state path must be a real directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`Meka state path is not owned by the current user: ${directory}`);
  }
  await chmod(directory, 0o700);
}

function status(
  state: CliShimStatus["state"],
  descriptor: { target: string },
  locations: { shimPath: string },
  message?: string,
): CliShimStatus {
  return {
    state,
    path: locations.shimPath,
    target: descriptor.target,
    onPath: (process.env.PATH ?? "")
      .split(path.delimiter)
      .some((entry) => path.resolve(entry) === path.dirname(locations.shimPath)),
    ...(message ? { message } : {}),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
