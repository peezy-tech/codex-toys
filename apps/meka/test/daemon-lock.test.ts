import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import {
  acquireWorkspaceDaemonLock,
  type WorkspaceDaemonLock,
} from "../src/daemon-lock.ts";

test("elects one daemon while many contenders recover the same stale claim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meka-daemon-lock-contention-"));
  const registry = path.join(root, "daemon.lock");
  const staleToken = randomUUID();
  const staleClaim = path.join(registry, `claim-${staleToken}`);
  try {
    await mkdir(staleClaim, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(staleClaim, "owner.json"),
      `${JSON.stringify({
        version: 1,
        token: staleToken,
        pid: 2_147_483_647,
        cwd: root,
        startedAt: "2026-07-10T00:00:00.000Z",
        phase: "owned",
      })}\n`,
      { mode: 0o600 },
    );

    const outcomes = await Promise.allSettled(
      Array.from({ length: 24 }, async () => await acquireWorkspaceDaemonLock(root, root)),
    );
    const acquired = outcomes
      .filter(
        (outcome): outcome is PromiseFulfilledResult<WorkspaceDaemonLock> =>
          outcome.status === "fulfilled",
      )
      .map((outcome) => outcome.value);
    expect(acquired).toHaveLength(1);
    expect(
      outcomes
        .filter((outcome) => outcome.status === "rejected")
        .every((outcome) =>
          /already owns|due to contention/u.test(String(outcome.reason)),
        ),
    ).toBe(true);

    await acquired[0]?.release();
    await acquired[0]?.release();
    await expect(readdir(registry)).resolves.toEqual([]);

    const next = await acquireWorkspaceDaemonLock(root, root);
    await next.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release is idempotent and refuses to remove a different token at its claim path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meka-daemon-lock-release-"));
  try {
    const lock = await acquireWorkspaceDaemonLock(root, root);
    const replacementToken = randomUUID();
    await rm(lock.path, { recursive: true, force: true });
    await mkdir(lock.path, { mode: 0o700 });
    await writeFile(
      path.join(lock.path, "owner.json"),
      `${JSON.stringify({
        version: 1,
        token: replacementToken,
        pid: process.pid,
        cwd: root,
        startedAt: new Date().toISOString(),
        phase: "owned",
      })}\n`,
      { mode: 0o600 },
    );

    await lock.release();
    await lock.release();
    const owner = JSON.parse(await readFile(path.join(lock.path, "owner.json"), "utf8")) as {
      token: string;
    };
    expect(owner.token).toBe(replacementToken);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
