---
title: Packages
description: Public and workspace packages in the codex-flows stack.
---

# Packages

## `@peezy.tech/codex-flows`

Codex app-server client package, workspace platform package, and CLI bundle. It
exports:

- app-server JSON-RPC client and stdio/WebSocket transports
- browser-safe workspace backend client and protocol server primitives
- browser-safe WebSocket transport
- framework-agnostic app-server flow helpers
- auth helpers for account login/status/usage
- Actions-mode workspace helpers under `@peezy.tech/codex-flows/actions`
- stable Codex memory artifact helpers under `@peezy.tech/codex-flows/memories`
- workbench reducers and request descriptors
- thread rollout locate, inspect, install, and transplant helpers under `@peezy.tech/codex-flows/threads`
- generated Codex app-server protocol types
- the `codex-flows` CLI for fetch, app-server calls, workspace backend calls,
  flow inspection, workspace autonomy, memory transplant, and thread transplant
- runnable core process bins:
  - `codex-app`
  - `codex-flow-runner`
  - `codex-workspace-backend-local`

The package is the canonical core install target for building or composing a
backend plus optional gateway packages. See
[Single package platform](../concepts/single-package-platform) for the target
architecture and release implications.

## `@peezy.tech/codex-flows/flow-runtime`

Runtime package for:

- loading `flow.toml`
- discovering `.codex/flows/*` before `flows/*`
- matching events with trigger type and JSON Schema
- running Node steps
- module-style Node step helpers under `@peezy.tech/codex-flows/flow-runtime/node`
- local and HTTP flow clients
- backend response normalization

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
- `createActionsLocalFlowClient` creates a file-backed local flow client rooted
  at `.codex/workspace/actions/flow-client` with `CODEX_HOME=<repo>/.codex`
- `dispatchActionsFlowEvent` persists an event under
  `.codex/workspace/actions/events` and dispatches it locally
- `assertActionsFlowRun` validates the latest file-backed Actions run for a
  flow and step

These helpers intentionally do not inspect or mutate Codex memory SQLite
internals.

## `@peezy.tech/codex-flows/memories`

Memory helpers operate on stable markdown artifacts only:

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

## `@peezy.tech/flow-runtime`

Compatibility package for the old standalone flow runtime install target. New
code should import the runtime through `@peezy.tech/codex-flows/flow-runtime` so
the core platform surface stays consolidated in the canonical package.

## `@peezy.tech/flow-backend-convex`

Convex component for generic flow control-plane state: manifests, events, runs,
attempts, leases, output chunks, and final result payloads.

## Workspace apps

- `codex-flow-runner`: local CLI for listing, firing, and running steps. It is
  exposed as a bin from `@peezy.tech/codex-flows`.
- `codex-workspace-backend-local`: local workspace backend process with browser
  control WebSocket and optional flow HTTP routes. It is exposed as a bin from
  `@peezy.tech/codex-flows`.
- [`@peezy.tech/codex-discord-bridge`](discord-bridge): Discord-to-Codex bridge
  with workspace delegation and flow inspection tools. It is a Discord gateway
  package/app that depends on `@peezy.tech/codex-flows`.
- [`@peezy.tech/codex-workspace-voice-gateway`](workspace-voice-gateway):
  broadcast-only Discord voice output for selected workspace backend updates. It
  is a Discord gateway package/app that depends on `@peezy.tech/codex-flows`.
- `web`: browser UI for Codex threads through the local workspace backend.
- `codex-app-cli`: JSON-RPC CLI for app-server actions. It is exposed as the
  `codex-app` bin from `@peezy.tech/codex-flows`.
