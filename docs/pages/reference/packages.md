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
- workbench reducers and request descriptors
- generated Codex app-server protocol types
- the `codex-flows` CLI for fetch, app-server calls, workspace backend calls,
  flow inspection, workspace autonomy, and memory transplant
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
- running Bun and gated Code Mode steps
- module-style Bun step helpers under `@peezy.tech/codex-flows/flow-runtime/bun`
- local and HTTP flow clients
- backend response normalization

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
