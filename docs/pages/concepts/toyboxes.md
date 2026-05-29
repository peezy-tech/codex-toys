---
title: Workspace toyboxes
description: Logical Codex workspace capabilities across local and SSH deployments.
---

# Workspace toyboxes

A codex-toys workspace toybox is the logical runtime behind an operator surface
such as a CLI, automation host, MCP server, proxy, or product-owned presenter.
It is not a network server.

The built-in capability families are:

- app-server pass-through for native Codex app-server JSON-RPC methods
- workspace functions
- automation helpers
- delegation lifecycle, return modes, result flushing, and group wakes
- workbench state and presentation routing

Native app-server methods stay app-server-native. Calls such as `thread/list`,
`thread/read`, `thread/start`, `turn/start`, `turn/interrupt`, and
`account/read` are forwarded through `app.call`.

Workspace-owned methods are reserved for behavior that combines app-server
state with workspace policy or workspace state: delegations, return modes, group
wakes, workbench routing, observed-thread wake behavior, and persisted
workspace sessions.

Use a toybox when a product needs Codex workspace control locally or over SSH.
Use the proxy only when a browser needs an HTTP edge.
