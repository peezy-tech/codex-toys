---
title: Workspace backends
description: Logical Codex workspace capabilities across embedded, local, and remote deployments.
---

# Workspace backends

A Codex workspace backend is the logical runtime behind an operator surface such
as Discord, the browser UI, or a CLI. It is not necessarily a network server.
The backend owns shared workspace capabilities and exposes them through the
transport shape that fits the deployment.

The built-in capability families are:

- app-server pass-through for native Codex app-server JSON-RPC methods
- delegation lifecycle, return modes, result flushing, and group wakes
- flow execution and inspection over the generic `FlowEvent`/`FLOW_RESULT` ABI
- workbench state, observed threads, hook-spool returns, and presentation routing

Native app-server methods stay app-server-native. Calls such as `thread/list`,
`thread/read`, `thread/start`, `turn/start`, `turn/interrupt`, `account/read`,
and app-server-native goal APIs are forwarded through the app-server adapter the
workspace backend owns. That adapter might be stdio, a Unix socket, a local
WebSocket, or a future remote transport.

Workspace-owned methods are reserved for behavior that combines app-server
state with workspace policy or workspace state: delegations, return modes, group
wakes, workbench routing, hook-spool observed-thread wake behavior, persisted
workspace sessions, and flow inspection or dispatch.

Flow execution is now a workspace backend capability. In an embedded backend,
tools and presenters can call the flow capability directly. In a networked local
backend, the same capability is also mounted as the existing HTTP routes for
dispatch, inspection, and replay. The generic flow ABI remains unchanged:
products dispatch `FlowEvent`, flow packages match `flow.toml`, steps emit
`FLOW_RESULT`, and app-specific completion stays in the consuming app.

Use a workspace backend when the product needs a long-lived Codex control
surface. Use flow packages when the product needs portable event-driven
automation.
