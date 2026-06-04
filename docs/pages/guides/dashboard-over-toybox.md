---
title: Dashboard Over Toybox
description: Build a browser dashboard backed by the codex-toys proxy and workbench functions.
---

# Dashboard Over Toybox

A dashboard over toybox is a browser UI that talks to the optional
`codex-toys-proxy` HTTP edge. The proxy forwards generic app and workbench calls
to the toybox. It does not create a separate product API model.

Use this guide when a workbench needs an inspectable browser surface for status,
functions, queues, feed state, or operator actions.

## 1. Start With Overview

The default workbench snapshot is usually enough for a first dashboard:

```bash
codex-toys workbench overview --json
```

Serve static dashboard files through the proxy:

```bash
codex-toys-proxy serve --cwd . --static ./dashboard
```

The dashboard can call:

```text
GET  /api/status
GET  /api/schema
POST /api/workbench/overview
POST /api/workbench/functions.list
POST /api/workbench/functions.call
```

## 2. Use the Browser Client

In browser code:

```ts
import { createCodexToysBrowserClient } from "codex-toys/proxy/browser";

const codexToys = createCodexToysBrowserClient();
const schema = await codexToys.schema();
const overview = await codexToys.workbench.call("workbench.overview");
const functions = await codexToys.functions.list();
const snapshot = await codexToys.functions.call("statusSnapshot");
```

For a Vite dev server, use the Vite plugin:

```ts
import { codexToysRemote } from "codex-toys/proxy/vite";

export default {
  plugins: [
    codexToysRemote({
      cwd: process.cwd()
    })
  ]
};
```

The Vite plugin serves the proxy under `/__codex_toys/api`. Point the browser
client at that base path:

```ts
const codexToys = createCodexToysBrowserClient({
  basePath: "/__codex_toys/api"
});
```

## 3. Add Narrow Workbench Functions

Create `.codex/functions.ts` when the dashboard needs data not already present
in `workbench.overview`:

```ts
export default {
  statusSnapshot: {
    description: "Read a compact status snapshot.",
    sideEffects: "read-only",
    handler: async () => {
      return {
        status: "ok",
        updatedAt: new Date().toISOString()
      };
    }
  }
};
```

Keep functions JSON-in and JSON-out. Return plain JSON values. Avoid streams,
class instances, circular objects, BigInts, secrets, broad filesystem dumps, and
arbitrary shell execution.

Use side effects accurately:

```text
none
read-only
writes-local
external-write
```

Dashboard code should treat `writes-local` and `external-write` functions as
explicit actions, not background refresh calls.

## 4. Use a Remote Workbench Without Remote HTTP

Run the proxy locally and connect it to a remote toybox over SSH:

```bash
codex-toys-proxy serve \
  --ssh workbox \
  --cwd /srv/codex/workbenches/ops \
  --static ./dashboard
```

Or configure Vite:

```ts
import { codexToysRemote } from "codex-toys/proxy/vite";

export default {
  plugins: [
    codexToysRemote({
      ssh: "workbox",
      cwd: "/srv/codex/workbenches/ops"
    })
  ]
};
```

The browser talks to localhost. The remote host exposes no HTTP port.

## Boundary

The proxy owns HTTP transport, schema discovery, browser helpers, and forwarding
to app or workbench methods. The workbench owns functions and overview data. The
product dashboard owns layout, refresh cadence, action confirmation, and domain
policy.
