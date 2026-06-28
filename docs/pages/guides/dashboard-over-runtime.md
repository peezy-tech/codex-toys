---
title: Dashboard Over Runtime
description: Build a browser dashboard backed by the codex-toys runtime HTTP edge and workspace functions.
---

# Dashboard Over Runtime

A dashboard over runtime is a browser UI that talks to `codex-toys runtime http`.
The HTTP edge forwards generic app, workbench, and function calls to the same
runtime used by CLI and SSH operation. It does not create a separate durable
dashboard surface or custom thread registry.

## Serve Static Files

```bash
codex-toys runtime http --cwd . --static ./dashboard
```

The dashboard can call same-origin `/api/*` routes:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/app/:method
POST /api/workbench/:method
POST /api/workbench/overview
```

## Browser Client

```ts
import { createCodexToysBrowserClient } from "codex-toys/runtime";

const codexToys = createCodexToysBrowserClient();
const overview = await codexToys.workbench.call("workbench.overview", {});
const threads = await codexToys.app.call("thread/list", {
  limit: 20,
  sourceKinds: [],
});
const functions = await codexToys.functions.list();
```

Prefer workspace functions for product-specific data. They keep dashboard
semantics in the workspace instead of baking product routes into codex-toys.

## Vite Middleware

```ts
import { codexToysRuntime } from "codex-toys/runtime";

export default {
  plugins: [
    codexToysRuntime({
      cwd: ".",
    }),
  ],
};
```

The Vite plugin serves the runtime API under `/__codex_toys/api`. Point the
browser client at that base path:

```ts
const codexToys = createCodexToysBrowserClient({
  basePath: "/__codex_toys/api",
});
```

## Remote Runtime Without Remote HTTP

Run the HTTP edge locally and connect it to a remote runtime over SSH:

```bash
codex-toys runtime http \
  --ssh workbox \
  --cwd /srv/codex/workspaces/ops \
  --static ./dashboard
```

The browser talks to localhost. The remote host exposes no HTTP port.

## Boundary

The runtime HTTP edge owns transport, schema discovery, browser helpers, and
forwarding. The workspace owns dashboard data through functions. Native Codex
owns thread creation, thread opening, archive/delete, and app UI updates.
