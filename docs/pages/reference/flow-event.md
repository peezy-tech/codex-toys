---
title: FlowEvent and FLOW_RESULT
description: Stable event and result contracts shared by local and backend execution.
---

# FlowEvent and FLOW_RESULT

`FlowEvent` is the ABI between products, clients, backends, and flow packages.

```ts
type FlowEvent<T = unknown> = {
  id: string;
  type: string;
  source?: string;
  occurredAt?: string;
  receivedAt: string;
  payload: T;
};
```

## Fields

| Field | Required | Meaning |
|-------|----------|---------|
| `id` | Yes | Caller-owned idempotency key. Use deterministic ids for duplicate suppression. |
| `type` | Yes | Trigger type matched by `flow.toml`. |
| `source` | No | Product or subsystem that emitted the event. |
| `occurredAt` | No | When the domain event happened. |
| `receivedAt` | Yes | When the flow system accepted the event. |
| `payload` | Yes | Domain payload validated by each step schema. |

## Result status

Steps print one final line:

```text
FLOW_RESULT {"status":"completed","message":"done"}
```

Known semantic statuses:

| Status | Meaning |
|--------|---------|
| `skipped` | Step intentionally did no work. |
| `completed` | Step completed without durable changes or with expected work done. |
| `changed` | Step completed and changed state. |
| `needs_intervention` | A human decision or action is needed. |
| `blocked` | External state blocks progress. |
| `failed` | Step failed semantically even if the process exited cleanly. |

Backends also track process status such as `queued`, `running`, `completed`,
`failed`, and `canceled`. Clients expose `effectiveStatus` and
`needsAttention` to combine process and semantic result state.
