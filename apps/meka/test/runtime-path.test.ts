import { expect, test } from "vite-plus/test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  MAX_UNIX_SOCKET_PATH_BYTES,
  createRuntimeLocation,
  discoverRuntimeMetadata,
  removeRuntimeLocation,
  writeRuntimeMetadata,
} from "../src/runtime-path.ts";

test("discovers the live private instance containing the current workspace", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-discovery-test-"));
  const runtimeRoot = path.join(temporaryDirectory, "runtime");
  const workspace = path.join(temporaryDirectory, "workspace");
  const workspaceAlias = path.join(temporaryDirectory, "workspace-alias");
  const nested = path.join(workspace, "packages", "demo");
  await mkdir(nested, { recursive: true });
  await symlink(workspace, workspaceAlias);
  const location = await createRuntimeLocation({ runtimeRoot });
  const server = net.createServer();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(location.socketPath, resolve);
    });
    await chmod(location.socketPath, 0o600);
    await writeRuntimeMetadata(location, {
      instanceId: location.instanceId,
      socketPath: location.socketPath,
      pid: process.pid,
      protocolVersion: 1,
      cwd: workspace,
      startedAt: "2026-07-10T00:00:00.000Z",
    });

    await expect(discoverRuntimeMetadata({ runtimeRoot, cwd: nested })).resolves.toEqual({
      instanceId: location.instanceId,
      socketPath: location.socketPath,
      pid: process.pid,
      protocolVersion: 1,
      cwd: workspace,
      startedAt: "2026-07-10T00:00:00.000Z",
    });
    await expect(
      discoverRuntimeMetadata({ runtimeRoot, cwd: path.join(workspaceAlias, "packages", "demo") }),
    ).resolves.toMatchObject({ cwd: workspace });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeRuntimeLocation(location);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("creates a unique private instance and exclusive private metadata", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-runtime-test-"));
  const runtimeRoot = path.join(temporaryDirectory, "runtime");
  const first = await createRuntimeLocation({
    runtimeRoot,
    instanceId: "11111111-1111-4111-8111-111111111111",
  });
  const second = await createRuntimeLocation({
    runtimeRoot,
    instanceId: "22222222-2222-4222-8222-222222222222",
  });

  try {
    expect(first.instanceId).toBe("11111111-1111-4111-8111-111111111111");
    expect(first.instanceDir).not.toBe(second.instanceDir);
    expect(first.socketPath).toBe(path.join(first.instanceDir, "m.sock"));
    expect(Buffer.byteLength(first.socketPath)).toBeLessThanOrEqual(MAX_UNIX_SOCKET_PATH_BYTES);

    const rootMetadata = await lstat(runtimeRoot);
    const instanceMetadata = await lstat(first.instanceDir);
    expect(rootMetadata.mode & 0o777).toBe(0o700);
    expect(instanceMetadata.mode & 0o777).toBe(0o700);

    await writeRuntimeMetadata(first, {
      instanceId: first.instanceId,
      socketPath: first.socketPath,
    });
    expect(JSON.parse(await readFile(first.metadataPath, "utf8"))).toEqual({
      instanceId: first.instanceId,
      socketPath: first.socketPath,
    });
    expect((await lstat(first.metadataPath)).mode & 0o777).toBe(0o600);
    await expect(writeRuntimeMetadata(first, { replaced: true })).rejects.toMatchObject({
      code: "EEXIST",
    });

    await removeRuntimeLocation(first);
    await expect(lstat(first.instanceDir)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await removeRuntimeLocation(first);
    await removeRuntimeLocation(second);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("discovers a runtime that falls back from a long XDG root", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-fallback-test-"));
  const workspace = path.join(temporaryDirectory, "workspace");
  const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  const previousTemporaryDirectory = process.env.TMPDIR;
  const server = net.createServer();
  let location: Awaited<ReturnType<typeof createRuntimeLocation>> | undefined;

  try {
    process.env.TMPDIR = temporaryDirectory;
    process.env.XDG_RUNTIME_DIR = path.join(
      temporaryDirectory,
      "x".repeat(MAX_UNIX_SOCKET_PATH_BYTES),
    );
    await mkdir(workspace);
    const createdLocation = await createRuntimeLocation();
    location = createdLocation;

    const uid = typeof process.getuid === "function" ? process.getuid() : "user";
    expect(createdLocation.runtimeRoot).toBe(path.join(temporaryDirectory, `meka-${uid}`));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(createdLocation.socketPath, resolve);
    });
    await chmod(createdLocation.socketPath, 0o600);
    await writeRuntimeMetadata(createdLocation, {
      instanceId: createdLocation.instanceId,
      socketPath: createdLocation.socketPath,
      pid: process.pid,
      protocolVersion: 1,
      cwd: workspace,
      startedAt: "2026-07-11T00:00:00.000Z",
    });

    await expect(discoverRuntimeMetadata({ cwd: workspace })).resolves.toMatchObject({
      instanceId: createdLocation.instanceId,
      socketPath: createdLocation.socketPath,
      cwd: workspace,
    });
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (location) {
      await removeRuntimeLocation(location);
    }
    if (previousRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory;
    if (previousTemporaryDirectory === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemporaryDirectory;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("rejects a runtime root reached through a symbolic link", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-runtime-test-"));
  const actualRoot = path.join(temporaryDirectory, "actual");
  const linkedRoot = path.join(temporaryDirectory, "linked");
  await mkdir(actualRoot);
  await symlink(actualRoot, linkedRoot);

  try {
    await expect(createRuntimeLocation({ runtimeRoot: linkedRoot })).rejects.toThrow(
      "Meka runtime root must be a real directory",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("rejects an explicitly configured socket path that exceeds the POSIX budget", async () => {
  const runtimeRoot = path.join(os.tmpdir(), "meka", "x".repeat(MAX_UNIX_SOCKET_PATH_BYTES));
  await expect(createRuntimeLocation({ runtimeRoot })).rejects.toThrow(
    "Meka socket path is too long",
  );
});

test("normalizes a relative runtime root to an absolute socket path", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-runtime-test-"));
  const relativeRoot = path.relative(process.cwd(), path.join(temporaryDirectory, "runtime"));
  const location = await createRuntimeLocation({ runtimeRoot: relativeRoot });

  try {
    expect(path.isAbsolute(location.runtimeRoot)).toBe(true);
    expect(path.isAbsolute(location.socketPath)).toBe(true);
  } finally {
    await removeRuntimeLocation(location);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
