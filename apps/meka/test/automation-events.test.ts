import { expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { openAutomationStore, type AutomationStore } from "../src/automation/index.ts";

test("ingests a provider-neutral workflow event once and keeps compact reads separate", async () => {
  await withStore(async (store) => {
    const first = await run(
      store.ingestWorkflowEvent({
        type: "rss.entry",
        source: "rss:example",
        deliveryId: "guid-1",
        verified: true,
        observedAt: 1_000,
        receivedAt: 1_001,
        payload: { title: "A" },
        metadata: { etag: "v1" },
      }),
    );
    expect(first.inserted).toBe(true);
    expect(first.event).toMatchObject({
      type: "rss.entry",
      source: "rss:example",
      deliveryId: "guid-1",
      verified: true,
      observedAt: new Date(1_000).toISOString(),
    });
    const duplicate = await run(
      store.ingestWorkflowEvent({
        type: "rss.entry",
        source: "rss:example",
        deliveryId: "guid-1",
        verified: false,
        payload: { title: "changed" },
      }),
    );
    expect(duplicate).toEqual({ inserted: false, event: first.event });
    expect(await run(store.listWorkflowEvents({ source: "rss:example", verified: true }))).toEqual([
      first.event,
    ]);
    expect(await run(store.getWorkflowEvent(first.event.id))).toMatchObject({
      payload: { title: "A" },
      metadata: { etag: "v1" },
    });
  });
});

test("deduplicates hook ingress and derives external agent session leases only once", async () => {
  await withStore(async (store) => {
    const started = await run(
      store.ingestAgentHookEvent({
        source: "codex",
        sourceEventId: "start-1",
        provider: "codex",
        eventType: "SessionStart",
        payload: { session_id: "session-1" },
        receivedAt: 2_000,
        sessionLeaseMs: 100,
      }),
    );
    expect(started.inserted).toBe(true);
    expect(started.sessionLease).toMatchObject({
      provider: "codex",
      sessionId: "session-1",
      state: "active",
      leasedUntil: new Date(2_100).toISOString(),
    });
    const duplicate = await run(
      store.ingestAgentHookEvent({
        source: "codex",
        sourceEventId: "start-1",
        provider: "codex",
        eventType: "SessionStart",
        payload: { session_id: "session-1" },
        receivedAt: 9_000,
        sessionLeaseMs: 10_000,
      }),
    );
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.sessionLease).toBeNull();
    expect((await run(store.getExternalAgentSession("codex", "session-1")))?.leasedUntil).toBe(
      new Date(2_100).toISOString(),
    );

    const activity = await run(
      store.ingestAgentHookEvent({
        source: "codex",
        sourceEventId: "tool-1",
        provider: "codex",
        eventType: "PostToolUse",
        sessionId: "session-1",
        receivedAt: 2_050,
        sessionLeaseMs: 100,
      }),
    );
    expect(activity.sessionLease?.leasedUntil).toBe(new Date(2_150).toISOString());
    expect(await run(store.recoverExpiredExternalAgentSessions(2_101))).toEqual([]);
    const recovered = await run(store.recoverExpiredExternalAgentSessions(2_151));
    expect(recovered).toMatchObject([
      { provider: "codex", sessionId: "session-1", state: "expired" },
    ]);

    await run(
      store.ingestAgentHookEvent({
        source: "codex",
        sourceEventId: "start-2",
        provider: "codex",
        eventType: "hook.SessionStart",
        sessionId: "session-1",
        receivedAt: 3_000,
      }),
    );
    const ended = await run(
      store.ingestAgentHookEvent({
        source: "codex",
        sourceEventId: "end-1",
        provider: "codex",
        eventType: "SessionEnd",
        sessionId: "session-1",
        receivedAt: 3_001,
      }),
    );
    expect(ended.sessionLease).toMatchObject({ state: "released", leasedUntil: null });
    expect(
      await run(store.listAgentEvents({ provider: "codex", sessionId: "session-1" })),
    ).toHaveLength(4);
  });
});

