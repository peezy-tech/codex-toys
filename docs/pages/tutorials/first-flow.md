---
title: Build your first flow
description: Create a minimal Node-backed flow package and run it locally.
---

# Build your first flow

This tutorial creates a flow package that handles a `demo.hello` event and
returns a `FlowResult`.

## 1. Create the files

Flow packages live under `flows/*` while installed copies can live under
`.codex/flows/*`. Create this structure:

```text
flows/hello-flow/
  flow.toml
  schemas/hello.schema.json
  exec/hello.ts
```

## 2. Write the manifest

```toml
name = "hello-flow"
version = 1
description = "Greets a person from a demo event."

[[steps]]
name = "hello"
runner = "node"
script = "exec/hello.ts"
timeout_ms = 30000

[steps.trigger]
type = "demo.hello"
schema = "schemas/hello.schema.json"
```

## 3. Add the event schema

```json
{
  "type": "object",
  "required": ["name"],
  "properties": {
    "name": { "type": "string" }
  }
}
```

## 4. Implement the step

```ts
import { defineNodeFlow } from "@peezy.tech/codex-flows/flow-runtime/node";

export default defineNodeFlow(async (ctx) => {
  const name = ctx.flow.event.payload.name;
  return {
    status: "completed",
    message: `hello ${name}`,
  };
});
```

The runner still preserves the stdin plus `FLOW_RESULT` ABI for raw scripts, but
module-style steps can return the result object directly.

## 5. Fire the event

Create `event.json`:

```json
{
  "id": "demo:hello:ada",
  "type": "demo.hello",
  "source": "tutorial",
  "receivedAt": "2026-05-15T00:00:00.000Z",
  "payload": {
    "name": "Ada"
  }
}
```

Run all matching steps:

```bash
codex-flow-runner fire --event event.json
```

You should see the event id and one result for `hello-flow/hello`.
