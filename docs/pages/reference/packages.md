---
title: Package API
description: Public codex-toys package imports and internal workspace boundaries.
---

# Packages

Install `codex-toys` for both the CLI and runtime APIs. The repo keeps internal
`@codex-toys/*` workspaces for feature boundaries, but those packages are
bundled into the public tarball rather than published separately. Public
consumer imports use `codex-toys/*` subpaths.

## `codex-toys/bridge`

Native Codex bridge primitives:

- app-server client and stdio transport
- JSON-RPC parsing and error helpers
- generated app-server protocol types
- auth status, login, and usage helpers
- durable memory artifact and memory transplant helpers
- thread rollout locate, inspect, install, and transplant helpers

Useful exports include `CodexAppServerClient`, `CodexStdioTransport`,
`createCodexAuthClient`, `locateThreadRollout`,
`sanitizeWorkbenchMemoryArtifacts`, `JsonRpcError`, and `v2`.

Subpath exports are available for focused imports:

```ts
import { CodexAppServerClient } from "codex-toys/bridge";
import { v2 } from "codex-toys/bridge/generated";
import { parseJsonText } from "codex-toys/bridge/json";
```

## `codex-toys/toybox`

Toybox JSON-RPC protocol, client, and server primitives. This package owns the
stdio protocol used by local and SSH-backed toyboxes, including
`toybox.initialize`, app-server pass-through, event forwarding, and method
metadata.

Use it when another process needs to host or call a codex-toys toybox directly.

## `codex-toys/feed`

Durable external feed intake helpers:

- `.codex/feed.toml` source config
- RSS/Atom polling and normalization
- source checkpoints such as ETag and Last-Modified
- durable feed item storage under `.codex/feed/<mode>/items`
- named collection cursors for consumers such as dashboards or automations
- pruning and doctor helpers
- `feed.*` toybox method factories and metadata

Feed reads `.codex/feed.toml`, writes local runtime state under
`.codex/feed/local`, and writes Actions-mode state under `.codex/feed/actions`
only when explicitly run in Actions mode. It does not create Codex turns,
deferred prompts, or product-specific actions by itself.

```ts
import {
  collectFeedItems,
  createFeedContext,
  loadFeedConfig,
  pollFeedSources,
} from "codex-toys/feed";

const context = await createFeedContext({ root: "/repo", mode: "local" });
const config = await loadFeedConfig(context);
await pollFeedSources(context, config);
const batch = await collectFeedItems(context, { cursor: "radar" });
```

## `codex-toys/workbench`

Workbench runtime and policy helpers:

- workbench doctor, tick, and task execution
- prompt queue, handoff queue, deferred run queue, and delegation methods
- workbench functions loaded from `.codex/functions.ts`, `.js`, or `.mjs`
- turn automation script execution and remote automation methods
- workbench and host overview methods
- transport-neutral thread UX reducers and app-server request descriptors

Workbench autonomy reads `.codex/workbench.toml`, writes local runtime state
under `.codex/workbench/local`, and writes CI runtime state under
`.codex/workbench/actions`.

## `codex-toys/actions`

Actions-mode helpers for GitHub or Forgejo runners:

- `repoCodexHome(workbenchRoot)` returns `<repo>/.codex`
- `prepareActionsCodexAuth` writes `.codex/auth.json` from
  `CODEX_AUTH_JSON_B64`, `CODEX_AUTH_JSON`, or `OPENAI_API_KEY`
- `cleanupActionsCodexHome` removes runtime-only auth, temp dirs, and SQLite
  databases without deleting durable memory markdown,
  `.codex/workbench/actions`, or `.codex/sessions`

## `codex-toys/remote`

SSH-backed transport and remote helper package. It creates a toybox transport
over SSH stdio, resolves remote CLI options, performs remote preflight checks,
and collects remote-control status without exposing remote HTTP ports.

## `codex-toys/proxy`

Optional HTTP edge for dashboards. The proxy starts or connects to a toybox and
exposes generic routes:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/host/overview
POST /api/app/:method
POST /api/workbench/:method
POST /api/workbench/overview
```

`/api/schema` comes from `toybox.initialize`, so dashboards can discover
available methods, including `feed.*` methods, without duplicated route
definitions. Direct browser CORS is loopback-only. Related public entry points
are:

- `codex-toys/proxy/browser`
- `codex-toys/proxy/vite`
- the `codex-toys-proxy` binary

## `codex-toys/kits`

Kit inspection and installation helpers. Kits copy selected skills, plugins,
and automations into a workbench, read optional `codex-kit.toml` manifests,
record `.codex/kit-lock.json`, and back up replaced item directories under
`.codex/kit-backups/`.

The CLI surface is:

```bash
codex-toys kit inspect <source> [--json]
codex-toys kit add <source> [--apply] [--include <name>] [--exclude <name>]
codex-toys kit list [--json]
codex-toys kit doctor [--json]
```

## `codex-toys`

The CLI package and umbrella runtime export. It bundles the internal workspaces,
re-exports their public APIs from the root import, exposes focused subpaths, and
publishes the `codex-toys` and `codex-toys-proxy` binaries.

```bash
codex-toys fetch
codex-toys toybox serve --cwd /repo
codex-toys workbench doctor
codex-toys kit list
```
