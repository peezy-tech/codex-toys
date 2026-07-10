import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Context, Effect, Layer } from "effect";
import {
  IntegrationFailure,
  type IntegrationCommand,
  type IntegrationCommandResult,
  type IntegrationLock,
  type IntegrationLockOptions,
} from "./types.ts";
import { killProcessTree, USES_PROCESS_GROUPS } from "../process-tree.ts";

export type IntegrationPlatformService = {
  run(command: IntegrationCommand): Effect.Effect<IntegrationCommandResult, IntegrationFailure>;
  readText(filePath: string): Effect.Effect<string | undefined, IntegrationFailure>;
  writeTextAtomic(filePath: string, contents: string): Effect.Effect<void, IntegrationFailure>;
  removeFile(filePath: string): Effect.Effect<void, IntegrationFailure>;
  canonicalPath(filePath: string): Effect.Effect<string, IntegrationFailure>;
  acquireLock(
    lockPath: string,
    options: IntegrationLockOptions,
  ): Effect.Effect<IntegrationLock, IntegrationFailure>;
  releaseLock(lock: IntegrationLock): Effect.Effect<void, IntegrationFailure>;
  now(): string;
};

export class IntegrationPlatform extends Context.Tag("@meka/app/IntegrationPlatform")<
  IntegrationPlatform,
  IntegrationPlatformService
>() {}

