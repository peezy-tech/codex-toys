import { expect, test } from "vite-plus/test";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { Effect } from "effect";
import {
  openAutomationStore,
  resolveAutomationStateLocation,
  type AutomationStore,
} from "../src/automation/index.ts";

test("persists private deterministic SQLite state and applies migrations", async () => {
  await withStore(async (store, root) => {
    const info = await run(store.info());
    expect(info.location.root).toBe(root);
    expect(info.schemaVersion).toBeGreaterThanOrEqual(3);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(info.location.spoolPath)).mode & 0o777).toBe(0o700);
    expect((await lstat(info.location.databasePath)).mode & 0o777).toBe(0o600);
  });
});

test("derives one workspace identity through real and symbolic paths", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-workspace-identity-test-"));
  const workspace = path.join(temporary, "workspace");
  const alias = path.join(temporary, "workspace-alias");
  const stateHome = path.join(temporary, "state-home");
  await mkdir(workspace);
  await symlink(workspace, alias);
  try {
    expect(resolveAutomationStateLocation({ cwd: alias, stateHome })).toEqual(
      resolveAutomationStateLocation({ cwd: workspace, stateHome }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("reopens an existing state root without replaying or losing durable jobs", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-automation-reopen-test-"));
  const root = path.join(temporary, "state");
  const first = await run(openAutomationStore({ stateRoot: root }));
  try {
    await run(
      first.configureQueue({
        queueName: "work",
        concurrency: 1,
        startWindowMs: 60_000,
        maxStartsPerWindow: 60,
        leaseMs: 60_000,
      }),
    );
    await run(
      first.enqueueJob({
        id: "persisted",
        queueName: "work",
        payload: { persisted: true },
        now: 10,
      }),
    );
  } finally {
    await run(first.close());
  }
  const second = await run(openAutomationStore({ stateRoot: root }));
  try {
    expect(await run(second.getJobDetail("persisted"))).toMatchObject({
      status: "pending",
      payload: { persisted: true },
    });
  } finally {
    await run(second.close());
    await rm(temporary, { recursive: true, force: true });
  }
});

test("serializes concurrent first-open migrations", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-automation-migration-race-test-"));
  const databasePath = path.join(temporary, "state", "automation.sqlite");
  await mkdir(path.dirname(databasePath), { recursive: true });
  const moduleUrl = pathToFileURL(path.resolve("apps/meka/src/automation/migrations.ts")).href;
  const workers = [
    migrationWorker(databasePath, moduleUrl),
    migrationWorker(databasePath, moduleUrl),
  ];
  try {
    await Promise.all(workers.map(({ ready }) => ready));
    for (const { worker } of workers) worker.postMessage("migrate");
    const versions = await Promise.all(workers.map(({ result }) => result));
    expect(new Set(versions).size).toBe(1);
    expect(versions[0]).toBeGreaterThanOrEqual(3);
  } finally {
    await Promise.all(workers.map(({ worker }) => worker.terminate()));
    await rm(temporary, { recursive: true, force: true });
  }
});

test("uplifts legacy queue leases to the production minimum", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-lease-migration-test-"));
  const root = path.join(temporary, "state");
  const first = await run(openAutomationStore({ stateRoot: root }));
  const databasePath = first.location.databasePath;
  try {
    await run(
      first.configureQueue({
        queueName: "legacy-short",
        concurrency: 1,
        startWindowMs: 60_000,
        maxStartsPerWindow: 60,
        leaseMs: 5_000,
      }),
    );
  } finally {
    await run(first.close());
  }
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare("UPDATE automation_queue_policies SET lease_ms = 100").run();
    database.exec("ALTER TABLE automation_external_sessions DROP COLUMN last_occurred_at");
    database.prepare("DELETE FROM automation_schema_migrations WHERE version >= 5").run();
  } finally {
    database.close();
  }
  const reopened = await run(openAutomationStore({ stateRoot: root }));
  try {
    await expect(run(reopened.getQueuePolicy("legacy-short"))).resolves.toMatchObject({
      leaseMs: 5_000,
    });
  } finally {
    await run(reopened.close());
    await rm(temporary, { recursive: true, force: true });
  }
});

