import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import {
  registerHookIngressConsumer,
  releaseHookIngressConsumer,
  resolveHookIngressLocation,
} from "../src/hook-ingress.ts";

test("serializes routing mutations while contenders recover one stale claim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meka-hook-routing-lock-"));
  const stateHome = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  const location = resolveHookIngressLocation({ stateHome });
  const registryPath = path.join(location.consumersPath, ".routing.lock.claims");
  const staleToken = randomUUID();
  const staleClaim = path.join(registryPath, `claim-${staleToken}`);
  try {
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(staleClaim, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(
      path.join(staleClaim, "owner.json"),
      `${JSON.stringify({
        version: 1,
        token: staleToken,
        pid: 2_147_483_647,
        consumerId: "stale-routing-owner",
        createdAt: "2026-07-10T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );

    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, async () =>
        await registerHookIngressConsumer({
          stateHome,
          workspaceRoot: workspace,
          consumerId: "contended-runtime",
          now: 1_000,
        }),
      ),
    );
    const winners = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<
        Awaited<ReturnType<typeof registerHookIngressConsumer>>
      > => outcome.status === "fulfilled",
    );
    expect(winners).toHaveLength(1);
    expect(
      outcomes
        .filter((outcome) => outcome.status === "rejected")
        .every((outcome) => String(outcome.reason).includes("already active")),
    ).toBe(true);
    await expect(readdir(registryPath)).resolves.toEqual([]);

    const winner = winners[0]?.value;
    if (!winner) throw new Error("Expected one routing-lock winner");
    await expect(
      releaseHookIngressConsumer(winner, { stateHome, now: 2_000 }),
    ).resolves.toBe(true);
    await expect(readdir(registryPath)).resolves.toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bypasses but never removes a dead legacy reused-path lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meka-hook-routing-legacy-"));
  const stateHome = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  const location = resolveHookIngressLocation({ stateHome });
  const legacyPath = path.join(location.consumersPath, ".routing.lock");
  try {
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(location.consumersPath, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(legacyPath, "2147483647\n", { mode: 0o600 });

    const registration = await registerHookIngressConsumer({
      stateHome,
      workspaceRoot: workspace,
      consumerId: "legacy-upgrade-runtime",
      now: 1_000,
    });
    await expect(readFile(legacyPath, "utf8")).resolves.toBe("2147483647\n");
    await expect(
      releaseHookIngressConsumer(registration, { stateHome, now: 2_000 }),
    ).resolves.toBe(true);
    await expect(readFile(legacyPath, "utf8")).resolves.toBe("2147483647\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