test("keeps external session state monotonic and lets release win timestamp ties", async () => {
  await withStore(async (store) => {
    await run(
      store.ingestAgentHookEvent({
        source: "claude",
        sourceEventId: "activity-current",
        provider: "claude",
        eventType: "PostToolUse",
        sessionId: "session-order",
        occurredAt: 4_000,
        receivedAt: 4_000,
        sessionLeaseMs: 100,
      }),
    );
    const released = await run(
      store.ingestAgentHookEvent({
        source: "claude",
        sourceEventId: "release-tie",
        provider: "claude",
        eventType: "SessionEnd",
        sessionId: "session-order",
        occurredAt: 4_000,
        receivedAt: 4_000,
      }),
    );
    expect(released.sessionLease).toMatchObject({ state: "released", leasedUntil: null });

    const activityTie = await run(
      store.ingestAgentHookEvent({
        source: "claude",
        sourceEventId: "activity-tie",
        provider: "claude",
        eventType: "PostToolUse",
        sessionId: "session-order",
        occurredAt: 4_000,
        receivedAt: 4_000,
        sessionLeaseMs: 10_000,
      }),
    );
    expect(activityTie.sessionLease).toMatchObject({
      state: "released",
      lastEventId: released.event.id,
    });

    const olderOccurrence = await run(
      store.ingestAgentHookEvent({
        source: "claude",
        sourceEventId: "older-occurrence",
        provider: "claude",
        eventType: "UserPromptSubmit",
        sessionId: "session-order",
        occurredAt: 3_999,
        receivedAt: 5_000,
        sessionLeaseMs: 10_000,
      }),
    );
    expect(olderOccurrence.sessionLease).toMatchObject({
      state: "released",
      lastEventId: released.event.id,
    });

    const olderReceipt = await run(
      store.ingestAgentHookEvent({
        source: "claude",
        sourceEventId: "older-receipt",
        provider: "claude",
        eventType: "UserPromptSubmit",
        sessionId: "session-order",
        occurredAt: 5_000,
        receivedAt: 3_999,
        sessionLeaseMs: 10_000,
      }),
    );
    expect(olderReceipt.sessionLease).toMatchObject({
      state: "released",
      lastEventId: released.event.id,
    });

    const currentActivity = await run(
      store.ingestAgentHookEvent({
        source: "claude",
        sourceEventId: "new-activity",
        provider: "claude",
        eventType: "PostToolUse",
        sessionId: "session-order",
        occurredAt: 5_001,
        receivedAt: 5_001,
        sessionLeaseMs: 100,
      }),
    );
    expect(currentActivity.sessionLease).toMatchObject({
      state: "active",
      leasedUntil: new Date(5_101).toISOString(),
    });
  });
});

test("counts active external sessions exactly beyond the default list cap", async () => {
  await withStore(async (store) => {
    for (let index = 0; index < 105; index += 1) {
      await run(
        store.ingestAgentHookEvent({
          source: "codex",
          sourceEventId: `active-${index}`,
          provider: "codex",
          eventType: "SessionStart",
          sessionId: `session-${index}`,
          receivedAt: 10_000 + index,
        }),
      );
    }
    expect(await run(store.listExternalAgentSessions({ states: ["active"] }))).toHaveLength(100);
    expect(await run(store.countExternalAgentSessions({ states: ["active"] }))).toBe(105);
  });
});

test("bounds persisted agent and routed hook workflow events", async () => {
  await withStore(async (store) => {
    for (let index = 1; index <= 3; index += 1) {
      await run(
        store.ingestAgentHookEvent({
          source: "codex",
          sourceEventId: `retained-${index}`,
          provider: "codex",
          eventType: "AfterAgent",
          receivedAt: index * 1_000,
        }),
      );
      await run(
        store.ingestWorkflowEvent({
          type: "agent.codex.AfterAgent",
          source: "agent:codex",
          deliveryId: `retained-${index}`,
          receivedAt: index * 1_000,
          payload: {},
        }),
      );
    }
    await run(
      store.ingestWorkflowEvent({
        type: "rss.entry",
        source: "rss:unrelated",
        deliveryId: "unrelated",
        receivedAt: 500,
        payload: {},
      }),
    );
    expect(
      await run(store.prunePersistedHookEvents({ maxEntries: 2, maxAgeMs: 10_000, now: 4_000 })),
    ).toEqual({
      removedAgentEvents: 1,
      removedWorkflowEvents: 1,
      remainingAgentEvents: 2,
      remainingWorkflowEvents: 2,
    });
    expect(await run(store.listAgentEvents())).toHaveLength(2);
    expect(await run(store.listWorkflowEvents({ source: "agent:codex" }))).toHaveLength(2);
    expect(await run(store.listWorkflowEvents({ source: "rss:unrelated" }))).toHaveLength(1);
  });
});

