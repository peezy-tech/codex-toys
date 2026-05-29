---
title: Packages
description: Public and workspace packages in the codex-flows stack.
---

# Packages

## `@peezy.tech/codex-flows`

Codex app-server client package, workspace platform package, and CLI bundle. It
exports:

- app-server JSON-RPC client and stdio/WebSocket transports
- turn automation helpers for pre-turn scripts that can skip or start native
  Codex turns
- SSH remote provider helpers for targeting remote workspaces from a local CLI
- workspace functions under `@peezy.tech/codex-flows/functions`
- Vite bridge plugin under `@peezy.tech/codex-flows/vite`
- browser-safe workspace backend client and protocol server primitives
- browser-safe WebSocket transport and dashboard client under
  `@peezy.tech/codex-flows/browser`
- auth helpers for account login/status/usage
- Actions-mode workspace helpers under `@peezy.tech/codex-flows/actions`
- stable Codex memory artifact helpers under `@peezy.tech/codex-flows/memories`
- workbench reducers and request descriptors
- thread rollout locate, inspect, install, and transplant helpers under `@peezy.tech/codex-flows/threads`
- generated Codex app-server protocol types
- the `codex-flows` CLI for fetch, turn automation, app-server calls,
  workspace backend calls, workspace autonomy, memory
  transplant, and thread transplant
- runnable core process bins:
  - `codex-app`
  - `codex-workspace-backend-local`

The package is the canonical core install target for building or composing a
backend plus product-owned presenter surfaces. See
[Single package platform](../concepts/single-package-platform) for the target
architecture and release implications.

## `@peezy.tech/codex-flows/actions`

Actions helpers encode Codex workspace conventions for CI and local
Actions-mode simulation:

- `repoCodexHome(workspaceRoot)` returns `<repo>/.codex`
- `prepareActionsCodexAuth` writes `.codex/auth.json` from
  `CODEX_AUTH_JSON_B64`, `CODEX_AUTH_JSON`, or `OPENAI_API_KEY`
- `cleanupActionsCodexHome` removes runtime-only auth, install ids, sessions,
  shell snapshots, temp dirs, SQLite databases, `.codex/memories/.git`, and
  generated workspace diffs without deleting durable memory markdown or
  `.codex/workspace/actions`

These helpers intentionally do not inspect or mutate Codex memory SQLite
internals.

## `@peezy.tech/codex-flows/functions`

Workspace functions expose named JSON-in/JSON-out capabilities from a workspace
manifest at `.codex/functions.ts`, `.codex/functions.js`, or
`.codex/functions.mjs`.

```ts
import { defineFunctions } from "@peezy.tech/codex-flows/functions";

export default defineFunctions({
  portfolioSnapshot: {
    description: "Read the latest portfolio snapshot.",
    sideEffects: "read-only",
    handler: async () => ({ positions: [], cash: 0 }),
  },
});
```

The CLI, workspace backend, SSH remote-agent, Vite plugin, and browser client
use the same `functions.list`, `functions.describe`, and `functions.call`
workspace methods.

## `@peezy.tech/codex-flows/vite`

`codexFlowsRemote` is a local Vite middleware plugin that forwards dashboard
requests to a workspace backend or SSH remote-agent without exposing remote HTTP
ports.

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
`@peezy.tech/codex-flows/browser` to list, describe, and call workspace
functions through the local Vite bridge.

## `@peezy.tech/codex-flows/memories`

The memory transplant helpers operate on stable markdown artifacts only.

They provide:

- `listCodexMemoryArtifacts`
- `findTextInCodexMemoryArtifacts`
- `waitForCodexMemoryArtifacts`
- `copyCodexMemoryArtifacts`
- `sanitizeWorkspaceMemoryArtifacts`

Stable artifacts are `memories/raw_memories.md` and
`memories/rollout_summaries/*.md`. The helpers do not require
`MEMORY.md` or `memory_summary.md`, and cleanup removes runtime-only memory
files such as SQLite databases, `.git`, and `phase2_workspace_diff.md`.

## `@peezy.tech/codex-flows/threads`

Thread transplant helpers for:

- locating a Codex rollout JSONL by thread id under `CODEX_HOME/sessions`
- inspecting a thread id or rollout JSONL with byte length and sha256
- installing a loose rollout JSONL under a Codex home's native sessions path
- transplanting one rollout directly between two Codex homes

The helpers preserve raw rollout bytes and thread ids. They do not reconstruct
history, rewrite ids, or call app-server import APIs.

## Workspace apps

- `codex-workspace-backend-local`: local workspace backend process with
  control WebSocket. It is exposed as a bin from `@peezy.tech/codex-flows`.
- `codex-app`: JSON-RPC CLI for app-server actions.