export function makeNodeIntegrationPlatform(): IntegrationPlatformService {
  return {
    run: (command) =>
      Effect.tryPromise({
        try: () => runCommand(command),
        catch: (cause) =>
          new IntegrationFailure(
            "command",
            `Unable to execute ${command.executable}: ${errorMessage(cause)}`,
            undefined,
            { cause },
          ),
      }),
    readText: (filePath) =>
      Effect.tryPromise({
        try: async () => {
          try {
            return await readFile(filePath, "utf8");
          } catch (error) {
            if (isNodeError(error, "ENOENT")) {
              return undefined;
            }
            throw error;
          }
        },
        catch: (cause) =>
          new IntegrationFailure(
            "filesystem",
            `Unable to read ${filePath}: ${errorMessage(cause)}`,
            undefined,
            { cause },
          ),
      }),
    writeTextAtomic: (filePath, contents) =>
      Effect.tryPromise({
        try: async () => {
          const directory = path.dirname(filePath);
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await chmod(directory, 0o700);
          const temporaryPath = path.join(
            directory,
            `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
          );
          try {
            await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
            await chmod(temporaryPath, 0o600);
            await rename(temporaryPath, filePath);
          } finally {
            await rm(temporaryPath, { force: true });
          }
          await chmod(filePath, 0o600);
        },
        catch: (cause) =>
          new IntegrationFailure(
            "filesystem",
            `Unable to write ${filePath}: ${errorMessage(cause)}`,
            undefined,
            { cause },
          ),
      }),
    removeFile: (filePath) =>
      Effect.tryPromise({
        try: () => rm(filePath, { force: true }),
        catch: (cause) =>
          new IntegrationFailure(
            "filesystem",
            `Unable to remove ${filePath}: ${errorMessage(cause)}`,
            undefined,
            { cause },
          ),
      }),
    canonicalPath: (filePath) =>
      Effect.tryPromise({
        try: () => realpath(path.resolve(filePath)),
        catch: (cause) =>
          new IntegrationFailure(
            "filesystem",
            `Unable to resolve ${filePath}: ${errorMessage(cause)}`,
            undefined,
            { cause },
          ),
      }),
    acquireLock: (lockPath, options) =>
      Effect.tryPromise({
        try: () => acquireFileLock(lockPath, options),
        catch: (cause) =>
          cause instanceof IntegrationFailure
            ? cause
            : new IntegrationFailure(
                "filesystem",
                `Unable to acquire integration lock ${lockPath}: ${errorMessage(cause)}`,
                undefined,
                { cause },
              ),
      }),
    releaseLock: (lock) =>
      Effect.tryPromise({
        try: () => releaseFileLock(lock),
        catch: (cause) =>
          new IntegrationFailure(
            "filesystem",
            `Unable to release integration lock ${lock.path}: ${errorMessage(cause)}`,
            undefined,
            { cause },
          ),
      }),
    now: () => new Date().toISOString(),
  };
}

export const NodeIntegrationPlatformLive = Layer.succeed(
  IntegrationPlatform,
  makeNodeIntegrationPlatform(),
);

async function runCommand(command: IntegrationCommand): Promise<IntegrationCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      env: command.env ? { ...process.env, ...command.env } : process.env,
      detached: USES_PROCESS_GROUPS,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = boundedCollector(command.maxOutputBytes);
    const stderr = boundedCollector(command.maxOutputBytes);
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, command.timeoutMs);
    timeout.unref();

    child.stdout.on("data", stdout.append);
    child.stderr.on("data", stderr.append);
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      killProcessTree(child);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      // A CLI process can exit while leaving helpers behind. Integration
      // inspection and mutation commands never transfer descendant ownership.
      killProcessTree(child);
      resolve({
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
        timedOut,
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(command.input);
  });
}

type FileLockRecord = {
  version: 1;
  token: string;
  pid: number;
  createdAt: string;
};

const FILE_LOCK_CLAIM_PREFIX = "claim-";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function acquireFileLock(
  lockPath: string,
  options: IntegrationLockOptions,
): Promise<IntegrationLock> {
  const deadline = Date.now() + options.timeoutMs;
  await ensurePrivateDirectory(lockPath);

  for (;;) {
    const token = randomUUID();
    const claimPath = path.join(lockPath, `${FILE_LOCK_CLAIM_PREFIX}${token}`);
    try {
      await mkdir(claimPath, { mode: 0o700 });
      await chmod(claimPath, 0o700);
      const record: FileLockRecord = {
        version: 1,
        token,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      };
      await writeFile(path.join(claimPath, "owner.json"), `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (cause) {
      await retireFileLockClaim(claimPath).catch(() => undefined);
      throw cause;
    }

    if (!(await hasActiveFileLockClaim(lockPath, claimPath, options.staleMs))) {
      return { path: lockPath, token };
    }
    await retireFileLockClaim(claimPath, token);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new IntegrationFailure(
        "lock-timeout",
        `Timed out after ${String(options.timeoutMs)}ms waiting for integration lock ${lockPath}`,
      );
    }
    await delay(Math.max(1, Math.min(remaining, 5 + Math.floor(Math.random() * 21))));
  }
}

async function releaseFileLock(lock: IntegrationLock): Promise<void> {
  if (!UUID_PATTERN.test(lock.token)) return;
  await retireFileLockClaim(
    path.join(lock.path, `${FILE_LOCK_CLAIM_PREFIX}${lock.token}`),
    lock.token,
  );
}

async function hasActiveFileLockClaim(
  registryPath: string,
  ownClaimPath: string,
  staleMs: number,
): Promise<boolean> {
  for (const entry of await readdir(registryPath, { withFileTypes: true })) {
    if (!entry.name.startsWith(FILE_LOCK_CLAIM_PREFIX)) continue;
    const token = entry.name.slice(FILE_LOCK_CLAIM_PREFIX.length);
    if (!UUID_PATTERN.test(token)) continue;
    const claimPath = path.join(registryPath, entry.name);
    if (claimPath === ownClaimPath) continue;

    const inspected = await inspectFileLockClaim(claimPath).catch((cause) => {
      if (isNodeError(cause, "ENOENT")) return undefined;
      throw cause;
    });
    if (!inspected) continue;
    if (inspected.record) {
      if (inspected.record.token !== token) {
        throw new Error(`Integration lock claim token does not match its generation: ${claimPath}`);
      }
      if (processIsAlive(inspected.record.pid)) return true;
      await retireFileLockClaim(claimPath, inspected.record.token);
      continue;
    }
    if (Date.now() - inspected.modifiedAt < staleMs) return true;
    await retireFileLockClaim(claimPath);
  }
  return false;
}

async function inspectFileLockClaim(
  claimPath: string,
): Promise<{ record?: FileLockRecord; modifiedAt: number }> {
  const metadata = await lstat(claimPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Integration lock claim must be a real directory: ${claimPath}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`Integration lock claim must be owned by the current user: ${claimPath}`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Integration lock claim must be private: ${claimPath}`);
  }
  let text: string;
  try {
    text = await readFile(path.join(claimPath, "owner.json"), "utf8");
  } catch (cause) {
    if (isNodeError(cause, "ENOENT")) {
      return { modifiedAt: metadata.mtimeMs };
    }
    throw cause;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "version" in value &&
      value.version === 1 &&
      "token" in value &&
      typeof value.token === "string" &&
      "pid" in value &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      "createdAt" in value &&
      typeof value.createdAt === "string"
    ) {
      return { record: value as FileLockRecord, modifiedAt: metadata.mtimeMs };
    }
  } catch {
    // A creator can be between exclusive creation and its fsynced owner record.
  }
  return { modifiedAt: metadata.mtimeMs };
}

/** Atomically retires a never-reused claim before removing its private tree. */
async function retireFileLockClaim(
  claimPath: string,
  expectedToken?: string,
): Promise<boolean> {
  if (expectedToken) {
    const inspected = await inspectFileLockClaim(claimPath).catch((cause) => {
      if (isNodeError(cause, "ENOENT")) return undefined;
      throw cause;
    });
    if (!inspected || inspected.record?.token !== expectedToken) return false;
  }
  const quarantine = `${claimPath}.retired-${randomUUID()}`;
  try {
    await rename(claimPath, quarantine);
  } catch (cause) {
    if (isNodeError(cause, "ENOENT")) return false;
    throw cause;
  }
  if (expectedToken) {
    const quarantined = await inspectFileLockClaim(quarantine).catch(() => undefined);
    if (quarantined?.record?.token !== expectedToken) {
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
  } catch (cause) {
    return !isNodeError(cause, "ESRCH");
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${directory} must be a real directory`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`${directory} must be owned by the current user`);
  }
  await chmod(directory, 0o700);
}

function boundedCollector(limit: number) {
  const chunks: Buffer[] = [];
  let captured = 0;
  let total = 0;
  return {
    append(chunk: Buffer | string) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += value.length;
      const remaining = Math.max(0, limit - captured);
      if (remaining > 0) {
        const kept = value.subarray(0, remaining);
        chunks.push(kept);
        captured += kept.length;
      }
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => total > captured,
  };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
