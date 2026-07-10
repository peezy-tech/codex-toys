import {
  chmod,
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
import { expect, test } from "vite-plus/test";
import {
  acknowledgeHookIngressClaim,
  claimHookIngress,
  drainHookIngress,
  pruneHookIngress,
  readHookIngressClaims,
  recoverStaleHookIngressClaims,
  registerHookIngressConsumer,
  releaseHookIngressClaim,
  releaseHookIngressConsumer,
  renewHookIngressConsumer,
  resolveHookIngressLocation,
  type HookIngressClaim,
} from "../src/hook-ingress.ts";
import { AutomationValidationError } from "../src/automation/errors.ts";

test("routes overlapping workspaces to the most-specific active consumer", async () => {
  const fixture = await createFixture();
  const parent = path.join(fixture.root, "repo");
  const child = path.join(parent, "packages", "child");
  await mkdir(child, { recursive: true });
  const parentConsumer = await registerHookIngressConsumer({
    stateHome: fixture.stateHome,
    workspaceRoot: parent,
    consumerId: "parent-runtime",
    leaseMs: 5_000,
    now: 1_000,
  });
  const childConsumer = await registerHookIngressConsumer({
    stateHome: fixture.stateHome,
    workspaceRoot: child,
    consumerId: "child-runtime",
    leaseMs: 5_000,
    now: 1_000,
  });
  try {
    const parentEvent = await writeEvent(fixture.stateHome, parent, 1_100, 1);
    const childEvent = await writeEvent(fixture.stateHome, child, 1_200, 2);
    const parentClaims = await claimHookIngress({
      stateHome: fixture.stateHome,
      workspaceRoot: parent,
      consumerId: parentConsumer.consumerId,
      consumerToken: parentConsumer.token,
      now: 2_000,
    });
    expect(parentClaims.map((claim) => claim.id)).toEqual([parentEvent]);
    const childClaims = await claimHookIngress({
      stateHome: fixture.stateHome,
      workspaceRoot: child,
      consumerId: childConsumer.consumerId,
      consumerToken: childConsumer.token,
      now: 2_000,
    });
    expect(childClaims.map((claim) => claim.id)).toEqual([childEvent]);
    const location = resolveHookIngressLocation({ stateHome: fixture.stateHome });
    expect(
      (await lstat(path.join(location.consumersPath, "child-runtime.json"))).mode & 0o777,
    ).toBe(0o600);
    await acknowledgeAll([...parentClaims, ...childClaims]);
  } finally {
    await releaseHookIngressConsumer(parentConsumer, {
      stateHome: fixture.stateHome,
      now: 2_001,
    });
    await releaseHookIngressConsumer(childConsumer, {
      stateHome: fixture.stateHome,
      now: 2_001,
    });
    await fixture.cleanup();
  }
});

test("atomically admits only one live registration for a stable consumer id", async () => {
  const fixture = await createFixture();
  const workspace = path.join(fixture.root, "repo");
  await mkdir(workspace, { recursive: true });
  try {
    const results = await Promise.allSettled([
      registerHookIngressConsumer({
        stateHome: fixture.stateHome,
        workspaceRoot: workspace,
        consumerId: "singleton-runtime",
        now: 1_000,
      }),
      registerHookIngressConsumer({
        stateHome: fixture.stateHome,
        workspaceRoot: workspace,
        consumerId: "singleton-runtime",
        now: 1_000,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof registerHookIngressConsumer>>> =>
        result.status === "fulfilled",
    );
    if (winner) {
      await releaseHookIngressConsumer(winner.value, {
        stateHome: fixture.stateHome,
        now: 2_000,
      });
    }
  } finally {
    await fixture.cleanup();
  }
});

test("an expired consumer token cannot clobber its replacement", async () => {
  const fixture = await createFixture();
  const workspace = path.join(fixture.root, "repo");
  await mkdir(workspace, { recursive: true });
  try {
    const expired = await registerHookIngressConsumer({
      stateHome: fixture.stateHome,
      workspaceRoot: workspace,
      consumerId: "replaced-runtime",
      leaseMs: 1_000,
      now: 1_000,
    });
    const replacement = await registerHookIngressConsumer({
      stateHome: fixture.stateHome,
      workspaceRoot: workspace,
      consumerId: "replaced-runtime",
      leaseMs: 5_000,
      now: 2_000,
    });
    expect(replacement.token).not.toBe(expired.token);
    await expect(
      renewHookIngressConsumer(expired, { stateHome: fixture.stateHome, now: 1_500 }),
    ).rejects.toThrow("no longer active");
    await expect(
      releaseHookIngressConsumer(expired, { stateHome: fixture.stateHome, now: 1_500 }),
    ).resolves.toBe(false);
    await expect(
      renewHookIngressConsumer(replacement, { stateHome: fixture.stateHome, now: 2_100 }),
    ).resolves.toMatchObject({ token: replacement.token });
    await releaseHookIngressConsumer(replacement, {
      stateHome: fixture.stateHome,
      now: 2_200,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("recovers claims only after their registered consumer lease is stale", async () => {
  const fixture = await createFixture();
  const workspace = path.join(fixture.root, "repo");
  await mkdir(workspace, { recursive: true });
  try {
    const consumer = await registerHookIngressConsumer({
      stateHome: fixture.stateHome,
      workspaceRoot: workspace,
      consumerId: "crashed-runtime",
      leaseMs: 1_000,
      now: 1_000,
    });
    const id = await writeEvent(fixture.stateHome, workspace, 1_100, 1);
    expect(
      await claimHookIngress({
        stateHome: fixture.stateHome,
        workspaceRoot: workspace,
        consumerId: consumer.consumerId,
        consumerToken: consumer.token,
        now: 1_500,
      }),
    ).toHaveLength(1);
    expect(
      await recoverStaleHookIngressClaims({ stateHome: fixture.stateHome, now: 1_999 }),
    ).toEqual({ recovered: 0 });
    expect(
      await recoverStaleHookIngressClaims({ stateHome: fixture.stateHome, now: 2_000 }),
    ).toEqual({ recovered: 1 });
    const recovered = await claimHookIngress({
      stateHome: fixture.stateHome,
      workspaceRoot: workspace,
      consumerId: "replacement-runtime",
      now: 2_000,
    });
    expect(recovered.map((claim) => claim.id)).toEqual([id]);
    await acknowledgeAll(recovered);
  } finally {
    await fixture.cleanup();
  }
});

test("dead-letters poison input and lets later valid claims progress", async () => {
  const fixture = await createFixture();
  const workspace = path.join(fixture.root, "repo");
  await mkdir(workspace, { recursive: true });
  try {
    const poisonId = await writeEvent(fixture.stateHome, workspace, 1_000, 1);
    const location = resolveHookIngressLocation({ stateHome: fixture.stateHome });
    const poisonPath = path.join(location.inboxPath, `${poisonId}.json`);
    const poison = JSON.parse(await readFile(poisonPath, "utf8")) as Record<string, unknown>;
    const payload = poison.payload as Record<string, unknown>;
    payload.source = "invalid source";
    payload.error = "sensitive raw error";
    await writeFile(poisonPath, `${JSON.stringify(poison)}\n`, { mode: 0o600 });
    const validId = await writeEvent(fixture.stateHome, workspace, 2_000, 2);

    const claims = await claimHookIngress({
      stateHome: fixture.stateHome,
      workspaceRoot: workspace,
      consumerId: "secure-runtime",
    });
    expect(claims.map((claim) => claim.id)).toEqual([validId]);
    const deadLetters = await readdir(location.deadLetterPath);
    expect(deadLetters).toHaveLength(1);
    expect(await readFile(path.join(location.deadLetterPath, deadLetters[0] as string), "utf8"))
      .not.toContain("sensitive raw error");
    await acknowledgeAll(claims);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects validation failures without starving later claimed events", async () => {
  const fixture = await createFixture();
  const workspace = path.join(fixture.root, "repo");
  await mkdir(workspace, { recursive: true });
  try {
    const rejected = await writeEvent(fixture.stateHome, workspace, 1_000, 1);
    const accepted = await writeEvent(fixture.stateHome, workspace, 2_000, 2);
    const consumed: string[] = [];
    await expect(
      drainHookIngress(
        {
          stateHome: fixture.stateHome,
          workspaceRoot: workspace,
          consumerId: "drain-runtime",
        },
        async (claim) => {
          if (claim.id === rejected) throw new AutomationValidationError("poison");
          consumed.push(claim.id);
        },
      ),
    ).resolves.toEqual({ claimed: 2, acknowledged: 1, rejected: 1 });
    expect(consumed).toEqual([accepted]);
  } finally {
    await fixture.cleanup();
  }
});

test("claims parent-workspace events in deterministic occurrence order", async () => {
  const fixture = await createFixture();
  const parent = path.join(fixture.root, "repo");
  const child = path.join(parent, "packages", "child");
  const sibling = path.join(fixture.root, "repo-sibling");
  await Promise.all([mkdir(child, { recursive: true }), mkdir(sibling, { recursive: true })]);

  try {
    const later = await writeEvent(fixture.stateHome, parent, 3_000, 3);
    const earlier = await writeEvent(fixture.stateHome, child, 1_000, 1);
    await writeEvent(fixture.stateHome, sibling, 2_000, 2);

    const claims = await claimHookIngress({
      stateHome: fixture.stateHome,
      workspaceRoot: parent,
      consumerId: "custom-state-root",
      limit: 10,
    });
    expect(claims.map((claim) => claim.id)).toEqual([earlier, later]);
    expect(claims.map((claim) => claim.cwd)).toEqual([child, parent]);
    expect(
      (
        await readHookIngressClaims({
          stateHome: fixture.stateHome,
          workspaceRoot: parent,
          consumerId: "custom-state-root",
        })
      ).map((claim) => claim.id),
    ).toEqual([earlier, later]);

    for (const claim of claims) expect(await acknowledgeHookIngressClaim(claim)).toBe(true);
    const siblingClaims = await claimHookIngress({
      stateHome: fixture.stateHome,
      workspaceRoot: sibling,
      consumerId: "sibling-runtime",
    });
    expect(siblingClaims).toHaveLength(1);
    expect(siblingClaims[0]?.cwd).toBe(sibling);
    await acknowledgeAll(siblingClaims);
  } finally {
    await fixture.cleanup();
  }
});

test("atomically awards an inbox event to only one competing consumer", async () => {
  const fixture = await createFixture();
  const workspace = path.join(fixture.root, "repo");
  await mkdir(workspace, { recursive: true });
  try {
    await writeEvent(fixture.stateHome, workspace, 1_000, 1);
    const results = await Promise.all([
      claimHookIngress({
        stateHome: fixture.stateHome,
        workspaceRoot: workspace,
        consumerId: "runtime-a",
      }),
      claimHookIngress({
        stateHome: fixture.stateHome,
        workspaceRoot: workspace,
        consumerId: "runtime-b",
      }),
    ]);
    expect(results.flat()).toHaveLength(1);
    await acknowledgeAll(results.flat());
  } finally {
    await fixture.cleanup();
  }
});

test("releases a durable claim back to the inbox for retry", async () => {
  const fixture = await createFixture();
  const workspace = path.join(fixture.root, "repo");
  await mkdir(workspace, { recursive: true });
  try {
    const id = await writeEvent(fixture.stateHome, workspace, 1_000, 1);
    const [claim] = await claimHookIngress({
      stateHome: fixture.stateHome,
      workspaceRoot: workspace,
      consumerId: "first-runtime",
    });
    expect(claim?.id).toBe(id);
    expect(claim && (await releaseHookIngressClaim(claim))).toBe(true);
    expect(
      await readHookIngressClaims({
        stateHome: fixture.stateHome,
        workspaceRoot: workspace,
        consumerId: "first-runtime",
      }),
    ).toEqual([]);
    const retried = await claimHookIngress({
      stateHome: fixture.stateHome,
      workspaceRoot: workspace,
      consumerId: "second-runtime",
    });
    expect(retried.map((entry) => entry.id)).toEqual([id]);
    await acknowledgeAll(retried);
  } finally {
    await fixture.cleanup();
  }
});

test("refuses permissive files and symlink entries", async () => {
  const fixture = await createFixture();
  const workspace = path.join(fixture.root, "repo");
  await mkdir(workspace, { recursive: true });
  try {
    const unsafeId = await writeEvent(fixture.stateHome, workspace, 1_000, 1);
    const location = resolveHookIngressLocation({ stateHome: fixture.stateHome });
    await chmod(path.join(location.inboxPath, `${unsafeId}.json`), 0o644);
    const target = path.join(fixture.root, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    const symlinkId = hookId(2_000, 2);
    await symlink(target, path.join(location.inboxPath, `${symlinkId}.json`));

    expect(
      await claimHookIngress({
        stateHome: fixture.stateHome,
        workspaceRoot: workspace,
        consumerId: "secure-runtime",
      }),
    ).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

test("prunes expired and oldest unclaimed entries without touching claims", async () => {
  const fixture = await createFixture();
  const workspace = path.join(fixture.root, "repo");
  await mkdir(workspace, { recursive: true });
  try {
    await writeEvent(fixture.stateHome, workspace, 1_000, 1);
    await writeEvent(fixture.stateHome, workspace, 8_000, 2);
    const keepFirst = await writeEvent(fixture.stateHome, workspace, 9_000, 3);
    const keepSecond = await writeEvent(fixture.stateHome, workspace, 10_000, 4);
    expect(
      await pruneHookIngress({
        stateHome: fixture.stateHome,
        now: 10_000,
        maxAgeMs: 5_000,
        maxEntries: 2,
      }),
    ).toEqual({ removed: 2, remaining: 2 });
    const claims = await claimHookIngress({
      stateHome: fixture.stateHome,
      workspaceRoot: workspace,
      consumerId: "prune-runtime",
    });
    expect(claims.map((claim) => claim.id)).toEqual([keepFirst, keepSecond]);
    expect(
      await pruneHookIngress({
        stateHome: fixture.stateHome,
        now: 20_000,
        maxAgeMs: 0,
        maxEntries: 0,
      }),
    ).toEqual({ removed: 0, remaining: 0 });
    expect(
      await readHookIngressClaims({
        stateHome: fixture.stateHome,
        workspaceRoot: workspace,
        consumerId: "prune-runtime",
      }),
    ).toHaveLength(2);
    await acknowledgeAll(claims);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture(): Promise<{
  root: string;
  stateHome: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "meka-hook-ingress-test-"));
  return {
    root,
    stateHome: path.join(root, "state"),
    cleanup: async () => await rm(root, { recursive: true, force: true }),
  };
}

async function writeEvent(
  stateHome: string,
  cwd: string,
  occurredAt: number,
  sequence: number,
): Promise<string> {
  const location = resolveHookIngressLocation({ stateHome });
  await mkdir(location.inboxPath, { recursive: true, mode: 0o700 });
  await chmod(location.root, 0o700);
  await chmod(location.inboxPath, 0o700);
  const id = hookId(occurredAt, sequence);
  const createdAt = new Date(occurredAt).toISOString();
  await writeFile(
    path.join(location.inboxPath, `${id}.json`),
    `${JSON.stringify({
      version: 1,
      id,
      kind: "agent.hook",
      createdAt,
      cwd,
      payload: {
        source: "codex-hook",
        sourceEventId: `event-${sequence}`,
        provider: "codex",
        sessionId: "session-1",
        eventType: "AfterAgent",
        occurredAt: createdAt,
        payload: { cwd },
      },
    })}\n`,
    { mode: 0o600 },
  );
  return id;
}

function hookId(occurredAt: number, sequence: number): string {
  return `hook-${String(occurredAt).padStart(13, "0")}-00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

async function acknowledgeAll(claims: HookIngressClaim[]): Promise<void> {
  for (const claim of claims) await acknowledgeHookIngressClaim(claim);
}
