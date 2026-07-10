import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const MAX_UNIX_SOCKET_PATH_BYTES = 100;

export type MekaRuntimeLocation = {
  instanceId: string;
  runtimeRoot: string;
  instanceDir: string;
  socketPath: string;
  metadataPath: string;
};

export type MekaRuntimeMetadata = {
  instanceId: string;
  socketPath: string;
  pid: number;
  protocolVersion: number;
  cwd: string;
  startedAt: string;
};

export async function createRuntimeLocation(
  options: {
    runtimeRoot?: string;
    instanceId?: string;
  } = {},
): Promise<MekaRuntimeLocation> {
  if (process.platform === "win32") {
    throw new Error("Meka private sockets are currently supported on POSIX systems only");
  }
  const instanceId = options.instanceId ?? randomUUID();
  let runtimeRoot = path.resolve(options.runtimeRoot ?? defaultRuntimeRoot());
  let location = paths(runtimeRoot, instanceId);
  if (Buffer.byteLength(location.socketPath) > MAX_UNIX_SOCKET_PATH_BYTES && !options.runtimeRoot) {
    runtimeRoot = fallbackRuntimeRoot();
    location = paths(runtimeRoot, instanceId);
  }
  if (Buffer.byteLength(location.socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(`Meka socket path is too long: ${location.socketPath}`);
  }
  await ensurePrivateRoot(runtimeRoot);
  const instanceDir = await mkdtemp(path.join(runtimeRoot, "i-"));
  await chmod(instanceDir, 0o700);
  return {
    ...location,
    instanceDir,
    socketPath: path.join(instanceDir, "m.sock"),
    metadataPath: path.join(instanceDir, "instance.json"),
  };
}

export async function writeRuntimeMetadata(
  location: MekaRuntimeLocation,
  metadata: Record<string, unknown>,
): Promise<void> {
  await writeFile(location.metadataPath, `${JSON.stringify(metadata)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

export async function removeRuntimeLocation(location: MekaRuntimeLocation): Promise<void> {
  await rm(location.instanceDir, { recursive: true, force: true });
}

/**
 * Finds the live Meka instance whose fixed workspace most specifically contains
 * `cwd`. Discovery reads only private, same-user runtime records created by
 * Meka itself; callers can still provide an explicit socket to avoid discovery.
 */
export async function discoverRuntimeMetadata(
  options: { runtimeRoot?: string; cwd?: string } = {},
): Promise<MekaRuntimeMetadata> {
  const runtimeRoot = path.resolve(options.runtimeRoot ?? defaultRuntimeRoot());
  const requestedCwd = path.resolve(options.cwd ?? process.cwd());
  const cwd = await realpath(requestedCwd).catch(() => requestedCwd);
  let entries;
  try {
    await assertPrivateDirectory(runtimeRoot, "Meka runtime root");
    entries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(`No live Meka instance contains ${cwd}`);
    }
    throw error;
  }

  const matches: MekaRuntimeMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("i-")) {
      continue;
    }
    const instanceDir = path.join(runtimeRoot, entry.name);
    const metadata = await readOwnedRuntimeMetadata(instanceDir);
    if (metadata && containsPath(metadata.cwd, cwd)) {
      matches.push(metadata);
    }
  }
  matches.sort(
    (left, right) =>
      right.cwd.length - left.cwd.length || right.startedAt.localeCompare(left.startedAt),
  );
  const selected = matches[0];
  if (!selected) {
    throw new Error(`No live Meka instance contains ${cwd}`);
  }
  return selected;
}

export function defaultRuntimeRoot(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  return xdg && path.isAbsolute(xdg) ? path.join(xdg, "meka") : fallbackRuntimeRoot();
}

function fallbackRuntimeRoot(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `meka-${uid}`);
}

function paths(runtimeRoot: string, instanceId: string) {
  const placeholder = path.join(runtimeRoot, `i-${instanceId.slice(0, 8)}`);
  return {
    instanceId,
    runtimeRoot,
    instanceDir: placeholder,
    socketPath: path.join(placeholder, "m.sock"),
    metadataPath: path.join(placeholder, "instance.json"),
  };
}

async function ensurePrivateRoot(runtimeRoot: string): Promise<void> {
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const metadata = await lstat(runtimeRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Meka runtime root must be a real directory: ${runtimeRoot}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`Meka runtime root is not owned by the current user: ${runtimeRoot}`);
  }
  await chmod(runtimeRoot, 0o700);
}

async function readOwnedRuntimeMetadata(
  instanceDir: string,
): Promise<MekaRuntimeMetadata | undefined> {
  try {
    await assertPrivateDirectory(instanceDir, "Meka instance directory");
    const metadataPath = path.join(instanceDir, "instance.json");
    const metadataFile = await lstat(metadataPath);
    if (
      !metadataFile.isFile() ||
      metadataFile.isSymbolicLink() ||
      metadataFile.size > 64 * 1024 ||
      !ownedByCurrentUser(metadataFile.uid) ||
      (metadataFile.mode & 0o077) !== 0
    ) {
      return undefined;
    }
    const value = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.instanceId !== "string" ||
      typeof record.socketPath !== "string" ||
      !path.isAbsolute(record.socketPath) ||
      path.dirname(record.socketPath) !== instanceDir ||
      typeof record.pid !== "number" ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.protocolVersion !== "number" ||
      typeof record.cwd !== "string" ||
      !path.isAbsolute(record.cwd) ||
      typeof record.startedAt !== "string"
    ) {
      return undefined;
    }
    if (!processAlive(record.pid)) {
      return undefined;
    }
    const socket = await lstat(record.socketPath);
    if (
      !socket.isSocket() ||
      socket.isSymbolicLink() ||
      !ownedByCurrentUser(socket.uid) ||
      (socket.mode & 0o077) !== 0
    ) {
      return undefined;
    }
    return {
      instanceId: record.instanceId,
      socketPath: record.socketPath,
      pid: record.pid,
      protocolVersion: record.protocolVersion,
      cwd: path.resolve(record.cwd),
      startedAt: record.startedAt,
    };
  } catch {
    return undefined;
  }
}

async function assertPrivateDirectory(directory: string, label: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
  if (!ownedByCurrentUser(metadata.uid)) {
    throw new Error(`${label} is not owned by the current user: ${directory}`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} is not private: ${directory}`);
  }
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
