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
- direct access to delegation and workbench capabilities

The presenter wrapper owns its own startup, shutdown, command registration, and
inbound events. The local workspace backend owns Codex app-server lifecycle,
thread routing, goals, delegation, workbench state, hook-spool draining, and
persisted workspace state.

## Networked local

Networked local mode runs `codex-workspace-backend-local` as one process. It can
connect to an existing app-server or spawn a local stdio app-server, and it can
mount the control WebSocket surface.

The control protocol has two lanes:

| Lane | Methods | Owner |
|------|---------|-------|
| app-server pass-through | `appServer.call`, `appServer.notify`, `appServer.respond`, `appServer.respondError` | Codex app-server adapter |
| workspace-owned | `workspace.*`, `delegation.*`, and `workspace.event` | Codex workspace backend |

The networked local process is the normal target for workspace-backed turn
automation and remote operation.

## SSH remote

SSH remote mode keeps the operator command local and runs Codex workspace
capabilities on the target host. The local CLI starts a transient
`codex-workspace-backend-local serve --local-app-server` process on the remote
by default. Use `--remote-mode existing` when the remote already runs a backend
and the local command should only open a tunnel.

The remote host owns its checkout, `CODEX_HOME`, installed tools, and
credentials. The local CLI reads local command inputs such as `--event`, while
Codex tools and generated state happen on the remote workspace.

Remote SSH commands are non-interactive. If the target only exposes Node, Bun,
Cargo, or local user bins from login shell startup files, set
`CODEX_FLOWS_REMOTE_PATH_PREPEND` or absolute remote command overrides before
starting the provider. `remote turn start` can also use this SSH provider and
accepts turn policy flags such as `--sandbox danger-full-access` and
`--approval-policy never`.

## Future remote

A remote workspace backend should expose the same logical capabilities behind a
remote transport. The transport-facing contract should stay small:

| Direction | Shape | Purpose |
|-----------|-------|---------|
| presenter to backend | transport-specific inbound events or workspace JSON-RPC | lifecycle, commands, and event delivery |
| backend to presenter | presenter operations or `workspace.event` notifications | UI output and presentation updates |
| backend to app-server | app-server adapter calls | app-server-native thread, turn, auth, goal, and tool behavior |
The backend boundary should not redefine app-server semantics. It owns
workspace orchestration and policy; app-server capabilities keep their native
contracts.
