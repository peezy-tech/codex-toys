---
title: Packages
description: Public packages in the codex-toys stack.
---

# Packages

## `codex-toys`

Codex app-server client package, workspace automation package, and CLI bundle.
It exports:

- app-server JSON-RPC client and stdio transport
- local and SSH stdio toybox helpers
- turn automation helpers for pre-turn scripts that can skip or start native
  Codex turns
- workspace functions under `codex-toys/functions`
- generic HTTP proxy helpers under `codex-toys/proxy`
- Vite middleware under `codex-toys/vite`
- browser fetch helpers under `codex-toys/browser`
- auth helpers for account login/status/usage
- workspace autonomy helpers
- memory transplant helpers under `codex-toys/memories`
- workbench reducers and request descriptors
- thread rollout locate, inspect, install, and transplant helpers under
  `codex-toys/threads`
- generated Codex app-server protocol types
- the `codex-toys` CLI
- the optional `codex-toys-proxy` HTTP edge

The package is the canonical core install target. It keeps the core transport
surface Codex-native: local stdio and SSH stdio. Browser dashboards opt into
HTTP by running the separate proxy.

## `codex-toys/proxy`

The proxy package exposes a generic HTTP handler for dashboards:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/app/:method
POST /api/workspace/:method
```

The proxy starts or connects to a codex-toys toybox internally. `/api/schema`
comes from `toybox.initialize`, so dashboards can discover available
workspace methods without duplicated route definitions.

For direct browser use, the proxy reflects CORS only for loopback origins such
as `localhost`, `127.0.0.1`, `::1`, and `*.localhost`. Requests carrying a
non-loopback browser `Origin` are rejected. Dashboards served by Vite or
`codex-toys-proxy --static` can use same-origin requests instead.

## `codex-toys/browser`

The browser export is fetch-only. It provides helpers for the proxy API:

```ts
import { codexToys } from "codex-toys/browser";

const schema = await codexToys.schema();
const threads = await codexToys.app.call("thread/list", { limit: 20 });
const functions = await codexToys.functions.list();
```

It does not include a browser app-server client or WebSocket transport.

## `codex-toys/functions`

Workspace functions expose named JSON-in/JSON-out capabilities from a workspace
manifest at `.codex/functions.ts`, `.codex/functions.js`, or
`.codex/functions.mjs`.

```ts
export default {
  portfolioSnapshot: {
    description: "Read the latest portfolio snapshot.",
    sideEffects: "read-only",
    handler: async () => ({ positions: [], cash: 0 }),
  },
};
```

The CLI, toybox, proxy, Vite plugin, MCP server, and browser fetch helpers use
the same `functions.list`, `functions.describe`, and `functions.call` workspace
methods.

## `codex-toys/vite`

`codexToysRemote` mounts the generic proxy handler inside Vite:

```ts
import { codexToysRemote } from "codex-toys/vite";

export default {
  plugins: [
    codexToysRemote({
      ssh: process.env.CODEX_TOYS_REMOTE_SSH_TARGET,
      cwd: process.env.CODEX_TOYS_REMOTE_CWD,
    }),
  ],
};
```

Dashboard code can use `codexToys` from
`codex-toys/browser` and call `/__codex_toys/api/*` through
Vite.

## `codex-toys/actions`

Actions helpers encode Codex workspace conventions for CI and local
Actions-mode simulation:

- `repoCodexHome(workspaceRoot)` returns `<repo>/.codex`
- `prepareActionsCodexAuth` writes `.codex/auth.json` from
  `CODEX_AUTH_JSON_B64`, `CODEX_AUTH_JSON`, or `OPENAI_API_KEY`
- `cleanupActionsCodexHome` removes runtime-only auth, temp dirs, and SQLite
  databases without deleting durable memory markdown,
  `.codex/workspace/actions`, or `.codex/sessions` rollout files

## `codex-toys/memories`

The memory transplant helpers operate on stable markdown artifacts only:

- `MEMORY.md`
- `memory_summary.md`
- `memories/raw_memories.md`
- `memories/rollout_summaries/*.md`

The helpers do not require or inspect Codex memory SQLite internals.

## `codex-toys/threads`

Thread transplant helpers locate, inspect, install, and transplant raw Codex
rollout JSONL files. They preserve raw rollout bytes and thread ids; they do
not reconstruct history, rewrite ids, or call app-server import APIs.
