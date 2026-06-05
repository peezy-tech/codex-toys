---
title: Package Reference
description: Public codex-toys imports and internal package boundaries.
---

# Package Reference

Install `codex-toys` for the CLI and runtime APIs. The repo keeps internal
`@codex-toys/*` workspaces for feature boundaries, but the public package embeds
those workspaces into its tarball. Consumers import from `codex-toys/*`.

## `codex-toys/bridge`

Native Codex bridge primitives:

- app-server client and stdio transport
- generated app-server protocol types
- JSON-RPC parsing and error helpers
- auth, login, and usage helpers
- memory transplant helpers
- thread rollout locate, inspect, install, and transplant helpers

```ts
import { CodexAppServerClient } from "codex-toys/bridge";
import { v2 } from "codex-toys/bridge/generated";
import { parseJsonText } from "codex-toys/bridge/json";
```

## `codex-toys/toybox`

Stdio JSON-RPC protocol, client, and server primitives for local and SSH-backed
toyboxes. Use it when another process needs to host or call a toybox directly.

## `codex-toys/feed`

Feed intake helpers:

- `.codex/feed.toml` config
- RSS/Atom polling and normalization
- source checkpoints
- durable feed item storage
- collection cursors
- dispatch and pruning
- toybox method factories and metadata

```ts
import {
  createFeedContext,
  loadFeedConfig,
  pollFeedSources,
  collectFeedItems
} from "codex-toys/feed";
```

## `codex-toys/workbench`

Workbench runtime and policy helpers:

- workflow script execution and workflow host helpers
- remote workflow toybox methods
- workbench doctor, tick, task execution, and Actions scaffolding
- deferred runs, prompt queue, and local handoff queue
- delegation methods and state
- workbench functions
- workbench and host overview
- thread presentation helpers and request descriptors

This package can construct app-server requests through supplied host functions.
The app-server protocol remains the source of truth for native thread and turn
methods.

```ts
import {
  createWorkflowHost,
  runWorkflowScript,
  createWorkbenchContext
} from "codex-toys/workbench";
```

## `codex-toys/actions`

Actions-mode helpers:

- `repoCodexHome(workbenchRoot)`
- `prepareActionsCodexAuth`
- `cleanupActionsCodexHome`

These helpers prepare repo-local auth for Actions mode and clean runtime-only
files without deleting durable workbench state.

## `ghcr.io/peezy-tech/codex-toys-actions`

Actions-mode runner image. Use
`ghcr.io/peezy-tech/codex-toys-actions:<version>` to pin the runtime to a
codex-toys release, or build a custom image from it when a workbench needs extra
system packages. The generated Actions-mode workflow uses
`ghcr.io/peezy-tech/codex-toys-actions:latest` by default. The OpenAI Codex
release feed publishes `codex-<codex-version>` tags that bake native Codex into
the image before the bindings workflow runs.

## `codex-toys/remote`

SSH-backed transport and preflight helpers. This package creates toybox
transports over SSH stdio, resolves remote options, performs remote preflight,
and supports remote-control status helpers without exposing remote HTTP ports.

## `codex-toys/proxy`

Optional HTTP edge for dashboards. Public entry points include:

- `codex-toys/proxy`
- `codex-toys/proxy/browser`
- `codex-toys/proxy/vite`
- `codex-toys-proxy`

The proxy forwards generic app and workbench methods to a toybox.

## `codex-toys/kits`

Kit helpers for inspecting and installing repo-local skills, plugins, and
workflow templates. Kits read optional `codex-kit.toml` manifests, write
`.codex/kit-lock.json`, and back up overwritten item directories under
`.codex/kit-backups/`.

## `codex-toys`

The CLI package and umbrella runtime export. It publishes the `codex-toys` and
`codex-toys-proxy` binaries, re-exports the focused runtime surfaces, and
ships a version-matched Markdown docs snapshot under `docs/pages`.
