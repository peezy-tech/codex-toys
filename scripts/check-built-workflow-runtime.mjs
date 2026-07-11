import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(os.tmpdir(), "meka-built-workflow-"));
const workflowPath = path.join(directory, "built-workflow.ts");

try {
  await writeFile(
    workflowPath,
    `
      import { Effect, MekaWorkflow, Schema, WorkflowDecision } from "@meka/workflow";

      export default MekaWorkflow.make({
        id: "built-workflow-smoke",
        on: "built.smoke",
        input: Schema.Unknown,
        handler: () => Effect.succeed(WorkflowDecision.completed("built-ok")),
      });
    `,
    "utf8",
  );

  const { executeWorkflowModule, inspectWorkflowModule } = await import(
    pathToFileURL(path.join(root, "apps/meka/dist/workflow-runtime.js"))
  );
  assert.deepEqual(await inspectWorkflowModule(workflowPath), {
    id: "built-workflow-smoke",
    on: ["built.smoke"],
  });

  const execution = await executeWorkflowModule({
    filePath: workflowPath,
    cwd: directory,
    identity: {
      id: "built-workflow-smoke",
      on: ["built.smoke"],
      revision: "1",
      hash: "built-smoke",
    },
    event: {
      id: "event-built-smoke",
      type: "built.smoke",
      source: "check:dist",
      observedAt: new Date().toISOString(),
      verified: true,
      payload: {},
    },
    services: {
      enqueueJob: unexpectedHostCall,
      readJob: unexpectedHostCall,
      cancelJob: unexpectedHostCall,
      enqueueRun: unexpectedHostCall,
    },
  });
  assert.deepEqual(execution.result, {
    _tag: "completed",
    workflow: {
      id: "built-workflow-smoke",
      revision: "1",
      hash: "built-smoke",
    },
    eventId: "event-built-smoke",
    decision: { _tag: "completed", output: "built-ok" },
  });
  process.stdout.write("Built workspace workflow runtime check passed.\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function unexpectedHostCall() {
  throw new Error("Built workflow smoke test unexpectedly called a host service");
}
