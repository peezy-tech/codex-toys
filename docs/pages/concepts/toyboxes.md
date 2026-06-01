---
title: Workbench toyboxes
description: Logical Codex workbench capabilities across local and SSH deployments.
---

# Workbench toyboxes

A codex-toys workbench toybox is the logical runtime behind an operator surface
such as a CLI, automation host, MCP server, proxy, or product-owned presenter.
It is not a network server.

The built-in capability families are:

- app-server pass-through for native Codex app-server JSON-RPC methods
- workbench functions
- automation helpers
- delegation lifecycle, return modes, result flushing, and group wakes
- deferred run intents, attempts, claiming, and inspection
- workbench state and presentation routing

Native app-server methods stay app-server-native. Calls such as `thread/list`,
`thread/read`, `thread/start`, `turn/start`, `turn/interrupt`, and
`account/read` are forwarded through `app.call`.

Workbench-owned methods are reserved for behavior that combines app-server
state with workbench policy or workbench state: delegations, return modes, group
wakes, workbench routing, observed-thread wake behavior, and persisted
workbench sessions.

Use a toybox when a product needs Codex workbench control locally or over SSH.
Use the proxy only when a browser needs an HTTP edge.
