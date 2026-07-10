import { expect, test } from "vite-plus/test";
import { Layer } from "effect";
import {
  DurableCommand,
  DurableCommandPayloadSchema,
  DurableJobs,
  Effect,
  MekaRuns,
  MekaWorkflow,
  MAX_DURABLE_COMMAND_TIMEOUT_MS,
  Schema,
  WorkflowDecision,
  defineWorkflow,
  executeWorkflow,
  registerWorkflow,
  serializeWorkflowExecutionResult,
  toJsonValue,
  type DurableJob,
  type DurableJobsService,
  type MekaRunsService,
  type WorkflowDecision as WorkflowDecisionType,
  type WorkflowEvent as WorkflowEventType,
} from "../src/index.ts";

const PullRequestPayload = Schema.Struct({
  repository: Schema.String,
  number: Schema.Number,
  headSha: Schema.String,
});

const event = {
  id: "event-1",
  type: "github.pull_request.opened",
  source: "github",
  observedAt: "2026-07-10T12:00:00.000Z",
  verified: true,
  payload: {
    repository: "meka/example",
    number: 42,
    headSha: "abc123",
  },
};

const typeCheckDecision: WorkflowDecisionType = WorkflowDecision.completed();
const typeCheckEvent: WorkflowEventType<typeof event.payload> = event;
void typeCheckDecision;
void typeCheckEvent;

test("builds and validates the durable command action contract", () => {
  const request = DurableCommand.make({
    queue: "commands",
    argv: ["node", "./scripts/check.mjs"],
    timeoutMs: 30_000,
    idempotencyKey: "check:abc123",
  });

  expect(request).toEqual({
    queue: "commands",
    kind: "command",
    payload: {
      argv: ["node", "./scripts/check.mjs"],
      timeoutMs: 30_000,
    },
    idempotencyKey: "check:abc123",
  });
  expect(() => Schema.decodeUnknownSync(DurableCommandPayloadSchema)({ argv: [] })).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(DurableCommandPayloadSchema)({ argv: ["node", ""] }),
  ).toThrow();
  expect(() => DurableCommand.make({ queue: "commands", argv: ["node"], timeoutMs: 0 })).toThrow();
  expect(() =>
    DurableCommand.make({
      queue: "commands",
      argv: ["node"],
      timeoutMs: MAX_DURABLE_COMMAND_TIMEOUT_MS + 1,
    }),
  ).toThrow();
});

test("defines immutable trigger metadata and keeps registration identity outside module code", () => {
  const workflow = defineWorkflow({
    id: "trusted-pr-review",
    on: ["github.pull_request.opened", "github.pull_request.opened"],
    input: PullRequestPayload,
    handler: () => Effect.succeed(WorkflowDecision.completed()),
  });

  expect(workflow.on).toEqual(["github.pull_request.opened"]);
  expect(MekaWorkflow.triggers(workflow)).toEqual(["github.pull_request.opened"]);
  expect(Object.isFrozen(workflow)).toBe(true);
  expect(Object.isFrozen(workflow.on)).toBe(true);
  expect(MekaWorkflow.is(workflow)).toBe(true);
  expect(MekaWorkflow.is({ ...workflow, handler: undefined })).toBe(false);

  const registered = MekaWorkflow.register(workflow, {
    revision: "revision-1",
    hash: "sha256:abc123",
  });
  expect(registered.revision).toBe("revision-1");
  expect(registered.hash).toBe("sha256:abc123");
  expect(Object.isFrozen(registered)).toBe(true);

  const manual = defineWorkflow({
    id: "manual-only",
    input: Schema.Unknown,
    handler: () => Effect.succeed(WorkflowDecision.completed()),
  });
  expect(manual.on).toBeUndefined();
  expect(MekaWorkflow.triggers(manual)).toEqual([]);

  expect(() =>
    defineWorkflow({
      id: "invalid",
      on: "manual",
      input: Schema.Unknown,
      handler: () => Effect.succeed(WorkflowDecision.completed()),
      revision: "module-controlled",
    } as Parameters<typeof defineWorkflow>[0]),
  ).toThrow("assigned by the Meka registrar");
});

