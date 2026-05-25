---
title: Architecture
description: How events, clients, runtimes, backends, workers, and apps fit together.
---

# Architecture

codex-flows separates pre-turn prompt automation, durable event automation, and
product completion.

For plugin-native prompt automation, code runs before a Codex turn:

```mermaid
sequenceDiagram
  participant Signal as Event, schedule, hook, or operator
  participant Script as Pre-turn script
  participant Codex as Codex app-server

  Signal->>Script: JSON context
  Script-->>Signal: skip
  Script-->>Codex: turn decision with prompt/cwd/settings
  Codex-->>Codex: native turn uses normal tools and skills
```

For durable event automation, the flow runtime preserves event/run state:

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
- synchronously through `@peezy.tech/codex-flows/flow-runtime/local-client`
- through the workspace backend's local flow capability
- through a Convex control plane plus an external worker
- through any app-owned backend adapter that preserves the event/result ABI

The important invariant is that the generic layer owns flow state, not product
meaning. A `blocked` result can be surfaced by the backend, but the app decides
what blocked means and how to resolve it.
