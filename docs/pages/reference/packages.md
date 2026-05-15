---
title: Packages
description: Public and workspace packages in the codex-flow stack.
---

# Packages

## `@peezy.tech/codex-flows`

Low-level Codex app-server client package. It exports:

- app-server JSON-RPC client and stdio/WebSocket transports
- browser-safe WebSocket transport
- framework-agnostic app-server flow helpers
- auth helpers for account login/status/usage
- workbench reducers and request descriptors
- generated Codex app-server protocol types

## `@peezy.tech/flow-runtime`

Runtime package for:

- loading `flow.toml`
- discovering `.codex/flows/*` before `flows/*`
- matching events with trigger type and JSON Schema
- running Bun and gated Code Mode steps
- local and HTTP flow clients
- backend response normalization

## `@peezy.tech/flow-backend-convex`

Convex component for generic flow control-plane state: manifests, events, runs,
attempts, leases, output chunks, and final result payloads.

## Workspace apps

- `codex-flow-runner`: local CLI for listing, firing, and running steps.
- `codex-flow-systemd-local`: local durable HTTP backend and CLI.
- [`codex-discord-bridge`](discord-bridge): Discord-to-Codex bridge with
  gateway delegation and read-only flow inspection tools.
- `web`: browser UI for Codex app-server threads.
- `codex-app-cli`: JSON-RPC CLI for app-server actions.
