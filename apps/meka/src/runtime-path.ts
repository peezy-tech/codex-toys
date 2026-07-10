import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

function defaultRuntimeRoot(): string {
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
