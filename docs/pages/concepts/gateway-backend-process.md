---
title: Gateway backend process
description: Process boundaries for local and future remote Codex gateway backends.
---

# Gateway backend process

The current Discord gateway backend runs in-process with the Discord transport.
That keeps deployment simple while preserving the backend boundary in code:

- `DiscordCodexBridge` owns Discord startup, shutdown, command registration, and
  inbound dispatch.
- `LocalCodexGatewayBackend` owns app-server connection, Codex thread lifecycle,
  turn routing, goals, delegations, workbench state, hook-spool draining, and
  persisted gateway state.
- `CodexGatewayPresenter` is the only outbound UI surface the local backend
  receives. It can create posts or threads, send and update messages, pin status,
  type, and delete presentation artifacts.

## In-process local backend

Local mode is the first implementation. The Discord process constructs a local
backend with:

- a Codex app-server client
- a state store
- bridge configuration
- a presenter adapter backed by the Discord transport
- an optional flow backend client for read-only run and event inspection

The backend may connect to an existing app-server WebSocket or to a local stdio
app-server started by the CLI.

## Future remote backend

A remote backend can implement the same `CodexGatewayBackend` shape behind HTTP
or WebSocket. The transport-facing protocol should stay small:

| Direction | Shape | Purpose |
|-----------|-------|---------|
| transport to backend | `start`, `stop`, `handleInbound`, `commandRegistration` | lifecycle and event delivery |
| backend to transport | `CodexGatewayPresenter` operations | UI output and presentation updates |
| backend to app-server | Codex app-server client calls | thread, turn, goal, and tool orchestration |
| backend to flow backend | `@peezy.tech/flow-runtime` backend client calls | optional read-only inspection |

Inbound events are still transport-shaped today because Discord is the only UI.
If another UI lands, the next boundary is a transport-neutral gateway event
model plus a presenter adapter per UI.

## Flow backend boundary

This gateway backend is not a codex-flow backend. It may inspect flow runs and
events, but it must not own `FlowEvent`, `flow.toml`, `FLOW_RESULT`, matching,
or step execution.
