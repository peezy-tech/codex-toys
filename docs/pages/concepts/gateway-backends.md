---
title: Gateway backends
description: How Codex gateway surfaces differ from generic flow backends.
---

# Gateway backends

A Codex gateway backend is the runtime behind an operator surface such as
Discord. It owns Codex app-server orchestration and exposes a small UI-facing
contract to the transport.

The Discord bridge is the first transport using this split:

- Discord owns bot login, commands, interactions, Discord channels, and message
  delivery.
- The gateway backend owns app-server connection, Codex thread start/resume,
  turns, goals, delegations, workbench state, hook-spool draining, persisted
  bridge state, and optional flow-run inspection.
- The local backend is the first implementation. It can connect to an existing
  app-server WebSocket or start a local stdio app-server.

This is separate from codex-flow backends. A flow backend accepts `FlowEvent`,
matches `flow.toml`, executes steps, records `FLOW_RESULT`, and exposes run and
event views. A gateway backend may read those run and event views, but it does
not redefine the flow ABI and should not become the generic flow executor.

Use a gateway backend when the product needs a long-lived Codex control surface.
Use a flow backend when the product needs portable event-driven automation.
