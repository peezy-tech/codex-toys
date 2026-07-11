import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { makeNodeIntegrationPlatform } from "../src/integrations/platform.ts";

test("runs exact argv without a shell and bounds subprocess output", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-command-test-"));
  const marker = path.join(temporaryDirectory, "must-not-exist");
  const platform = makeNodeIntegrationPlatform();

  try {
    const literal = `$(touch ${marker})`;
    const exact = await Effect.runPromise(
      platform.run({
        executable: process.execPath,
        args: ["-e", "process.stdout.write(process.argv[1])", literal],
        timeoutMs: 1_000,
        maxOutputBytes: 1024,
      }),
    );
    expect(exact.stdout).toBe(literal);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const bounded = await Effect.runPromise(
      platform.run({
        executable: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(1000))"],
        timeoutMs: 1_000,
        maxOutputBytes: 32,
      }),
    );
    expect(Buffer.byteLength(bounded.stdout)).toBe(32);
    expect(bounded.stdoutTruncated).toBe(true);

    const timedOut = await Effect.runPromise(
      platform.run({
        executable: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        timeoutMs: 25,
        maxOutputBytes: 32,
      }),
    );
    expect(timedOut.timedOut).toBe(true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("fingerprints the complete integration asset tree deterministically", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-assets-test-"));
  const nested = path.join(temporaryDirectory, "plugins", "meka");
  const platform = makeNodeIntegrationPlatform();
  try {
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(temporaryDirectory, "marketplace.json"), "marketplace-v1");
    await writeFile(path.join(nested, "hook.mjs"), "hook-v1", { mode: 0o755 });
    const first = await Effect.runPromise(platform.fingerprintTree(temporaryDirectory));
    const repeated = await Effect.runPromise(platform.fingerprintTree(temporaryDirectory));
    expect(repeated).toBe(first);

    await writeFile(path.join(nested, "hook.mjs"), "hook-v2", { mode: 0o755 });
    const changed = await Effect.runPromise(platform.fingerprintTree(temporaryDirectory));
    expect(changed).not.toBe(first);
    expect(changed).toMatch(/^sha256:[0-9a-f]{64}$/u);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("confines cache probes and rejects symlinked ancestors", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-cache-path-test-"));
  const configRoot = path.join(temporaryDirectory, "config");
  const cacheParent = path.join(
    configRoot,
    "plugins",
    "cache",
    "meka-local",
    "meka",
  );
  const target = path.join(cacheParent, "0.2.0");
  const platform = makeNodeIntegrationPlatform();
  try {
    await mkdir(target, { recursive: true });
    expect(
      await Effect.runPromise(
        platform.pathExistsInOwnedDirectory(target, configRoot, cacheParent),
      ),
    ).toBe(true);
    expect(
      await Effect.runPromise(
        platform.pathExistsInOwnedDirectory(
          path.join(cacheParent, "0.3.0"),
          configRoot,
          cacheParent,
        ),
      ),
    ).toBe(false);

    const forged = await Effect.runPromise(
      Effect.either(
        platform.pathExistsInOwnedDirectory(
          path.join(temporaryDirectory, "outside", "0.2.0"),
          configRoot,
          cacheParent,
        ),
      ),
    );
    expect(forged).toMatchObject({ _tag: "Left", left: { reason: "filesystem" } });

    await rm(target, { recursive: true, force: true });
    const linkedCache = path.join(temporaryDirectory, "linked-cache");
    await mkdir(linkedCache);
    await symlink(linkedCache, target, "dir");
    const symlinkedTarget = await Effect.runPromise(
      Effect.either(platform.pathExistsInOwnedDirectory(target, configRoot, cacheParent)),
    );
    expect(symlinkedTarget).toMatchObject({
      _tag: "Left",
      left: { reason: "filesystem" },
    });

    await rm(path.join(configRoot, "plugins"), { recursive: true, force: true });
    const outsidePlugins = path.join(temporaryDirectory, "outside-plugins");
    const linkedTarget = path.join(
      outsidePlugins,
      "cache",
      "meka-local",
      "meka",
      "0.2.0",
    );
    await mkdir(linkedTarget, { recursive: true });
    await symlink(outsidePlugins, path.join(configRoot, "plugins"), "dir");

    const symlinked = await Effect.runPromise(
      Effect.either(platform.pathExistsInOwnedDirectory(target, configRoot, cacheParent)),
    );
    expect(symlinked).toMatchObject({ _tag: "Left", left: { reason: "filesystem" } });
    await expect(lstat(linkedTarget)).resolves.toMatchObject({});
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("cleans integration subprocess trees on timeout and normal completion", async () => {
  if (process.platform === "win32") return;
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-platform-tree-test-"));
  const platform = makeNodeIntegrationPlatform();
  const normalPidPath = path.join(temporaryDirectory, "normal.pid");
  const timeoutPidPath = path.join(temporaryDirectory, "timeout.pid");
  const pids: number[] = [];
  try {
    const script = (keepParentAlive: boolean) =>
      `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref(); writeFileSync(process.argv[1], String(child.pid)); ${keepParentAlive ? "setInterval(() => {}, 1000);" : ""}`;
    const normal = await Effect.runPromise(
      platform.run({
        executable: process.execPath,
        args: ["-e", script(false), normalPidPath],
        timeoutMs: 2_000,
        maxOutputBytes: 1024,
      }),
    );
    expect(normal).toMatchObject({ exitCode: 0, timedOut: false });
    pids.push(Number(await readFile(normalPidPath, "utf8")));

    const timedOut = await Effect.runPromise(
      platform.run({
        executable: process.execPath,
        args: ["-e", script(true), timeoutPidPath],
        timeoutMs: 500,
        maxOutputBytes: 1024,
      }),
    );
    expect(timedOut.timedOut).toBe(true);
    pids.push(Number(await readFile(timeoutPidPath, "utf8")));

    for (const pid of pids) await waitForProcessExit(pid);
  } finally {
    for (const pid of pids) if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("uses a private bounded process lock and releases only its own token", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-lock-test-"));
  const stateDirectory = path.join(temporaryDirectory, "state");
  const lockPath = path.join(stateDirectory, "integrations.json.lock");
  const firstPlatform = makeNodeIntegrationPlatform();
  const secondPlatform = makeNodeIntegrationPlatform();

  try {
    const lock = await Effect.runPromise(
      firstPlatform.acquireLock(lockPath, { timeoutMs: 100, staleMs: 1_000 }),
    );
    const claimPath = path.join(lockPath, `claim-${lock.token}`);
    expect((await lstat(stateDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(lockPath)).mode & 0o777).toBe(0o700);
    expect((await lstat(claimPath)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(claimPath, "owner.json"))).mode & 0o777).toBe(0o600);

    const blocked = await Effect.runPromise(
      Effect.either(secondPlatform.acquireLock(lockPath, { timeoutMs: 20, staleMs: 1_000 })),
    );
    expect(blocked).toMatchObject({ _tag: "Left", left: { reason: "lock-timeout" } });

    await Effect.runPromise(secondPlatform.releaseLock({ path: lockPath, token: "not-the-owner" }));
    expect(JSON.parse(await readFile(path.join(claimPath, "owner.json"), "utf8"))).toMatchObject({
      token: lock.token,
    });

    await Effect.runPromise(firstPlatform.releaseLock(lock));
    await Effect.runPromise(firstPlatform.releaseLock(lock));
    await expect(readdir(lockPath)).resolves.toEqual([]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("elects one integration mutation under contention while recovering a stale claim", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-stale-lock-test-"));
  const stateDirectory = path.join(temporaryDirectory, "state");
  const lockPath = path.join(stateDirectory, "integrations.json.lock");
  const platform = makeNodeIntegrationPlatform();
  const staleToken = randomUUID();
  const staleClaim = path.join(lockPath, `claim-${staleToken}`);

  try {
    await mkdir(staleClaim, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(staleClaim, "owner.json"),
      `${JSON.stringify({
        version: 1,
        token: staleToken,
        pid: 2_147_483_647,
        createdAt: "2020-01-01T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );

    const outcomes = await Promise.allSettled(
      Array.from({ length: 16 }, async () =>
        await Effect.runPromise(
          platform.acquireLock(lockPath, { timeoutMs: 150, staleMs: 60_000 }),
        ),
      ),
    );
    const acquired = outcomes.filter((outcome) => outcome.status === "fulfilled");
    expect(acquired).toHaveLength(1);
    expect(
      outcomes
        .filter((outcome) => outcome.status === "rejected")
        .every((outcome) => String(outcome.reason).includes("Timed out")),
    ).toBe(true);
    const lock = acquired[0]?.value;
    expect(lock).toBeDefined();
    if (!lock) throw new Error("Expected one integration lock winner");
    expect(lock.token).not.toBe(staleToken);
    expect(
      JSON.parse(
        await readFile(path.join(lockPath, `claim-${lock.token}`, "owner.json"), "utf8"),
      ),
    ).toMatchObject({ token: lock.token });
    await Effect.runPromise(platform.releaseLock(lock));
    await expect(readdir(lockPath)).resolves.toEqual([]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Integration descendant remained alive: ${pid}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}
