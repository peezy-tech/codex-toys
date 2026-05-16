---
title: Workspace backend deployments
description: Embedded, networked local, and future remote workspace backend shapes.
---

# Workspace backend deployments

The workspace backend is a capability model first. It can run embedded with a
presenter, as a local networked process, or behind a future remote transport.

## Embedded local

Embedded local mode has no browser-facing HTTP surface and no public socket. A
presenter or transport such as Discord constructs the workspace backend
in-process with:

- an app-server adapter, often a locally spawned `codex app-server` over stdio
- a state store
- workspace configuration
- presenter callbacks for output and UI artifacts
- direct access to delegation, workbench, and flow capabilities

Discord uses this shape today. The Discord wrapper owns bot startup, shutdown,
command registration, and inbound Discord events. The local workspace backend
owns Codex app-server lifecycle, thread routing, goals, delegation, workbench
state, hook-spool draining, flow capability access, and persisted workspace
state.

## Networked local

Networked local mode runs `codex-workspace-backend-local` as one process. It can
connect to an existing app-server or spawn a local stdio app-server, and it can
mount browser/control WebSocket plus flow HTTP surfaces.

In development, the browser can connect through Vite's
`/__codex-workspace-backend` proxy to the local backend on port `3586`.

The browser protocol has two lanes:

| Lane | Methods | Owner |
|------|---------|-------|
| app-server pass-through | `appServer.call`, `appServer.notify`, `appServer.respond`, `appServer.respondError` | Codex app-server adapter |
| workspace-owned | `workspace.*`, `delegation.*`, `flow.*`, and `workspace.event` | Codex workspace backend |

The networked local process also mounts the stable flow HTTP routes such as
`/events`, `/events/:id/replay`, `/runs`, and `/healthz`. Those routes are an
optional transport surface over the same built-in flow capability.

## Future remote

A remote workspace backend should expose the same logical capabilities behind a
remote transport. The transport-facing contract should stay small:

| Direction | Shape | Purpose |
|-----------|-------|---------|
| presenter to backend | transport-specific inbound events or workspace JSON-RPC | lifecycle, commands, and event delivery |
| backend to presenter | presenter operations or `workspace.event` notifications | UI output and presentation updates |
| backend to app-server | app-server adapter calls | app-server-native thread, turn, auth, goal, and tool behavior |
| backend to flow capability | direct calls or mounted HTTP routes | flow dispatch, inspection, and replay |

The backend boundary should not redefine app-server or flow semantics. It owns
workspace orchestration and policy; app-server and flow capabilities keep their
native contracts.
