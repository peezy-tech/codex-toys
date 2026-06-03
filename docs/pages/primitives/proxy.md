---
title: Proxy
description: Optional HTTP edge for browser dashboards backed by toybox methods.
---

# Proxy

`codex-toys-proxy` is the optional HTTP edge for browser dashboards. Core
codex-toys commands stay stdio-first; the proxy is explicit.

```bash
codex-toys-proxy serve --cwd <workbench> --static ./dashboard
codex-toys-proxy serve --ssh <target> --cwd <remote-workbench> --static ./dashboard
```

## Routes

The proxy exposes generic routes:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/host/overview
POST /api/app/:method
POST /api/workbench/:method
POST /api/workbench/overview
```

`/api/schema` is derived from `toybox.initialize`. Dashboards should discover
method names and metadata instead of hard-coding duplicate product routes.

`POST /api/workbench/overview` calls the `workbench.overview` method.
`POST /api/host/overview` calls the `host.overview` method.

## Browser Client

```ts
import { createCodexToysBrowserClient } from "codex-toys/proxy/browser";

const codexToys = createCodexToysBrowserClient();
const schema = await codexToys.schema();
const overview = await codexToys.workbench.overview();
const threads = await codexToys.app.call("thread/list", { limit: 20 });
```

The browser client talks to the proxy with `fetch`; it does not include a direct
app-server client or WebSocket transport.

## CORS

Direct browser calls to the proxy API receive CORS headers only for loopback
origins such as `localhost`, `127.0.0.1`, `::1`, and `*.localhost`. Prefer the
Vite plugin or `--static` same-origin serving for local dashboards.

## Vite

`codex-toys/proxy/vite` provides middleware for local dashboards that want the
same proxy routes during development.

The proxy remains an edge over the toybox. It does not own workflow semantics,
queue semantics, product routing, or domain decisions.
