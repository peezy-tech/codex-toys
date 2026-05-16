---
title: Architecture
description: How events, clients, runtimes, backends, workers, and apps fit together.
---

# Architecture

codex-flow separates event semantics, execution, and product completion.

```mermaid
sequenceDiagram
  participant App as Product app
  participant Client as Flow client
  participant Backend as Backend or local runtime
  participant Step as Flow step
  participant Domain as App completion

  App->>Client: dispatchEvent(FlowEvent)
  Client->>Backend: local match or HTTP POST /events
  Backend->>Step: runner context
  Step-->>Backend: FlowResult or FLOW_RESULT
  Backend-->>Client: run/event views
  Backend-->>Domain: app-owned worker or wrapper applies product effects
```

The same flow package can run:

- directly through `codex-flow-runner`
- synchronously through `@peezy.tech/flow-runtime/local-client`
- through the workspace backend's local flow capability
- through a Convex control plane plus an external worker
- through any app-owned backend adapter that preserves the event/result ABI

The important invariant is that the generic layer owns flow state, not product
meaning. A `blocked` result can be surfaced by the backend, but the app decides
what blocked means and how to resolve it.
