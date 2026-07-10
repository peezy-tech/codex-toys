import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type {
  InstallPluginInput,
  MekaEngine,
  MekaEvent,
  MekaRun,
  MekaRunInput,
  MekaRunOutcome,
  MekaRunState,
  PluginInstallResult,
} from "@meka/sdk";
import { expect, test } from "vite-plus/test";
import { AutomationRuntime } from "../src/automation-runtime.ts";
import { openAutomationStore, type AutomationStore } from "../src/automation/store.ts";
import { MekaClient } from "../src/client.ts";
import { MekaServer } from "../src/server.ts";

test("closes a live provider run and records uncertainty when provider acceptance cannot persist", async () => {
  const fixture = await createServerFixture("provider-acceptance", new SingleRunEngine());
  const engine = fixture.engine as SingleRunEngine;
  let store: AutomationStore | undefined;
  try {
    store = await Effect.runPromise(
      openAutomationStore({ cwd: fixture.workspace, stateRoot: fixture.stateRoot }),
    );
    const database = new DatabaseSync(store.location.databasePath);
    try {
      database.exec(`
        CREATE TRIGGER inject_provider_acceptance_failure
        BEFORE UPDATE OF provider_accepted_at ON automation_jobs
        BEGIN
          SELECT RAISE(ABORT, 'injected provider acceptance failure');
        END;
      `);
    } finally {
      database.close();
    }

    const queued = await fixture.client.startRun({ provider: "codex", prompt: "fault" });
    await waitForJobStatus(store, queued.jobId, "uncertain");
    expect(engine.run.closeCalls).toBe(1);

    const status = await fixture.client.status();
    expect(status.runs).toMatchObject([
      {
        id: queued.id,
        state: "closed",
        outcome: { state: "closed" },
        providerRunId: "provider-run-1",
      },
    ]);
    expect(status.automation.lastError).toContain("injected provider acceptance failure");
  } finally {
    if (store) await Effect.runPromise(store.close());
    await fixture.cleanup();
  }
});

test("starts work from another queue while a provider startup remains pending", async () => {
  const engine = new MultiQueueEngine();
  const fixture = await createServerFixture("parallel-startup", engine);
  let store: AutomationStore | undefined;
  try {
    store = await Effect.runPromise(
      openAutomationStore({ cwd: fixture.workspace, stateRoot: fixture.stateRoot }),
    );
    for (const queueName of ["slow", "fast"]) {
      await Effect.runPromise(
        store.configureQueue({
          queueName,
          concurrency: 1,
          startWindowMs: 60_000,
          maxStartsPerWindow: 60,
          leaseMs: 60_000,
        }),
      );
    }
    await fixture.client.startRun({ provider: "codex", prompt: "slow", queue: "slow" });
    await withTimeout(engine.slowStarted.promise, 2_000, "slow provider startup");

    await fixture.client.startRun({ provider: "codex", prompt: "fast", queue: "fast" });
    await withTimeout(engine.fastStarted.promise, 2_000, "fast provider startup");
    expect(engine.prompts).toEqual(["slow", "fast"]);

    engine.fastRun.finish({ state: "completed" });
    engine.releaseSlow.resolve(engine.slowRun);
    engine.slowRun.finish({ state: "completed" });
  } finally {
    engine.releaseSlow.resolve(engine.slowRun);
    if (store) await Effect.runPromise(store.close());
    await fixture.cleanup();
  }
});

test("resets a retained run record before dispatching an explicitly retried job", async () => {
  const engine = new RetryEngine();
  const fixture = await createServerFixture("retained-retry", engine);
  let store: AutomationStore | undefined;
  try {
    store = await Effect.runPromise(
      openAutomationStore({ cwd: fixture.workspace, stateRoot: fixture.stateRoot }),
    );
    const queued = await fixture.client.startRun({ provider: "codex", prompt: "retry me" });
    await withTimeout(engine.firstStarted.promise, 2_000, "first provider startup");
    engine.firstRun.finish({ state: "failed", error: "first attempt" });
    await waitForJobStatus(store, queued.jobId, "failed");

    expect((await fixture.client.status()).runs).toMatchObject([
      {
        id: queued.id,
        state: "failed",
        outcome: { state: "failed", error: "first attempt" },
        providerRunId: "provider-run-first",
      },
    ]);

    await Effect.runPromise(store.retryJob({ jobId: queued.jobId }));
    await withTimeout(engine.secondStarted.promise, 3_000, "retried provider startup");
    const retried = (await fixture.client.status()).runs.find((run) => run.id === queued.id);
    expect(retried).toMatchObject({
      id: queued.id,
      state: "running",
      providerSessionId: "provider-session-second",
      providerRunId: "provider-run-second",
    });
    expect(retried).not.toHaveProperty("outcome");

    engine.secondRun.finish({ state: "completed" });
    await waitForJobStatus(store, queued.jobId, "succeeded");
    await expect(Effect.runPromise(store.getJobAttempts(queued.jobId))).resolves.toMatchObject([
      { attemptNumber: 1, status: "failed", error: { state: "failed" } },
      { attemptNumber: 2, status: "succeeded" },
    ]);
  } finally {
    if (store) await Effect.runPromise(store.close());
    await fixture.cleanup();
  }
});

