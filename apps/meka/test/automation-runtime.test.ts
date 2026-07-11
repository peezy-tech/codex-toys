import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { MAX_DURABLE_COMMAND_TIMEOUT_MS } from "@meka/workflow";
import { expect, test } from "vite-plus/test";
import {
  AutomationRuntime,
  isManagedRunJob,
  managedRunPayload,
} from "../src/automation-runtime.ts";
import { claimHookIngress, resolveHookIngressLocation } from "../src/hook-ingress.ts";

test("routes an event through a TypeScript workflow into a managed run queue", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-runtime-test-"));
  const workspace = path.join(temporary, "workspace");
  await mkdir(workspace);
  const workflowPath = path.join(workspace, "review.ts");
  await writeFile(
    workflowPath,
    `
      import { Effect, MekaRuns, MekaWorkflow, Schema, WorkflowDecision } from "@meka/workflow";
      export default MekaWorkflow.make({
        id: "review-pr",
        on: "github.pull_request",
        input: Schema.Struct({ action: Schema.String, number: Schema.Number }),
        handler: (event) => Effect.gen(function* () {
          if (event.payload.action !== "opened") return WorkflowDecision.skipped("not opened");
          const runs = yield* MekaRuns;
          const job = yield* runs.enqueue({
            queue: "reviews",
            intent: { _tag: "meka.run", provider: "codex", prompt: "Review PR " + event.payload.number },
          });
          return WorkflowDecision.enqueued([job.id]);
        }),
      });
    `,
    "utf8",
  );
  const runtime = await AutomationRuntime.open({
    cwd: workspace,
    stateRoot: path.join(temporary, "state"),
  });
  try {
    await configureQueue(runtime, "workflows");
    await configureQueue(runtime, "reviews");
    await runtime.registerWorkflow(workflowPath, "workflows");
    const ingress = await runtime.ingestEvent({
      type: "github.pull_request",
      source: "github:test",
      deliveryId: "delivery-1",
      verified: true,
      payload: { action: "opened", number: 42 },
    });
    expect(ingress.jobIds).toHaveLength(1);
    const duplicate = await runtime.ingestEvent({
      type: "github.pull_request",
      source: "github:test",
      deliveryId: "delivery-1",
      verified: true,
      payload: { action: "opened", number: 42 },
    });
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.jobIds).toEqual(ingress.jobIds);

    await configureQueue(runtime, "moved-workflows");
    await runtime.registerWorkflow(workflowPath, "moved-workflows");
    const replayAfterMove = await runtime.ingestEvent({
      type: "github.pull_request",
      source: "github:test",
      deliveryId: "delivery-1",
      verified: true,
      payload: { action: "opened", number: 42 },
    });
    expect(replayAfterMove.jobIds).toEqual(ingress.jobIds);
    await expect(Effect.runPromise(runtime.store.listJobs())).resolves.toMatchObject([
      { id: ingress.jobIds[0], queueName: "workflows" },
    ]);

    const workflowJob = await runtime.claim("workflows");
    if (!workflowJob) throw new Error("Workflow job was not claimed");
    const execution = await runtime.executeInternalJob(workflowJob);
    expect(execution).toMatchObject({
      result: { _tag: "completed", decision: { _tag: "enqueued" } },
    });
    await expect(
      Effect.runPromise(runtime.store.getJobDetail(workflowJob.claim.job.id)),
    ).resolves.toMatchObject({
      status: "succeeded",
      provider: "workflow",
    });
    const workflowDetail = await Effect.runPromise(
      runtime.store.getJobDetail(workflowJob.claim.job.id),
    );
    expect(workflowDetail?.externalDispatchStartedAt).not.toBeNull();

    const runJob = await runtime.claim("reviews");
    if (!runJob) throw new Error("Managed run was not claimed");
    expect(isManagedRunJob(runJob)).toBe(true);
    expect(managedRunPayload(runJob)).toMatchObject({
      provider: "codex",
      prompt: "Review PR 42",
    });
    const firstIdempotent = await runtime.enqueueRun({
      queue: "reviews",
      idempotencyKey: "stable-run",
      intent: { _tag: "meka.run", provider: "codex", prompt: "Stable" },
    });
    const secondIdempotent = await runtime.enqueueRun({
      queue: "reviews",
      idempotencyKey: "stable-run",
      intent: { _tag: "meka.run", provider: "codex", prompt: "Stable" },
    });
    expect(secondIdempotent.id).toBe(firstIdempotent.id);
  } finally {
    await runtime.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("rolls back a new event when deterministic workflow routing fails", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-routing-atomicity-test-"));
  const workflowPath = path.join(temporary, "atomic.ts");
  const stateRoot = path.join(temporary, "state");
  const source = "test:atomic";
  const deliveryId = "atomic-delivery";
  await writeFile(
    workflowPath,
    `
      import { Effect, MekaWorkflow, Schema, WorkflowDecision } from "@meka/workflow";
      export default MekaWorkflow.make({
        id: "atomic-route-a",
        on: "test.atomic",
        input: Schema.Unknown,
        handler: () => Effect.succeed(WorkflowDecision.completed()),
      });
    `,
    "utf8",
  );

  let runtime = await AutomationRuntime.open({ cwd: temporary, stateRoot });
  const eventId = `wfe_${sha256(`${source}\0${deliveryId}`)}`;
  try {
    await configureQueue(runtime, "atomic");
    const firstWorkflow = await runtime.registerWorkflow(workflowPath, "atomic");
    const failingWorkflow = await Effect.runPromise(
      runtime.store.createWorkflowRegistration({
        id: "atomic-route-z",
        modulePath: workflowPath,
        revisionHash: firstWorkflow.revisionHash,
        triggerTypes: ["test.atomic"],
        queueName: "atomic",
      }),
    );
    const firstRouteJobId = routeJobId(firstWorkflow.id, firstWorkflow.revisionHash, eventId);
    const failingRouteJobId = routeJobId(failingWorkflow.id, failingWorkflow.revisionHash, eventId);
    await Effect.runPromise(
      runtime.store.enqueueJob({
        id: failingRouteJobId,
        queueName: "atomic",
        payload: { kind: "fault-injection" },
      }),
    );

    await expect(
      runtime.ingestEvent({
        type: "test.atomic",
        source,
        deliveryId,
        payload: {},
      }),
    ).rejects.toThrow(`Durable job already exists: ${failingRouteJobId}`);

    await runtime.close();
    runtime = await AutomationRuntime.open({ cwd: temporary, stateRoot });
    await expect(
      Effect.runPromise(runtime.store.getWorkflowEvent(eventId)),
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(runtime.store.listWorkflowEvents({ type: "test.atomic" })),
    ).resolves.toEqual([]);
    await expect(
      Effect.runPromise(runtime.store.getJobDetail(firstRouteJobId)),
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(runtime.store.getJobDetail(failingRouteJobId)),
    ).resolves.toMatchObject({
      id: failingRouteJobId,
      payload: { kind: "fault-injection" },
    });
  } finally {
    await runtime.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("routes an event to every matching workflow beyond the operator list cap", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-routing-page-test-"));
  const workflowPath = path.join(temporary, "workflow.ts");
  await writeFile(
    workflowPath,
    `
      import { Effect, MekaWorkflow, Schema, WorkflowDecision } from "@meka/workflow";
      export default MekaWorkflow.make({
        id: "routing-template",
        on: "test.fanout",
        input: Schema.Unknown,
        handler: () => Effect.succeed(WorkflowDecision.completed()),
      });
    `,
    "utf8",
  );
  const runtime = await AutomationRuntime.open({
    cwd: temporary,
    stateRoot: path.join(temporary, "state"),
  });
  try {
    await configureQueue(runtime, "fanout");
    for (let index = 0; index < 105; index += 1) {
      await Effect.runPromise(
        runtime.store.createWorkflowRegistration({
          id: `fanout-${index.toString().padStart(3, "0")}`,
          modulePath: workflowPath,
          revisionHash: "sha256:fanout",
          triggerTypes: ["test.fanout"],
          queueName: "fanout",
        }),
      );
    }

    const ingress = await runtime.ingestEvent({
      type: "test.fanout",
      source: "test",
      deliveryId: "fanout-1",
      payload: {},
    });

    expect(ingress.jobIds).toHaveLength(105);
    expect(new Set(ingress.jobIds)).toHaveLength(105);
    await expect(
      Effect.runPromise(runtime.store.listJobs({ queueName: "fanout", limit: 200 })),
    ).resolves.toHaveLength(105);
  } finally {
    await runtime.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("makes an aborted trusted workflow uncertain after its lease expires", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-workflow-dispatch-test-"));
  const workflowPath = path.join(temporary, "blocking.ts");
  await writeFile(
    workflowPath,
    `
      import { Effect, MekaWorkflow, Schema } from "@meka/workflow";
      export default MekaWorkflow.make({
        id: "blocking-workflow",
        on: "test.blocking",
        input: Schema.Unknown,
        handler: () => Effect.never,
      });
    `,
    "utf8",
  );
  const runtime = await AutomationRuntime.open({
    cwd: temporary,
    stateRoot: path.join(temporary, "state"),
  });
  const controller = new AbortController();
  try {
    await runtime.configureQueue({
      queueName: "blocking",
      concurrency: 1,
      startWindowMs: 60_000,
      maxStartsPerWindow: 60,
      leaseMs: 5_000,
    });
    await runtime.registerWorkflow(workflowPath, "blocking");
    await runtime.ingestEvent({
      type: "test.blocking",
      source: "test",
      deliveryId: "blocking-1",
      payload: {},
    });
    const claim = await runtime.claim("blocking");
    if (!claim) throw new Error("Blocking workflow job was not claimed");
    const execution = runtime.executeInternalJob(claim, { signal: controller.signal });
    await waitUntil(async () => {
      const detail = await Effect.runPromise(runtime.store.getJobDetail(claim.claim.job.id));
      return detail?.externalDispatchStartedAt !== null;
    });
    controller.abort(new Error("simulated worker loss"));
    await expect(execution).rejects.toThrow("simulated worker loss");

    await expect(
      Effect.runPromise(
        runtime.store.recoverExpiredLeases(Date.parse(claim.claim.leaseExpiresAt) + 1),
      ),
    ).resolves.toEqual({
      requeuedJobIds: [],
      uncertainJobIds: [claim.claim.job.id],
    });
    await expect(
      Effect.runPromise(runtime.store.getJobDetail(claim.claim.job.id)),
    ).resolves.toMatchObject({ status: "uncertain", provider: "workflow" });
  } finally {
    controller.abort();
    await runtime.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("rejects a queued workflow when an imported local module changed", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-revision-test-"));
  const workspace = path.join(temporary, "workspace");
  await mkdir(workspace);
  const helperPath = path.join(workspace, "helper.ts");
  const workflowPath = path.join(workspace, "workflow.ts");
  await writeFile(helperPath, 'export const value = "registered";\n', "utf8");
  await writeFile(
    workflowPath,
    `
      import { Effect, MekaWorkflow, Schema, WorkflowDecision } from "@meka/workflow";
      import { value } from "./helper.ts";
      export default MekaWorkflow.make({
        id: "revision-check",
        on: "test.event",
        input: Schema.Unknown,
        handler: () => Effect.succeed(WorkflowDecision.completed(value)),
      });
    `,
    "utf8",
  );
  const runtime = await AutomationRuntime.open({
    cwd: workspace,
    stateRoot: path.join(temporary, "state"),
  });
  try {
    await configureQueue(runtime, "revision");
    await runtime.registerWorkflow(workflowPath, "revision");
    await runtime.ingestEvent({
      type: "test.event",
      source: "test",
      deliveryId: "revision-1",
      payload: {},
    });
    await writeFile(helperPath, 'export const value = "changed";\n', "utf8");
    const claim = await runtime.claim("revision");
    if (!claim) throw new Error("Revision job was not claimed");
    await expect(runtime.executeInternalJob(claim)).rejects.toThrow(
      "Workflow module graph changed without registration",
    );
  } finally {
    await runtime.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("runs a registered RSS source and routes only new items", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-rss-runtime-test-"));
  const workspace = path.join(temporary, "workspace");
  await mkdir(workspace);
  const workflowPath = path.join(workspace, "feed.ts");
  await writeFile(
    workflowPath,
    `
      import { Effect, MekaWorkflow, Schema, WorkflowDecision } from "@meka/workflow";
      export default MekaWorkflow.make({
        id: "feed-item",
        on: "rss.item",
        input: Schema.Unknown,
        handler: () => Effect.succeed(WorkflowDecision.completed()),
      });
    `,
    "utf8",
  );
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><item><guid>one</guid><title>One</title></item></channel></rss>`;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/rss+xml" });
    response.end(feed);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const runtime = await AutomationRuntime.open({
    cwd: workspace,
    stateRoot: path.join(temporary, "state"),
  });
  try {
    await configureQueue(runtime, "feeds");
    await runtime.registerWorkflow(workflowPath, "feeds");
    await runtime.createSource({
      id: "news",
      kind: "rss",
      workflowId: "feed-item",
      config: { url: `http://127.0.0.1:${address.port}/feed` },
    });
    const first = (await runtime.pollRssSource("news")) as { events: unknown[] };
    const second = (await runtime.pollRssSource("news")) as { events: unknown[] };
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(0);
    await expect(
      Effect.runPromise(runtime.store.listJobs({ queueName: "feeds" })),
    ).resolves.toHaveLength(1);
  } finally {
    await runtime.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(temporary, { recursive: true, force: true });
  }
});

test("marks configured command dispatch before executing external work", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-command-runtime-test-"));
  const runtime = await AutomationRuntime.open({
    cwd: temporary,
    stateRoot: path.join(temporary, "state"),
  });
  try {
    await configureQueue(runtime, "commands");
    const queued = await runtime.enqueueJob({
      queue: "commands",
      kind: "command",
      payload: {
        argv: [process.execPath, "-e", 'process.stdout.write("command-ok")'],
      },
    });
    const claim = await runtime.claim("commands");
    if (!claim) throw new Error("Command job was not claimed");
    await expect(runtime.executeInternalJob(claim)).resolves.toMatchObject({
      code: 0,
      stdout: "command-ok",
    });
    await expect(Effect.runPromise(runtime.store.getJobDetail(queued.id))).resolves.toMatchObject({
      status: "succeeded",
      provider: "command",
    });
    const detail = await Effect.runPromise(runtime.store.getJobDetail(queued.id));
    expect(detail?.externalDispatchStartedAt).not.toBeNull();
  } finally {
    await runtime.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("runs a command source through an Effect workflow into a durable command result", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-command-chain-test-"));
  const workflowPath = path.join(temporary, "command-chain.ts");
  const actionArgv = [
    process.execPath,
    "-e",
    'process.stdout.write(JSON.stringify({ action: "finished" }))',
  ];
  await writeFile(
    workflowPath,
    `
      import { DurableCommand, DurableJobs, Effect, MekaWorkflow, Schema, WorkflowDecision } from "@meka/workflow";
      export default MekaWorkflow.make({
        id: "provider-free-command-chain",
        on: "inventory.received",
        input: Schema.Struct({ count: Schema.Number }),
        handler: (event) => Effect.gen(function* () {
          const jobs = yield* DurableJobs;
          const job = yield* jobs.enqueue(DurableCommand.make({
            queue: "commands",
            argv: ${JSON.stringify(actionArgv)},
            timeoutMs: 30_000,
            idempotencyKey: event.deliveryId ?? event.id,
          }));
          return WorkflowDecision.enqueued([job.id]);
        }),
      });
    `,
    "utf8",
  );
  const runtime = await AutomationRuntime.open({
    cwd: temporary,
    stateRoot: path.join(temporary, "state"),
  });
  try {
    await configureQueue(runtime, "commands");
    await runtime.registerWorkflow(workflowPath);
    await runtime.createSource({
      id: "inventory",
      kind: "command",
      workflowId: "provider-free-command-chain",
      config: {
        argv: [process.execPath, "-e", "process.stdout.write(JSON.stringify({ count: 3 }))"],
        eventType: "inventory.received",
      },
    });

    await runtime.runCommandSource("inventory");
    const workflowJob = await runtime.claim("default");
    if (!workflowJob) throw new Error("Workflow job was not claimed");
    await expect(runtime.executeInternalJob(workflowJob)).resolves.toMatchObject({
      result: { _tag: "completed", decision: { _tag: "enqueued" } },
    });

    const commandJob = await runtime.claim("commands");
    if (!commandJob) throw new Error("Command job was not claimed");
    await expect(runtime.executeInternalJob(commandJob)).resolves.toMatchObject({
      code: 0,
      stdout: '{"action":"finished"}',
      timedOut: false,
    });
    await expect(
      Effect.runPromise(runtime.store.getJobDetail(commandJob.claim.job.id)),
    ).resolves.toMatchObject({
      status: "succeeded",
      provider: "command",
      result: {
        code: 0,
        stdout: '{"action":"finished"}',
        timedOut: false,
      },
    });
  } finally {
    await runtime.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("rejects unsupported and malformed command jobs before durable admission or dispatch", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-command-contract-test-"));
  const runtime = await AutomationRuntime.open({
    cwd: temporary,
    stateRoot: path.join(temporary, "state"),
  });
  try {
    await configureQueue(runtime, "commands");
    await expect(
      runtime.enqueueJob({ queue: "commands", kind: "commnad", payload: { argv: ["node"] } }),
    ).rejects.toThrow("Unsupported durable job kind: commnad");
    await expect(
      runtime.enqueueJob({ queue: "commands", kind: "command", payload: { argv: [] } }),
    ).rejects.toThrow();
    await expect(
      runtime.enqueueJob({
        queue: "commands",
        kind: "command",
        payload: { argv: ["node"], timeoutMs: MAX_DURABLE_COMMAND_TIMEOUT_MS + 1 },
      }),
    ).rejects.toThrow();
    await expect(
      Effect.runPromise(runtime.store.listJobs({ queueName: "commands" })),
    ).resolves.toEqual([]);

    const legacy = await Effect.runPromise(
      runtime.store.enqueueJob({
        queueName: "commands",
        payload: {
          version: 1,
          kind: "command",
          payload: { argv: ["node"], timeoutMs: 0 },
        },
      }),
    );
    const claimed = await runtime.claim("commands");
    if (!claimed) throw new Error("Malformed command job was not claimed");
    await expect(runtime.executeInternalJob(claimed)).rejects.toThrow();
    await expect(
      Effect.runPromise(runtime.store.getJobDetail(legacy.job.id)),
    ).resolves.toMatchObject({
      provider: null,
      externalDispatchStartedAt: null,
    });
  } finally {
    await runtime.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("settles a damaged durable envelope and continues to the next queued job", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-damaged-envelope-test-"));
  const runtime = await AutomationRuntime.open({
    cwd: temporary,
    stateRoot: path.join(temporary, "state"),
  });
  try {
    await configureQueue(runtime, "commands");
    const damaged = await Effect.runPromise(
      runtime.store.enqueueJob({
        queueName: "commands",
        payload: { version: 99, kind: "command", payload: { argv: [process.execPath] } },
      }),
    );
    const valid = await runtime.enqueueJob({
      queue: "commands",
      kind: "command",
      payload: { argv: [process.execPath, "-e", "process.exit(0)"] },
    });

    const claimed = await runtime.claim("commands");
    expect(claimed?.claim.job.id).toBe(valid.id);
    await expect(
      Effect.runPromise(runtime.store.getJobDetail(damaged.job.id)),
    ).resolves.toMatchObject({
      status: "failed",
      attemptCount: 1,
      externalDispatchStartedAt: null,
      error: { type: "meka.invalid_job_envelope" },
    });
    await expect(
      Effect.runPromise(runtime.store.getJobAttempts(damaged.job.id)),
    ).resolves.toMatchObject([{ attemptNumber: 1, status: "failed" }]);
  } finally {
    await runtime.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

async function configureQueue(runtime: AutomationRuntime, queueName: string): Promise<void> {
  await runtime.configureQueue({
    queueName,
    concurrency: 1,
    startWindowMs: 60_000,
    maxStartsPerWindow: 60,
    leaseMs: 60_000,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function routeJobId(workflowId: string, revisionHash: string, eventId: string): string {
  return `job-workflow-${sha256(`workflow:${workflowId}:${revisionHash}:${eventId}`)}`;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for workflow dispatch");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("drains the shared hook inbox into workspace-scoped automation state", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-hook-runtime-test-"));
  const workspace = path.join(temporary, "workspace");
  const child = path.join(workspace, "package");
  const stateHome = path.join(temporary, "global-state");
  await mkdir(child, { recursive: true });
  const runtime = await AutomationRuntime.open({
    cwd: workspace,
    stateRoot: path.join(temporary, "automation-state"),
    stateHome,
  });
  try {
    await runtime.activateHookIngressConsumer();
    const location = resolveHookIngressLocation({ stateHome });
    await mkdir(location.inboxPath, { recursive: true, mode: 0o700 });
    await chmod(location.root, 0o700);
    await chmod(location.inboxPath, 0o700);
    const occurredAt = new Date().toISOString();
    const id = `hook-${String(Date.now()).padStart(13, "0")}-00000000-0000-4000-8000-000000000001`;
    await writeFile(
      path.join(location.inboxPath, `${id}.json`),
      `${JSON.stringify({
        version: 1,
        id,
        kind: "agent.hook",
        createdAt: occurredAt,
        cwd: child,
        payload: {
          source: "codex-hook",
          sourceEventId: "shared-hook-1",
          provider: "codex",
          sessionId: "external-session-1",
          eventType: "AfterAgent",
          occurredAt,
          payload: { cwd: child },
        },
      })}\n`,
      { mode: 0o600 },
    );

    await expect(runtime.drainHookSpool()).resolves.toEqual({ ingested: 1, duplicates: 0 });
    await expect(
      Effect.runPromise(
        runtime.store.listAgentEvents({ provider: "codex", sessionId: "external-session-1" }),
      ),
    ).resolves.toMatchObject([{ eventType: "AfterAgent" }]);
    await expect(
      Effect.runPromise(runtime.store.listWorkflowEvents({ source: "agent:codex" })),
    ).resolves.toMatchObject([{ type: "agent.codex.AfterAgent" }]);
    await expect(
      claimHookIngress({ stateHome, workspaceRoot: workspace, consumerId: "verification" }),
    ).resolves.toEqual([]);
  } finally {
    await runtime.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
