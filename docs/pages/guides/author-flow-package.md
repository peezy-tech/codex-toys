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

## Bun steps

Use `runner = "bun"` when the step should run host automation directly under
the flow runner. Bun steps receive the same JSON context on stdin and must print
exactly one `FLOW_RESULT <json>` line to stdout. Use stderr for progress logs
that should not be parsed as the result.

```ts
const context = JSON.parse(await Bun.stdin.text());

function result(value: Record<string, unknown>): never {
  process.stdout.write(`FLOW_RESULT ${JSON.stringify(value)}\n`);
  process.exit(0);
}

try {
  result({
    status: "completed",
    artifacts: {
      eventId: context.flow.event.id,
    },
  });
} catch (error) {
  result({
    status: "failed",
    message: error instanceof Error ? error.message : String(error),
  });
}
```

Bun steps should treat `event.id` as the idempotency key, read secret names from
flow or backend config instead of hardcoding values, and return
`needs_intervention` when a human or Codex turn must continue from preserved
external state.

## Code Mode steps

Prefer Node or Bun steps for portable flow packages. `runner = "code-mode"` is
for flows that deliberately execute through a Codex app-server with Code Mode
enabled, usually in a workspace that owns a compatible Codex fork or feature
flag.

The runner injects `flow` and `result(value)` before the `.code-mode.js` body,
executes the snippet through raw `thread/codeMode/execute`, and converts the
single `result(...)` call to `FLOW_RESULT`.

```js
text("starting");

const status = await tools.exec_command({
  cmd: "git status --short",
  workdir: flow.cwd,
  yield_time_ms: 1000,
  max_output_tokens: 4000,
});

result({
  status: "completed",
  artifacts: { status },
});
```

Code Mode availability should be selected by runtime or backend flags, not by a
separate flow branch. Use `tools.exec_command` for host actions, pass `workdir`
explicitly when touching repositories, and do not assume generated client types
include fork-only app-server methods. Prefer `CODEX_FLOWS_MODE=code-mode` when
the environment should both enable Code Mode flow steps and select the Peezy
Codex fork package; `CODEX_FLOWS_ENABLE_CODE_MODE=1` only gates Code Mode runner
availability.

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
