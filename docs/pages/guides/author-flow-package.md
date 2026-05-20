---
title: Author a flow package
description: Structure a reusable flow package with triggers, schemas, and steps.
---

# Author a flow package

Use a flow package when automation should be reusable across products or
backends. A package is just a manifest, schemas, and executable step files.

## Layout

```text
flow.toml
schemas/*.schema.json
exec/*
```

Source packages live under `flows/*`. Installed packages can live under
`.codex/flows/*`; installed copies take precedence so a workspace can override
or pin a flow without editing source packages.

## Manifest

```toml
name = "example-flow"
version = 1
description = "Short operational purpose."

[config]
commit = true

[[steps]]
name = "do-work"
runner = "node"
script = "exec/do-work.ts"
timeout_ms = 300000

[steps.trigger]
type = "upstream.release"
schema = "schemas/upstream-release.schema.json"
```

Keep event payload shape in JSON Schema. Product-specific payload fields belong
in the schema and event payload, not in the generic runner.

## Step input

Node steps receive a JSON context. The raw ABI is still JSON on stdin, and the
recommended authoring shape is a module default export that receives the same
context as its first argument:

```json
{
  "flow": {
    "name": "example-flow",
    "version": 1,
    "root": "/repo/flows/example-flow",
    "step": "do-work",
    "config": {},
    "event": {}
  },
  "runtime": {
    "eventId": "event-1",
    "runId": "run_123",
    "attemptId": "run_123",
    "replay": false,
    "workspaceBackendUrl": "ws://127.0.0.1:3586"
  }
}
```

`runtime.workspaceBackendUrl` is set by the local workspace backend when it
launches a run. Trusted Node steps can use it to call back into the same
workspace backend and its app-server pass-through.

## Step output

Module-style steps return a `FlowResult`:

```ts
import { defineNodeFlow } from "@peezy.tech/codex-flows/flow-runtime/node";

export default defineNodeFlow(async (ctx) => {
  return {
    status: "completed",
    message: `handled ${ctx.flow.event.id}`,
  };
});
```

The runner still supports raw scripts that read stdin and print a final
`FLOW_RESULT` line:

```ts
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const ctx = JSON.parse(Buffer.concat(chunks).toString("utf8"));

  console.log(`FLOW_RESULT ${JSON.stringify({
    status: "completed",
    message: `handled ${ctx.flow.event.id}`,
  })}`);
}

void main();
```

Use `blocked` or `needs_intervention` when a human or external condition is
required. Clients and backends mark those statuses as needing attention.

## Calling Codex from Node

Node orchestration can start or continue Codex threads through the same workspace
backend that launched the flow run:

```ts
import {
  createCodexFlowClientFromContext,
  defineNodeFlow,
} from "@peezy.tech/codex-flows/flow-runtime/node";

export default defineNodeFlow(async (ctx) => {
  const codex = createCodexFlowClientFromContext(ctx);
  try {
    const result = await codex.startFlow({
      threadId: typeof ctx.flow.event.payload.threadId === "string"
        ? ctx.flow.event.payload.threadId
        : undefined,
      prompt: "Continue the workspace task from this flow event.",
      wait: { timeoutMs: 120000 },
    });

    return {
      status: "needs_intervention",
      message: "Codex turn started.",
      artifacts: {
        threadId: result.threadId,
        turnId: result.turnId,
        completed: Boolean(result.completedTurn),
      },
    };
  } finally {
    codex.close();
  }
});
```

Use `wait: false` or omit `wait` for fire-and-record orchestration. Use
`wait: true` or wait options when the step should block until the turn reaches
a terminal state. The thread id belongs in the event payload, flow config, or
step logic; the generic runner does not invent one.