test("refuses to open a database from a newer schema without mutating it", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-future-schema-test-"));
  const root = path.join(temporary, "state");
  await mkdir(root, { recursive: true });
  const databasePath = path.join(root, "automation.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE automation_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO automation_schema_migrations(version, applied_at) VALUES (999, 0);
    `);
  } finally {
    database.close();
  }

  await expect(run(openAutomationStore({ stateRoot: root }))).rejects.toThrow(
    "schema version 999 is newer",
  );
  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = inspection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(["automation_schema_migrations"]);
  } finally {
    inspection.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("requires named queues to be configured while keeping a built-in default", async () => {
  await withStore(async (store) => {
    await expect(
      run(
        store.configureQueue({
          queueName: "too-short",
          concurrency: 1,
          startWindowMs: 60_000,
          maxStartsPerWindow: 60,
          leaseMs: 4_999,
        }),
      ),
    ).rejects.toThrow("leaseMs must be at least 5000");
    await expect(run(store.getQueuePolicy("typo-queue"))).rejects.toThrow(
      "Queue is not configured: typo-queue",
    );
    await expect(run(store.enqueueJob({ queueName: "typo-queue", payload: {} }))).rejects.toThrow(
      "Queue is not configured: typo-queue",
    );
    await expect(
      run(
        store.createWorkflowRegistration({
          id: "unconfigured-workflow",
          modulePath: import.meta.filename,
          revisionHash: "revision",
          triggerTypes: [],
          queueName: "typo-queue",
        }),
      ),
    ).rejects.toThrow("Queue is not configured: typo-queue");

    await expect(
      run(store.enqueueJob({ queueName: "default", payload: { accepted: true } })),
    ).resolves.toMatchObject({ created: true, job: { queueName: "default" } });
    await expect(run(store.listQueuePolicies())).resolves.toMatchObject([
      { queueName: "default", concurrency: 1, maxStartsPerWindow: 60 },
    ]);
  });
});

test("deduplicates jobs, honors priority, concurrency, and rolling start budgets", async () => {
  await withStore(async (store) => {
    await run(
      store.configureQueue({
        queueName: "work",
        concurrency: 1,
        startWindowMs: 1_000,
        maxStartsPerWindow: 2,
        leaseMs: 5_000,
      }),
    );
    expect(await run(store.listQueuePolicies())).toEqual([
      {
        queueName: "default",
        concurrency: 1,
        startWindowMs: 60_000,
        maxStartsPerWindow: 60,
        leaseMs: 60_000,
      },
      {
        queueName: "work",
        concurrency: 1,
        startWindowMs: 1_000,
        maxStartsPerWindow: 2,
        leaseMs: 5_000,
      },
    ]);
    const low = await run(
      store.enqueueJob({
        queueName: "work",
        payload: { value: "low" },
        priority: 1,
        idempotencyKey: "dedupe",
        now: 1_000,
      }),
    );
    const duplicate = await run(
      store.enqueueJob({
        queueName: "work",
        payload: { value: "low" },
        priority: 1,
        idempotencyKey: "dedupe",
        now: 1_000,
      }),
    );
    expect(duplicate).toEqual({ created: false, job: low.job });
    const implicitSchedule = await run(
      store.enqueueJob({
        queueName: "work",
        payload: { value: "implicit" },
        idempotencyKey: "implicit-schedule",
        now: 1_000,
      }),
    );
    expect(
      await run(
        store.enqueueJob({
          queueName: "work",
          payload: { value: "implicit" },
          idempotencyKey: "implicit-schedule",
          now: 2_000,
        }),
      ),
    ).toEqual({ created: false, job: implicitSchedule.job });
    await expect(
      run(
        store.enqueueJob({
          queueName: "work",
          payload: { value: "different" },
          priority: 1,
          idempotencyKey: "dedupe",
          now: 1_000,
        }),
      ),
    ).rejects.toThrow("Idempotency key");

    await run(
      store.enqueueJob({ queueName: "work", payload: { value: "high" }, priority: 10, now: 1_000 }),
    );
    const first = await claimed(store, "work", 1_001);
    expect(first.payload).toEqual({ value: "high" });
    expect((await run(store.claimNextJob({ queueName: "work", now: 1_002 }))).kind).toBe(
      "concurrency-exhausted",
    );
    await run(store.succeedJob({ jobId: first.job.id, leaseToken: first.leaseToken, now: 1_003 }));

    const second = await claimed(store, "work", 1_004);
    expect(second.job.id).toBe(low.job.id);
    await run(
      store.failJob({
        jobId: second.job.id,
        leaseToken: second.leaseToken,
        error: { type: "test" },
        now: 1_005,
      }),
    );
    const budget = await run(store.claimNextJob({ queueName: "work", now: 1_006 }));
    expect(budget).toMatchObject({ kind: "start-budget-exhausted", starts: 2, limit: 2 });
    expect(await run(store.listQueueUsage(1_006))).toContainEqual({
      queueName: "work",
      concurrency: 1,
      startWindowMs: 1_000,
      maxStartsPerWindow: 2,
      leaseMs: 5_000,
      pending: 1,
      active: 0,
      concurrencyRemaining: 1,
      startsUsed: 2,
      startsRemaining: 0,
      nextStartAt: new Date(2_001).toISOString(),
    });
  });
});

test("lists every pending queue and counts statuses in SQL without list truncation", async () => {
  await withStore(async (store) => {
    for (let index = 0; index < 101; index += 1) {
      const queueName = `queue-${String(index).padStart(3, "0")}`;
      await run(
        store.configureQueue({
          queueName,
          concurrency: 1,
          startWindowMs: 60_000,
          maxStartsPerWindow: 60,
          leaseMs: 60_000,
        }),
      );
      await run(
        store.enqueueJob({
          id: `count-${index}`,
          queueName,
          payload: { index },
          now: 1_000 + index,
        }),
      );
    }
    const listed = await run(store.listJobs());
    expect(listed).toHaveLength(100);
    const queueNames = await run(store.listPendingQueueNames());
    expect(queueNames).toHaveLength(101);
    expect(queueNames.at(0)).toBe("queue-000");
    expect(queueNames.at(-1)).toBe("queue-100");
    expect(await run(store.countJobsByStatus())).toEqual({
      pending: 101,
      leased: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      canceled: 0,
      uncertain: 0,
    });
    expect(await run(store.countJobsByStatus({ queueName: "queue-042" }))).toMatchObject({
      pending: 1,
    });
  });
});

test("requeues an expired pre-dispatch lease but makes external work uncertain", async () => {
  await withStore(async (store) => {
    await run(
      store.configureQueue({
        queueName: "safe",
        concurrency: 1,
        startWindowMs: 10_000,
        maxStartsPerWindow: 10,
        leaseMs: 5_000,
      }),
    );
    await run(store.enqueueJob({ queueName: "safe", payload: { task: "safe" }, now: 1_000 }));
    const safe = await claimed(store, "safe", 1_000);
    expect(await run(store.recoverExpiredLeases(6_001))).toEqual({
      requeuedJobIds: [safe.job.id],
      uncertainJobIds: [],
    });
    expect((await run(store.getJob(safe.job.id)))?.status).toBe("pending");

    await run(
      store.configureQueue({
        queueName: "external",
        concurrency: 1,
        startWindowMs: 10_000,
        maxStartsPerWindow: 10,
        leaseMs: 5_000,
      }),
    );
    await run(
      store.enqueueJob({ queueName: "external", payload: { task: "external" }, now: 2_000 }),
    );
    const external = await claimed(store, "external", 2_000);
    await run(
      store.markExternalDispatch({
        jobId: external.job.id,
        leaseToken: external.leaseToken,
        provider: "codex",
        now: 2_001,
      }),
    );
    expect(await run(store.recoverExpiredLeases(7_001))).toEqual({
      requeuedJobIds: [],
      uncertainJobIds: [external.job.id],
    });
    expect((await run(store.getJob(external.job.id)))?.status).toBe("uncertain");
    expect((await run(store.claimNextJob({ queueName: "external", now: 7_002 }))).kind).toBe(
      "empty",
    );

    await run(store.retryJob({ jobId: external.job.id, now: 7_003 }));
    expect((await run(store.getJob(external.job.id)))?.status).toBe("pending");
  });
});

test("reconciles uncertain jobs without redispatch and settles their attempt history", async () => {
  await withStore(async (store) => {
    await run(
      store.configureQueue({
        queueName: "reconcile",
        concurrency: 3,
        startWindowMs: 10_000,
        maxStartsPerWindow: 10,
        leaseMs: 5_000,
      }),
    );
    const resolutions = ["succeeded", "failed", "canceled"] as const;
    for (const [index, status] of resolutions.entries()) {
      const enqueued = await run(
        store.enqueueJob({
          id: `reconcile-${status}`,
          queueName: "reconcile",
          payload: { status },
          now: 2_000 + index,
        }),
      );
      const claim = await claimed(store, "reconcile", 2_010 + index);
      expect(claim.job.id).toBe(enqueued.job.id);
      await run(
        store.markExternalDispatch({
          jobId: claim.job.id,
          leaseToken: claim.leaseToken,
          provider: "codex",
          now: 2_020 + index,
        }),
      );
      await run(
        store.markJobUncertain({
          jobId: claim.job.id,
          leaseToken: claim.leaseToken,
          reason: { type: "test.uncertain" },
          now: 2_030 + index,
        }),
      );

      const reconciled =
        status === "succeeded"
          ? await run(
              store.reconcileUncertainJob({
                jobId: claim.job.id,
                status,
                result: { providerState: "complete" },
                now: 2_040 + index,
              }),
            )
          : await run(
              store.reconcileUncertainJob({
                jobId: claim.job.id,
                status,
                error: { providerState: status },
                now: 2_040 + index,
              }),
            );
      expect(reconciled.status).toBe(status);
      expect(await run(store.getJobDetail(claim.job.id))).toMatchObject(
        status === "succeeded"
          ? { status, result: { providerState: "complete" }, error: null }
          : { status, result: null, error: { providerState: status } },
      );
      expect(await run(store.getJobAttempts(claim.job.id))).toMatchObject([
        {
          attemptNumber: 1,
          status,
          error: status === "succeeded" ? null : { providerState: status },
        },
      ]);
      await expect(
        run(
          store.reconcileUncertainJob({
            jobId: claim.job.id,
            status: "succeeded",
          }),
        ),
      ).rejects.toThrow("Only uncertain jobs");
    }

    await expect(
      run(
        store.reconcileUncertainJob({
          jobId: "reconcile-succeeded",
          status: "pending",
        } as never),
      ),
    ).rejects.toThrow("Unknown uncertain job resolution");
  });
});

async function claimed(store: AutomationStore, queueName: string, now: number) {
  const result = await run(store.claimNextJob({ queueName, now }));
  if (result.kind !== "claimed") {
    throw new Error(`Expected a claim, received ${result.kind}`);
  }
  return result.claim;
}

async function withStore(
  action: (store: AutomationStore, root: string) => Promise<void>,
): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-automation-test-"));
  const root = path.join(temporary, "state");
  const store = await run(openAutomationStore({ stateRoot: root }));
  try {
    await action(store, root);
  } finally {
    await run(store.close());
    await rm(temporary, { recursive: true, force: true });
  }
}

async function run<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return await Effect.runPromise(effect);
}

function migrationWorker(
  databasePath: string,
  moduleUrl: string,
): {
  worker: Worker;
  ready: Promise<void>;
  result: Promise<number>;
} {
  const source = String.raw`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    void (async () => {
      try {
        const { applyAutomationMigrations } = await import(workerData.moduleUrl);
        const database = new DatabaseSync(workerData.databasePath);
        parentPort.postMessage({ kind: "ready" });
        await new Promise((resolve) => parentPort.once("message", resolve));
        const version = applyAutomationMigrations(database);
        database.close();
        parentPort.postMessage({ kind: "result", version });
      } catch (error) {
        parentPort.postMessage({
          kind: "error",
          message: error instanceof Error ? error.stack ?? error.message : String(error),
        });
      }
    })();
  `;
  const worker = new Worker(source, {
    eval: true,
    workerData: { databasePath, moduleUrl },
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (version: number) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<number>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on(
    "message",
    (message: { kind: "ready" | "result" | "error"; version?: number; message?: string }) => {
      if (message.kind === "ready") {
        resolveReady();
      } else if (message.kind === "result" && typeof message.version === "number") {
        resolveResult(message.version);
      } else if (message.kind === "error") {
        const error = new Error(message.message ?? "Migration worker failed");
        rejectReady(error);
        rejectResult(error);
      }
    },
  );
  worker.on("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  return { worker, ready, result };
}
