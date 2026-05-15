---
title: Dispatch and replay events
description: Choose local or HTTP mode and understand idempotency, replay, and state.
---

# Dispatch and replay events

Use `@peezy.tech/flow-runtime/client` when product code should not care whether
execution is local or delegated to a backend.

## Select execution mode

```ts
import { createFlowClient } from "@peezy.tech/flow-runtime/client";

const flows = createFlowClient({
  mode: "local",
  cwd: process.cwd(),
});
```

```ts
const flows = createFlowClient({
  mode: "http",
  baseUrl: process.env.CODEX_FLOW_BACKEND_URL,
  bearerToken: process.env.CODEX_FLOW_BACKEND_TOKEN,
});
```

## Dispatch

```ts
await flows.dispatchEvent(event);
```

The client normalizes dispatch results into event ids, run ids, matched count,
run views, and raw backend or local data.

## Replay

```ts
await flows.replayEvent(event.id);
```

Replay starts a new attempt for a stored event. HTTP backends provide durable
replay. Local replay requires memory or file state; disabled local state fails
with a clear unsupported-state error.

## Inspect

```ts
const eventView = await flows.getEvent(event.id);
const { runs } = await flows.listRuns({ status: "blocked", limit: 20 });
```

Use `effectiveStatus` and `needsAttention` for user-facing triage. They combine
backend process status with semantic `FLOW_RESULT.status`.