test("recovers an expired final lease without waiting for another queue arrival", async () => {
  const fixture = await createServerFixture("idle-lease-recovery", new SingleRunEngine());
  let store: AutomationStore | undefined;
  try {
    store = await Effect.runPromise(
      openAutomationStore({ cwd: fixture.workspace, stateRoot: fixture.stateRoot }),
    );
    await Effect.runPromise(
      store.configureQueue({
        queueName: "orphaned",
        concurrency: 1,
        startWindowMs: 60_000,
        maxStartsPerWindow: 100,
        leaseMs: 5_000,
      }),
    );
    const claimAt = Date.now() + 500;
    const queued = await Effect.runPromise(
      store.enqueueJob({
        queueName: "orphaned",
        notBefore: claimAt,
        payload: { version: 1, kind: "test.unknown", payload: {} },
      }),
    );
    const claim = await Effect.runPromise(
      store.claimNextJob({ queueName: "orphaned", now: claimAt }),
    );
    expect(claim.kind).toBe("claimed");
    const database = new DatabaseSync(store.location.databasePath);
    try {
      const expiredAt = Date.now() - 1;
      database
        .prepare("UPDATE automation_jobs SET lease_expires_at = ? WHERE id = ?")
        .run(expiredAt, queued.job.id);
      database
        .prepare("UPDATE automation_job_attempts SET lease_expires_at = ? WHERE job_id = ?")
        .run(expiredAt, queued.job.id);
    } finally {
      database.close();
    }

    // There are no pending rows after the external claim. The daemon still
    // must recover the expired lease on its periodic drain, requeue it, and
    // attempt the now-due job (which fails because the test kind is unknown).
    await waitForJobStatus(store, queued.job.id, "failed", 4_000);
    await expect(Effect.runPromise(store.getJobAttempts(queued.job.id))).resolves.toMatchObject([
      { attemptNumber: 1, status: "expired" },
      { attemptNumber: 2, status: "failed" },
    ]);
  } finally {
    if (store) await Effect.runPromise(store.close());
    await fixture.cleanup();
  }
});

test("aborts internal workers before daemon shutdown waits and records uncertainty", async () => {
  if (process.platform === "win32") return;
  const fixture = await createServerFixture("internal-shutdown", new SingleRunEngine());
  const runtime = await AutomationRuntime.open({
    cwd: fixture.workspace,
    stateRoot: fixture.stateRoot,
  });
  const pidPath = path.join(fixture.workspace, "command-descendant.pid");
  let descendantPid: number | undefined;
  try {
    await runtime.configureQueue({
      queueName: "commands",
      concurrency: 1,
      startWindowMs: 60_000,
      maxStartsPerWindow: 60,
      leaseMs: 5_000,
    });
    const queued = await runtime.enqueueJob({
      queue: "commands",
      kind: "command",
      payload: {
        argv: [
          process.execPath,
          "-e",
          `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref(); writeFileSync(process.argv[1], String(child.pid)); setInterval(() => {}, 1000);`,
          pidPath,
        ],
      },
    });
    await waitUntil(
      async () => {
        try {
          descendantPid = Number(await readFile(pidPath, "utf8"));
          return Number.isSafeInteger(descendantPid);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            return false;
          }
          throw error;
        }
      },
      { timeoutMs: 4_000, description: "internal command startup" },
    );

    const startedAt = Date.now();
    await fixture.server.close();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await waitUntil(() => !isProcessAlive(descendantPid as number), {
      timeoutMs: 2_000,
      description: "command descendant shutdown",
    });
    await expect(Effect.runPromise(runtime.store.getJobDetail(queued.id))).resolves.toMatchObject({
      status: "uncertain",
      provider: "command",
    });
  } finally {
    if (descendantPid && isProcessAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    await runtime.close();
    await fixture.cleanup();
  }
});

