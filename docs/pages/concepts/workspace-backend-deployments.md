---
title: Workspace backend deployments
description: Embedded, networked local, and future remote workspace backend shapes.
---

# Workspace backend deployments

The workspace backend is a capability model first. It can run embedded with a
presenter, as a local networked process, or behind a future remote transport.

## Embedded local

Embedded local mode has no operator-facing HTTP surface and no public socket. A
presenter or transport constructs the workspace backend in-process with:

- an app-server adapter, often a locally spawned `codex app-server` over stdio
- a state store
- workspace configuration
- presenter callbacks for output and UI artifacts
- direct access to delegation, workbench, and flow capabilities

The presenter wrapper owns its own startup, shutdown, command registration, and
inbound events. The local workspace backend owns Codex app-server lifecycle,
thread routing, goals, delegation, workbench state, hook-spool draining, flow
capability access, and persisted workspace state.

## Networked local

Networked local mode runs `codex-workspace-backend-local` as one process. It can
connect to an existing app-server or spawn a local stdio app-server, and it can
mount control WebSocket plus flow HTTP surfaces.

The control protocol has two lanes:

| Lane | Methods | Owner |
|------|---------|-------|
| app-server pass-through | `appServer.call`, `appServer.notify`, `appServer.respond`, `appServer.respondError` | Codex app-server adapter |
| workspace-owned | `workspace.*`, `delegation.*`, `flow.*`, and `workspace.event` | Codex workspace backend |

The networked local process also mounts the stable flow HTTP routes such as
`/events`, `/events/:id/replay`, `/runs`, and `/healthz`. Those routes are an
optional transport surface over the same built-in flow capability.

## SSH remote

SSH remote mode keeps the operator command local and runs Codex workspace
capabilities on the target host. The local CLI opens an SSH tunnel to an
existing backend, or starts a transient `codex-workspace-backend-local serve
--local-app-server` process on the remote when configured for `auto` or `spawn`
mode. App-server-only commands can fall back to `codex app-server --listen
stdio://` over SSH.

The remote host owns its checkout, `CODEX_HOME`, installed tools, and
credentials. The local CLI reads local command inputs such as `--event`, but
flow discovery, step execution, Codex tools, and generated state happen on the
remote workspace.

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
