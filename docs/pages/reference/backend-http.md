---
title: Backend HTTP API
description: Endpoints used by the workspace flow HTTP surface and compatible flow backends.
---

# Backend HTTP API

HTTP backends accept generic `FlowEvent` objects and expose stored event and run
state. In the local workspace backend, these routes are an optional networked
surface over the built-in flow capability.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/events` | Accept one `FlowEvent`. |
| `POST` | `/flow-events` | Compatibility alias for event dispatch. |
| `GET` | `/events?limit=<n>` | List stored events. |
| `GET` | `/events/<event-id>` | Inspect one event and its runs. |
| `POST` | `/events/<event-id>/replay` | Start a new attempt for a stored event. |
| `GET` | `/runs?eventId=<id>&status=<status>&limit=<n>` | List runs. |
| `GET` | `/runs/<run-id>` | Inspect one run. |
| `POST` | `/runs/<run-id>/cancel` | Cancel when supported by the backend. |
| `GET` | `/healthz` | Health check. |

## Signing

When the backend has a shared secret, sign the exact JSON body with HMAC
SHA-256 and send:

```text
x-flow-signature-256: sha256=<hex digest>
```

`x-patch-flow-signature-256` remains accepted by the local workspace backend for
older Patch dispatchers.

## Compatibility

`@peezy.tech/flow-runtime/backend-client` normalizes compatible backend
responses into the shared flow view model. Convex deployments should expose an
app-owned HTTP adapter if they need generic HTTP inspection.
