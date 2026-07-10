import { expect, test } from "vite-plus/test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_UNIX_SOCKET_PATH_BYTES,
  createRuntimeLocation,
  removeRuntimeLocation,
  writeRuntimeMetadata,
} from "../src/runtime-path.ts";

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