test("retains routed hook events until their durable workflow jobs settle", async () => {
  await withStore(async (store) => {
    const ingested = await run(
      store.ingestWorkflowEvent({
        type: "agent.codex.AfterAgent",
        source: "agent:codex",
        deliveryId: "active-workflow-event",
        receivedAt: 1_000,
        payload: {},
      }),
    );
    const queued = await run(
      store.enqueueJob({
        queueName: "default",
        payload: {
          version: 1,
          kind: "meka.workflow",
          payload: { eventId: ingested.event.id },
        },
      }),
    );
    expect(
      await run(store.prunePersistedHookEvents({ maxEntries: 0, maxAgeMs: 0, now: 2_000 })),
    ).toMatchObject({ removedWorkflowEvents: 0, remainingWorkflowEvents: 1 });
    await run(store.cancelJob({ jobId: queued.job.id, reason: "test settled" }));
    expect(
      await run(store.prunePersistedHookEvents({ maxEntries: 0, maxAgeMs: 0, now: 2_000 })),
    ).toMatchObject({ removedWorkflowEvents: 1, remainingWorkflowEvents: 0 });
  });
});

test("keeps session ordering monotonic after old agent events are pruned", async () => {
  await withStore(async (store) => {
    const current = await run(
      store.ingestAgentHookEvent({
        source: "claude",
        sourceEventId: "retention-current",
        provider: "claude",
        sessionId: "retention-session",
        eventType: "PostToolUse",
        occurredAt: 4_000,
        receivedAt: 4_000,
      }),
    );
    await run(store.prunePersistedHookEvents({ maxEntries: 0, maxAgeMs: 0, now: 5_000 }));
    expect(await run(store.getAgentEvent(current.event.id))).toBeUndefined();

    const delayed = await run(
      store.ingestAgentHookEvent({
        source: "claude",
        sourceEventId: "retention-delayed",
        provider: "claude",
        sessionId: "retention-session",
        eventType: "UserPromptSubmit",
        occurredAt: 3_000,
        receivedAt: 5_000,
      }),
    );
    expect(delayed.sessionLease).toMatchObject({
      state: "active",
      lastEventId: current.event.id,
    });
  });
});

test("spools envelopes atomically without replacing an existing explicit id", async () => {
  await withStore(async (store) => {
    const first = await run(
      store.writeSpoolEntry({
        id: "event-1",
        kind: "hook",
        payload: { version: 1 },
        createdAt: 4_000,
      }),
    );
    const repeat = await run(
      store.writeSpoolEntry({
        id: "event-1",
        kind: "hook",
        payload: { version: 2 },
        createdAt: 4_001,
      }),
    );
    expect(repeat).toEqual(first);
    expect(await run(store.readSpoolEntry("event-1"))).toMatchObject({ payload: { version: 1 } });
    expect(await run(store.listSpoolEntries())).toEqual([first]);
    expect(await run(store.acknowledgeSpoolEntry("event-1"))).toBe(true);
    expect(await run(store.acknowledgeSpoolEntry("event-1"))).toBe(false);
  });
});

test("lists spool entries by creation time and then id", async () => {
  await withStore(async (store) => {
    const newest = await run(
      store.writeSpoolEntry({ id: "a-newest", kind: "hook", payload: {}, createdAt: 5_000 }),
    );
    const tieSecond = await run(
      store.writeSpoolEntry({ id: "b-oldest", kind: "hook", payload: {}, createdAt: 4_000 }),
    );
    const tieFirst = await run(
      store.writeSpoolEntry({ id: "a-oldest", kind: "hook", payload: {}, createdAt: 4_000 }),
    );
    expect(await run(store.listSpoolEntries())).toEqual([tieFirst, tieSecond, newest]);
    expect(await run(store.listSpoolEntries(2))).toEqual([tieFirst, tieSecond]);
  });
});

async function withStore(action: (store: AutomationStore) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-automation-events-test-"));
  const store = await run(openAutomationStore({ stateRoot: path.join(temporary, "state") }));
  try {
    await action(store);
  } finally {
    await run(store.close());
    await rm(temporary, { recursive: true, force: true });
  }
}

async function run<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return await Effect.runPromise(effect);
}