test("leaves managed backlog pending when active run capacity is full", async () => {
  const engine = new CapacityEngine();
  const fixture = await createServerFixture("managed-capacity", engine);
  let store: AutomationStore | undefined;
  try {
    store = await Effect.runPromise(
      openAutomationStore({ cwd: fixture.workspace, stateRoot: fixture.stateRoot }),
    );
    await Effect.runPromise(
      store.configureQueue({
        queueName: "capacity",
        concurrency: 40,
        startWindowMs: 60_000,
        maxStartsPerWindow: 100,
        leaseMs: 60_000,
      }),
    );
    const queued = [];
    for (let index = 0; index < 33; index += 1) {
      queued.push(
        await fixture.client.startRun({
          provider: "codex",
          prompt: `capacity-${index}`,
          queue: "capacity",
        }),
      );
    }
    await waitUntil(() => engine.runs.length === 32, {
      timeoutMs: 4_000,
      description: "32 managed starts",
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(engine.runs).toHaveLength(32);
    await expect(Effect.runPromise(store.getJob(queued[32]?.jobId ?? ""))).resolves.toMatchObject({
      status: "pending",
    });

    engine.runs[0]?.finish({ state: "completed" });
    await waitUntil(() => engine.runs.length === 33, {
      timeoutMs: 4_000,
      description: "backlogged managed start",
    });
  } finally {
    for (const run of engine.runs) run.finish({ state: "completed" });
    if (store) await Effect.runPromise(store.close());
    await fixture.cleanup();
  }
});

async function createServerFixture(
  name: string,
  engine: MekaEngine,
): Promise<{
  root: string;
  workspace: string;
  stateRoot: string;
  engine: MekaEngine;
  server: MekaServer;
  client: MekaClient;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), `meka-${name}-test-`));
  const workspace = path.join(root, "workspace");
  const stateRoot = path.join(root, "state");
  await mkdir(workspace);
  const server = new MekaServer({
    engine,
    cwd: workspace,
    stateRoot,
    runtimeRoot: path.join(root, "runtime"),
  });
  const ready = await server.start();
  const client = new MekaClient({ socketPath: ready.socketPath, requestTimeoutMs: 5_000 });
  await client.connect();
  return {
    root,
    workspace,
    stateRoot,
    engine,
    server,
    client,
    cleanup: async () => {
      client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

async function waitForJobStatus(
  store: AutomationStore,
  jobId: string,
  status: string,
  timeoutMs = 5_000,
): Promise<void> {
  await waitUntil(async () => (await Effect.runPromise(store.getJob(jobId)))?.status === status, {
    timeoutMs,
    description: `job ${jobId} to become ${status}`,
  });
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs: number; description: string },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${options.description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class TestRun implements MekaRun {
  readonly provider = "codex";
  readonly done: Promise<MekaRunOutcome>;
  closeCalls = 0;
  interruptCalls = 0;
  #state: MekaRunState = "running";
  #completion = Promise.withResolvers<MekaRunOutcome>();

  constructor(
    readonly providerSessionId: string,
    readonly providerRunId: string,
  ) {
    this.done = this.#completion.promise;
  }

  get state(): MekaRunState {
    return this.#state;
  }

  onEvent(_listener: (event: MekaEvent) => void): () => void {
    return () => undefined;
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.#state === "running") this.finish({ state: "closed" });
  }

  finish(outcome: MekaRunOutcome): void {
    if (this.#state !== "running") return;
    this.#state = outcome.state;
    this.#completion.resolve(outcome);
  }
}

abstract class TestEngine implements MekaEngine {
  abstract startRun(input: MekaRunInput): Promise<MekaRun>;

  async installPlugin(_input: InstallPluginInput): Promise<PluginInstallResult> {
    throw new Error("not used");
  }

  abstract close(): Promise<void>;
}

class SingleRunEngine extends TestEngine {
  readonly run = new TestRun("provider-session-1", "provider-run-1");

  async startRun(): Promise<MekaRun> {
    return this.run;
  }

  async close(): Promise<void> {
    await this.run.close();
  }
}

class MultiQueueEngine extends TestEngine {
  readonly slowStarted = Promise.withResolvers<void>();
  readonly fastStarted = Promise.withResolvers<void>();
  readonly releaseSlow = Promise.withResolvers<MekaRun>();
  readonly slowRun = new TestRun("provider-session-slow", "provider-run-slow");
  readonly fastRun = new TestRun("provider-session-fast", "provider-run-fast");
  readonly prompts: string[] = [];

  async startRun(input: MekaRunInput): Promise<MekaRun> {
    this.prompts.push(input.prompt);
    if (input.prompt === "slow") {
      this.slowStarted.resolve();
      return await this.releaseSlow.promise;
    }
    this.fastStarted.resolve();
    return this.fastRun;
  }

  async close(): Promise<void> {
    this.releaseSlow.resolve(this.slowRun);
    await Promise.all([this.slowRun.close(), this.fastRun.close()]);
  }
}

class RetryEngine extends TestEngine {
  readonly firstStarted = Promise.withResolvers<void>();
  readonly secondStarted = Promise.withResolvers<void>();
  readonly firstRun = new TestRun("provider-session-first", "provider-run-first");
  readonly secondRun = new TestRun("provider-session-second", "provider-run-second");
  #starts = 0;

  async startRun(): Promise<MekaRun> {
    this.#starts += 1;
    if (this.#starts === 1) {
      this.firstStarted.resolve();
      return this.firstRun;
    }
    if (this.#starts === 2) {
      this.secondStarted.resolve();
      return this.secondRun;
    }
    throw new Error(`Unexpected provider startup ${this.#starts}`);
  }

  async close(): Promise<void> {
    await Promise.all([this.firstRun.close(), this.secondRun.close()]);
  }
}

class CapacityEngine extends TestEngine {
  readonly runs: TestRun[] = [];

  async startRun(): Promise<MekaRun> {
    const index = this.runs.length + 1;
    const run = new TestRun(`capacity-session-${index}`, `capacity-run-${index}`);
    this.runs.push(run);
    return run;
  }

  async close(): Promise<void> {
    await Promise.all(this.runs.map(async (run) => await run.close()));
  }
}
