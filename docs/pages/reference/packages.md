---
title: Packages
description: Public packages in the codex-flows stack.
---

# Packages

## `@peezy.tech/codex-flows`

Codex app-server client package, workspace automation package, and CLI bundle.
It exports:

- app-server JSON-RPC client and stdio transport
- local and SSH stdio agent helpers
- turn automation helpers for pre-turn scripts that can skip or start native
  Codex turns
- workspace functions under `@peezy.tech/codex-flows/functions`
- generic HTTP proxy helpers under `@peezy.tech/codex-flows/proxy`
- Vite middleware under `@peezy.tech/codex-flows/vite`
- browser fetch helpers under `@peezy.tech/codex-flows/browser`
- auth helpers for account login/status/usage
- workspace autonomy helpers
- memory transplant helpers under `@peezy.tech/codex-flows/memories`
- workbench reducers and request descriptors
- thread rollout locate, inspect, install, and transplant helpers under
  `@peezy.tech/codex-flows/threads`
- generated Codex app-server protocol types
- the `codex-flows` CLI
- the optional `codex-flows-proxy` HTTP edge

The package is the canonical core install target. It keeps the core transport
surface Codex-native: local stdio and SSH stdio. Browser dashboards opt into
HTTP by running the separate proxy.

## `@peezy.tech/codex-flows/proxy`

The proxy package exposes a generic HTTP handler for dashboards:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/app/:method
POST /api/workspace/:method
```

The proxy starts or connects to a codex-flows agent internally. `/api/schema`
comes from `workspace.initialize`, so dashboards can discover available
workspace methods without duplicated route definitions.

For direct browser use, the proxy reflects CORS only for loopback origins such
as `localhost`, `127.0.0.1`, `::1`, and `*.localhost`. Requests carrying a
non-loopback browser `Origin` are rejected. Dashboards served by Vite or
`codex-flows-proxy --static` can use same-origin requests instead.

## `@peezy.tech/codex-flows/browser`

The browser export is fetch-only. It provides helpers for the proxy API:

```ts
import { codexFlows } from "@peezy.tech/codex-flows/browser";

const schema = await codexFlows.schema();
const threads = await codexFlows.app.call("thread/list", { limit: 20 });
const functions = await codexFlows.functions.list();
```

It does not include a browser app-server client or WebSocket transport.

## `@peezy.tech/codex-flows/functions`

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

The CLI, agent, proxy, Vite plugin, MCP server, and browser fetch helpers use
the same `functions.list`, `functions.describe`, and `functions.call` workspace
methods.

## `@peezy.tech/codex-flows/vite`

`codexFlowsRemote` mounts the generic proxy handler inside Vite:

```ts
import { codexFlowsRemote } from "@peezy.tech/codex-flows/vite";

export default {
  plugins: [
    codexFlowsRemote({
      ssh: process.env.CODEX_FLOWS_REMOTE_SSH_TARGET,
      cwd: process.env.CODEX_FLOWS_REMOTE_CWD,
    }),
  ],
};
```

Dashboard code can use `codexFlows` from
`@peezy.tech/codex-flows/browser` and call `/__codex_flows/api/*` through
Vite.

## `@peezy.tech/codex-flows/actions`

Actions helpers encode Codex workspace conventions for CI and local
Actions-mode simulation:

- `repoCodexHome(workspaceRoot)` returns `<repo>/.codex`
- `prepareActionsCodexAuth` writes `.codex/auth.json` from
  `CODEX_AUTH_JSON_B64`, `CODEX_AUTH_JSON`, or `OPENAI_API_KEY`
- `cleanupActionsCodexHome` removes runtime-only auth, sessions, temp dirs, and
  SQLite databases without deleting durable memory markdown or
  `.codex/workspace/actions`

## `@peezy.tech/codex-flows/memories`

The memory transplant helpers operate on stable markdown artifacts only:

- `MEMORY.md`
- `memory_summary.md`
- `memories/raw_memories.md`
- `memories/rollout_summaries/*.md`

The helpers do not require or inspect Codex memory SQLite internals.

## `@peezy.tech/codex-flows/threads`

Thread transplant helpers locate, inspect, install, and transplant raw Codex
rollout JSONL files. They preserve raw rollout bytes and thread ids; they do
not reconstruct history, rewrite ids, or call app-server import APIs.
