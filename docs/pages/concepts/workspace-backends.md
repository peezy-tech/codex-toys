---
title: Workspace backends
description: Logical Codex workspace capabilities across embedded, local, and remote deployments.
---

# Workspace backends

A Codex workspace backend is the logical runtime behind an operator surface such
as a CLI, automation host, or product-owned presenter. It is not necessarily a
network server.
The backend owns shared workspace capabilities and exposes them through the
transport shape that fits the deployment.

The built-in capability families are:

- app-server pass-through for native Codex app-server JSON-RPC methods
- delegation lifecycle, return modes, result flushing, and group wakes
- workbench state, observed threads, hook-spool returns, and presentation routing

Native app-server methods stay app-server-native. Calls such as `thread/list`,
`thread/read`, `thread/start`, `turn/start`, `turn/interrupt`, `account/read`,
and app-server-native goal APIs are forwarded through the app-server adapter the
workspace backend owns. That adapter might be stdio, a Unix socket, a local
WebSocket, or the SSH remote-agent provider that starts `codex-flows
remote-agent serve` on the target host and speaks workspace JSON-RPC over
stdio.

Workspace-owned methods are reserved for behavior that combines app-server
state with workspace policy or workspace state: delegations, return modes, group
wakes, workbench routing, hook-spool observed-thread wake behavior, and
persisted workspace sessions.

Use a workspace backend when the product needs a long-lived Codex control
surface or remote-friendly turn automation.
