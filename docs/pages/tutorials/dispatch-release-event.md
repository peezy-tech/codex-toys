---
title: Dispatch a release event
description: Use the shared flow client to trigger release automation from product code.
---

# Dispatch a release event

This tutorial shows the product-facing path: build a deterministic event, select
local or HTTP execution, and dispatch it through the same flow client.

## 1. Build a deterministic event

Products own event ids. Use a stable id when duplicate suppression matters:

```ts
const event = {
  id: "patch:upstream.release:openai/codex:rust-v1.2.3",
  type: "upstream.release",
  source: "patch",
  receivedAt: new Date().toISOString(),
  payload: {
    repo: "openai/codex",
    tag: "rust-v1.2.3",
  },
};
```

Normal dispatch is idempotent by `event.id`. Replays intentionally create a new
attempt for the stored event.

## 2. Dispatch locally during CLI work

```ts
import { createFlowClient } from "@peezy.tech/flow-runtime/client";

const flows = createFlowClient({
  mode: "local",
  cwd: process.cwd(),
});

await flows.dispatchEvent(event);
```

Local mode discovers `.codex/flows/*` before `flows/*`, executes matching steps
synchronously, and keeps in-memory state by default. Use
`state: { kind: "file" }` when local ids and replay need to survive process
restart.

## 3. Dispatch to an HTTP backend in service mode

```ts
const flows = createFlowClient({
  mode: "http",
  baseUrl: "http://127.0.0.1:7345",
  hmacSecret: process.env.PATCH_FLOW_DISPATCH_SECRET,
});

await flows.dispatchEvent(event);
```

HTTP mode speaks the backend `/events`, `/runs`, replay, and cancel surface.
It inherits the backend's durable idempotency and run history.

## 4. Inspect the result

```ts
const flowEvent = await flows.getEvent(event.id);
const runs = await flows.listRuns({ eventId: event.id });
```

Run views include process status, semantic `FLOW_RESULT` status,
`effectiveStatus`, attention flags, attempts, output, and result payloads.
