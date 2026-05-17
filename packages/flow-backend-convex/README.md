# @peezy.tech/flow-backend-convex

Reusable Convex backend primitives for `codex-flows`.

This package is the extracted version of the backend shape proven in
`2d-codex-pet-game`: Convex stores generic flow events, matching runs, run
attempts, leases, results, and compact output events. Process-heavy execution
still happens in an external worker that claims runs and executes `flow.toml`
steps through `@peezy.tech/codex-flows/flow-runtime`.

## Component Boundary

The component owns generic flow state only:

- synced flow manifests
- accepted `FlowEvent` records
- queued/running/completed/failed/canceled run records
- leased run attempts
- structured output events
- final result payloads

Installing apps own authentication and domain state. An app should expose
service-authenticated wrapper functions for external workers, then call this
component from those wrappers. Domain-specific completion, such as generated
asset registration or minting, should stay in app code.

## Component Install

```ts
// convex/convex.config.ts
import flowBackend from "@peezy.tech/flow-backend-convex/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(flowBackend);

export default app;
```

The app wrapper functions can call the installed component functions through
`components.flowBackend`. The worker-facing API should stay app-owned so each
deployment can enforce its own service secret, identity, or ACL.

## Current Transcript Strategy

The first component stores output chunks in `flowOutputEvents`. A future version
can add `@convex-dev/persistent-text-streaming` as a child component and map
each run attempt to a durable transcript stream. The canonical control state
should remain in this component's tables either way.
