---
title: Run flows locally
description: Use the CLI or local client to discover, match, and execute flow steps.
---

# Run flows locally

Local execution is the simplest path for development and product CLIs. It uses
the same `FlowEvent` and `FLOW_RESULT` contract as backend execution.

## List flows

```bash
bun run flow list
```

Discovery order is:

1. `.codex/flows/*`
2. `flows/*`

The installed `.codex` copy wins when both locations contain a flow with the
same name.

## Fire matching steps

```bash
bun run flow fire --event event.json
```

`fire` dispatches the event through the local flow client and preserves the
existing CLI payload shape:

```json
{
  "eventId": "demo:hello:ada",
  "results": [
    {
      "flow": "hello-flow",
      "step": "hello",
      "result": { "status": "completed" }
    }
  ]
}
```

## Run one explicit step

```bash
bun run flow run hello-flow hello --event event.json
```

Use explicit `run` when you are debugging one step and do not want trigger
matching to select other steps.

## Use the local client

```ts
import { createLocalFlowClient } from "@peezy.tech/flow-runtime/local-client";

const flows = createLocalFlowClient({
  cwd: process.cwd(),
  state: { kind: "file" },
});
```

The local client runs synchronously. `wait: false` is intentionally unsupported
until a worker loop exists.
