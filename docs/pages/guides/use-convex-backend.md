---
title: Use the Convex backend
description: Install the generic Convex control plane and keep execution in app-owned workers.
---

# Use the Convex backend

`@peezy.tech/flow-backend-convex` is a durable control-plane component. It
stores generic events, runs, attempts, leases, output chunks, and final result
payloads. It does not execute shell, Bun, Git, Cargo, or Codex work.

## Install the component

```ts
// convex/convex.config.ts
import flowBackend from "@peezy.tech/flow-backend-convex/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(flowBackend);

export default app;
```

## Add app-owned wrappers

Expose service-authenticated wrapper functions from your app. Those wrappers
call the installed component through `components.flowBackend`.

Keep authentication, tenancy, billing, and product-specific policy in the app
wrapper. The generic component should not know about game assets, payments,
minting, Patch fork policy, or organization release rules.

## Run an external worker

The worker should:

1. Sync or provide flow manifests.
2. Claim a queued run.
3. Heartbeat while it works.
4. Execute the matching step with `@peezy.tech/codex-flows/flow-runtime`.
5. Apply app-owned domain completion if needed.
6. Complete or fail the generic run.

This keeps Convex durable and queryable while process-heavy work runs on
infrastructure that can run Codex and local system tools.
