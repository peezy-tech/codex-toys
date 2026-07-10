import {
  DurableCommand,
  DurableJobs,
  Effect,
  Schema,
  WorkflowDecision,
  defineWorkflow,
} from "@meka/workflow";

const RepositoryStatus = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  changes: Schema.Array(Schema.String),
});

export default defineWorkflow({
  id: "repository-status-command",
  on: "repository.status",
  input: RepositoryStatus,

  handler: (event) =>
    Effect.gen(function* () {
      const jobs = yield* DurableJobs;
      const job = yield* jobs.enqueue(
        DurableCommand.make({
          queue: "commands",
          argv: ["node", "./examples/actions/repository-summary.mjs"],
          timeoutMs: 30_000,
          idempotencyKey: event.deliveryId ?? event.id,
        }),
      );
      return WorkflowDecision.enqueued([job.id]);
    }),
});
