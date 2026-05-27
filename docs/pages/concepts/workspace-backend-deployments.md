---
title: Workspace backend deployments
description: Embedded local, networked local, and SSH-backed workspace backend shapes.
---

# Workspace backend deployments

The workspace backend is a capability model first. The product surface is local
workspace operation plus SSH-backed remote operation.

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

Networked local mode runs `codex-workspace-backend-local` as one process. It
binds to `127.0.0.1` by default, can connect to an existing app-server or spawn
a local stdio app-server, and can be installed as a user service from a named
profile:

```bash
codex-flows workspace backend init local --global --profile home
codex-flows workspace backend service install --profile home
```

The control protocol has two lanes:

| Lane | Methods | Owner |
|------|---------|-------|
| app-server pass-through | `appServer.call`, `appServer.notify`, `appServer.respond`, `appServer.respondError` | Codex app-server adapter |
| workspace-owned | `workspace.*`, `delegation.*`, and `workspace.event` | Codex workspace backend |

The networked local process is the normal target for workspace-backed turn
automation on the operator machine.

## SSH remote

SSH remote mode keeps the operator command local and runs Codex workspace
capabilities on the target host. The local CLI starts
`codex-flows remote-agent serve` over SSH and speaks workspace JSON-RPC over the
SSH stdio stream. The remote agent starts Codex app-server on the remote host;
it does not expose a WebSocket port or tunnel to an already-running backend.

The remote host owns its checkout, `CODEX_HOME`, installed tools, and
credentials. The local CLI reads local command inputs such as `--event`, while
Codex tools and generated state happen on the remote workspace.

Remote SSH commands are non-interactive. If the target only exposes Node, Bun,
Cargo, or local user bins from login shell startup files, set
`CODEX_FLOWS_REMOTE_PATH_PREPEND` or absolute remote command overrides for
`CODEX_FLOWS_REMOTE_AGENT_COMMAND` and `CODEX_FLOWS_REMOTE_CODEX_COMMAND`.
`remote turn start` can also use this SSH provider and accepts turn policy flags
such as `--sandbox danger-full-access` and `--approval-policy never`.

The backend boundary should not redefine app-server semantics. It owns
workspace orchestration and policy; app-server capabilities keep their native
contracts.
