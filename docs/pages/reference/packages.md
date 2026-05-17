---
title: Packages
description: Public and workspace packages in the codex-flows stack.
---

# Packages

## `@peezy.tech/codex-flows`

Codex app-server client package and CLI. It exports:

- app-server JSON-RPC client and stdio/WebSocket transports
- browser-safe workspace backend client and protocol server primitives
- browser-safe WebSocket transport
- framework-agnostic app-server flow helpers
- auth helpers for account login/status/usage
- workbench reducers and request descriptors
- generated Codex app-server protocol types
- the `codex-flows` CLI for fetch, app-server calls, workspace backend calls,
  flow inspection, workspace autonomy, and memory transplant

## `@peezy.tech/flow-runtime`

Runtime package for:

- loading `flow.toml`
- discovering `.codex/flows/*` before `flows/*`
- matching events with trigger type and JSON Schema
- running Bun and gated Code Mode steps
- module-style Bun step helpers under `@peezy.tech/flow-runtime/bun`
- local and HTTP flow clients
- backend response normalization

## `@peezy.tech/flow-backend-convex`

Convex component for generic flow control-plane state: manifests, events, runs,
attempts, leases, output chunks, and final result payloads.

## Workspace apps

- `codex-flow-runner`: local CLI for listing, firing, and running steps.
- `codex-workspace-backend-local`: local workspace backend process with browser
  control WebSocket and optional flow HTTP routes.
- [`codex-discord-bridge`](discord-bridge): Discord-to-Codex bridge with
  workspace delegation and flow inspection tools.
- [`codex-workspace-voice-gateway`](workspace-voice-gateway): broadcast-only
  Discord voice output for selected workspace backend updates.
- `web`: browser UI for Codex threads through the local workspace backend.
- `codex-app-cli`: JSON-RPC CLI for app-server actions.
