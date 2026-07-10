# `@meka/workflow`

`@meka/workflow` is the Effect-based authoring contract for trusted TypeScript
workflow modules loaded by Meka. It uses stable Effect core, not the alpha
`@effect/workflow` package. The Meka host owns durable storage, queue policy,
and provider execution; a workflow validates an event and requests work. This
keeps durable compatibility, admission, recovery, and retries under Meka's
explicit contract while retaining Effect's typed errors, services, layers,
interruption, and resource safety.

## Define a workflow

```ts
import { Effect, MekaRuns, Schema, WorkflowDecision, defineWorkflow } from "@meka/workflow";

const Release = Schema.Struct({
  repository: Schema.String,
  tag: Schema.String,
});

export default defineWorkflow({
  id: "release-review",
  on: "release.published",
  input: Release,

  handler: (event) =>
    Effect.gen(function* () {
      const runs = yield* MekaRuns;
      const job = yield* runs.enqueue({
        queue: "reviews",
        idempotencyKey: `${event.payload.repository}:${event.payload.tag}`,
        intent: {
          _tag: "meka.run",
          provider: "codex",
          prompt: `Review release ${event.payload.tag}`,
        },
      });

      return WorkflowDecision.enqueued([job.id]);
    }),
});
```

`on` accepts one event type, multiple event types, or can be omitted for a
manual-only workflow. The module must default-export the result of
`defineWorkflow`. Revision and source hash are reserved for the registrar and
cannot be supplied by module code.

The handler receives a validated normalized envelope:

- `id`, `type`, `source`, and `observedAt`;
- `verified` and optional `deliveryId`;
- optional JSON `metadata` and trace context; and
- `payload`, decoded by the workflow's `Schema`.

Return one of `WorkflowDecision.completed`, `.skipped`, or `.enqueued`. The
decision and all host-service values must remain JSON-safe.

## Host services

`MekaRuns` is the only workflow-facing path for managed Codex and Claude runs.
It persists a `meka.run` intent in the requested named queue before provider
dispatch. `default` is the only built-in queue; configure every other queue
before registering or exercising a workflow that uses it.

Managed runs are workspace-bound. Omit `intent.cwd` to use the daemon's fixed
workspace. If supplied, it must resolve to exactly the daemon workspace; a
workflow cannot route a run into another directory.

`DurableJobs` provides lower-level `enqueue`, `read`, and `cancel` operations.
The public built-in job kind is a configured command action:

```ts
import { DurableCommand, DurableJobs, Effect } from "@meka/workflow";

const action = Effect.gen(function* () {
  const jobs = yield* DurableJobs;
  return yield* jobs.enqueue(
    DurableCommand.make({
      queue: "commands",
      argv: ["node", "./scripts/update-index.mjs"],
      timeoutMs: 30_000,
      idempotencyKey: "update-index:v1",
    }),
  );
});
```

`DurableCommand.make` validates a non-empty argv containing only non-empty
strings and an optional positive timeout no longer than 24 hours. Meka checks
the same payload before persistence and again before external dispatch. It
never invokes a shell. Unknown job kinds are rejected; use `MekaRuns` rather
than constructing a `meka.run` job manually.

Workflows should request durable operations instead of spawning detached
processes or talking to a provider directly.

Use stable source identities for idempotency keys. An expired job can be
retried only when the host knows no external side effect was accepted; an
ambiguous provider dispatch becomes `uncertain`.

## Runtime contract

The registrar attaches an immutable identity:

```ts
const registered = MekaWorkflow.register(workflow, {
  revision: "git:abc123",
  hash: "sha256:...",
});
```

`MekaWorkflow.execute(registered, unknownEvent)` returns an `Effect` that:

1. validates the normalized event and payload;
2. evaluates the handler with its declared services;
3. validates the terminal decision; and
4. captures typed failures, defects, and interruptions in a JSON-safe
   `WorkflowExecutionResult`.

The terminal Effect never fails its error channel, though it retains the
handler's service requirements. Meka runs it in a one-shot child process and
exposes only durable operations over a narrow IPC boundary.

That process boundary is lifecycle isolation, not a security sandbox. A
workflow can execute arbitrary code with the Meka user's authority. Only load
reviewed modules and treat remote payload fields as untrusted input even after
source authentication.

See
[`examples/workflows/github-pr-review.ts`](../../examples/workflows/github-pr-review.ts)
for an allowlisted GitHub pull-request policy that enqueues a Codex review, or
[`examples/workflows/repository-status-command.ts`](../../examples/workflows/repository-status-command.ts)
for a provider-free source-to-command chain.