test("executes a decoded event with durable job and managed run services", async () => {
  const prior = makeJob({ id: "job-prior", state: "running" });
  const queued = makeJob({ id: "job-review", state: "pending", kind: "meka.run" });
  const canceled = makeJob({ id: prior.id, state: "canceled" });

  const jobsService: DurableJobsService = {
    enqueue: (request) => Effect.succeed(makeJob({ kind: request.kind })),
    read: () => Effect.succeed(prior),
    cancel: () => Effect.succeed(canceled),
  };
  const runsService: MekaRunsService = {
    enqueue: () => Effect.succeed(queued),
  };

  const workflow = defineWorkflow({
    id: "trusted-pr-review",
    on: "github.pull_request.opened",
    input: PullRequestPayload,
    handler: (received) =>
      Effect.gen(function* () {
        const jobs = yield* DurableJobs;
        const runs = yield* MekaRuns;
        const existing = yield* jobs.read("job-prior");
        const review = yield* runs.enqueue({
          queue: "reviews",
          idempotencyKey: `${received.payload.repository}:${received.payload.number}:${received.payload.headSha}`,
          intent: {
            _tag: "meka.run",
            provider: "codex",
            cwd: "/workspace",
            prompt: `Review PR #${received.payload.number}`,
          },
        });
        const stopped = yield* jobs.cancel(existing?.id ?? "missing", {
          reason: "superseded",
        });
        return WorkflowDecision.enqueued([review.id, stopped.id]);
      }),
  });

  const result = await Effect.runPromise(
    executeWorkflow(
      registerWorkflow(workflow, { revision: "revision-1", hash: "sha256:abc123" }),
      event,
    ).pipe(
      Effect.provide(
        Layer.merge(Layer.succeed(DurableJobs, jobsService), Layer.succeed(MekaRuns, runsService)),
      ),
    ),
  );

  expect(result).toEqual({
    _tag: "completed",
    workflow: {
      id: "trusted-pr-review",
      revision: "revision-1",
      hash: "sha256:abc123",
    },
    eventId: "event-1",
    decision: { _tag: "enqueued", jobIds: ["job-review", "job-prior"] },
  });
  expect(JSON.parse(serializeWorkflowExecutionResult(result))).toEqual(result);
});

test("returns a JSON-safe input error instead of invoking the handler", async () => {
  let invoked = false;
  const workflow = defineWorkflow({
    id: "typed-input",
    on: "manual",
    input: PullRequestPayload,
    handler: () => {
      invoked = true;
      return Effect.succeed(WorkflowDecision.completed());
    },
  });

  const result = await Effect.runPromise(
    executeWorkflow(registerWorkflow(workflow, { revision: "revision-2", hash: "sha256:def456" }), {
      ...event,
      payload: { repository: "meka/example", number: "not-a-number" },
    }),
  );

  expect(invoked).toBe(false);
  expect(result._tag).toBe("failed");
  if (result._tag === "failed") {
    expect(result.error.kind).toBe("WorkflowInputError");
    expect(result.eventId).toBe("event-1");
  }
  expect(() => serializeWorkflowExecutionResult(result)).not.toThrow();
});

test("captures typed failures, defects, and circular details as JSON", async () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;

  const failedWorkflow = defineWorkflow({
    id: "typed-failure",
    on: "manual",
    input: PullRequestPayload,
    handler: () => Effect.fail(circular),
  });
  const failed = await Effect.runPromise(
    MekaWorkflow.execute(
      MekaWorkflow.register(failedWorkflow, {
        revision: "revision-3",
        hash: "sha256:ghi789",
      }),
      event,
    ),
  );
  expect(failed._tag).toBe("failed");
  if (failed._tag === "failed") {
    expect(failed.error.kind).toBe("WorkflowHandlerError");
    expect(failed.error.details).toEqual({ self: "[Circular]" });
  }

  const defectWorkflow = defineWorkflow({
    id: "defect",
    on: "manual",
    input: PullRequestPayload,
    handler: () => {
      throw new Error("module exploded");
    },
  });
  const defect = await Effect.runPromise(
    executeWorkflow(
      registerWorkflow(defectWorkflow, {
        revision: "revision-4",
        hash: "sha256:jkl012",
      }),
      event,
    ),
  );
  expect(defect._tag).toBe("failed");
  if (defect._tag === "failed") {
    expect(defect.error.kind).toBe("WorkflowDefect");
    expect(JSON.stringify(defect)).toContain("module exploded");
  }

  const invalidDecisionWorkflow = defineWorkflow({
    id: "invalid-decision",
    on: "manual",
    input: PullRequestPayload,
    handler: () =>
      Effect.succeed({
        _tag: "completed",
        output: { notJson: undefined },
      } as unknown as WorkflowDecisionType),
  });
  const invalidDecision = await Effect.runPromise(
    executeWorkflow(
      registerWorkflow(invalidDecisionWorkflow, {
        revision: "revision-5",
        hash: "sha256:mno345",
      }),
      event,
    ),
  );
  expect(invalidDecision._tag).toBe("failed");
  if (invalidDecision._tag === "failed") {
    expect(invalidDecision.error.kind).toBe("WorkflowDecisionError");
  }

  expect(JSON.stringify(toJsonValue({ bigint: 1n, nonFinite: Number.NaN }))).toBe(
    '{"bigint":"1","nonFinite":null}',
  );
});

function makeJob(overrides: Partial<DurableJob> = {}): DurableJob {
  return {
    id: "job-1",
    queue: "default",
    kind: "test",
    state: "pending",
    payload: null,
    priority: 0,
    attempt: 0,
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z",
    ...overrides,
  };
}
