import { Effect, Schema, WorkflowDecision, defineWorkflow } from "@meka/workflow";

// Feed shapes vary across RSS and Atom. Start permissive, then replace this
// schema with the fields your selected feed actually guarantees.
export default defineWorkflow({
  id: "release-notes",
  on: "rss.item",
  input: Schema.Unknown,
  handler: () =>
    Effect.succeed(
      WorkflowDecision.completed({ accepted: true, policy: "example.release-notes" }),
    ),
});
