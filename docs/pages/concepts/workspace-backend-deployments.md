---
title: Workspace agent deployments
description: Local stdio, SSH stdio, and optional proxy deployment shapes.
---

# Workspace agent deployments

The workspace agent is a capability model first. The product surface is local
workspace operation plus SSH-backed remote operation.

## Local stdio

Local mode has no operator-facing HTTP surface and no public socket. The CLI,
MCP server, Vite plugin, or proxy starts:

```bash
codex-flows agent serve --cwd <workspace>
```

The agent starts Codex app-server over stdio, exposes workspace methods, and
advertises method metadata through `workspace.initialize`.

## SSH stdio

SSH mode keeps the operator command local and runs Codex workspace capabilities
on the target host. The local CLI starts `codex-flows agent serve` over SSH and
speaks workspace JSON-RPC over the SSH stdio stream. The remote agent starts
Codex app-server on the remote host; it does not expose a network port.

The remote host owns its checkout, `CODEX_HOME`, installed tools, and
credentials.

```bash
codex-flows --ssh devbox --cwd /repo remote preflight
codex-flows --ssh devbox --cwd /repo turn run "Inspect status" --wait
```

Remote SSH commands are non-interactive. If the target only exposes Node, Bun,
Cargo, or local user bins from login shell startup files, set
`CODEX_FLOWS_REMOTE_PATH_PREPEND` or absolute command overrides through
`CODEX_FLOWS_AGENT_COMMAND` and `CODEX_FLOWS_REMOTE_CODEX_COMMAND`.

## Optional proxy

The proxy is explicit:

```bash
codex-flows-proxy serve --cwd /repo --static ./dashboard
codex-flows-proxy serve --ssh devbox --cwd /repo --static ./dashboard
```

It exposes generic HTTP routes backed by the agent. It is the place for future
auth, origin, and permission policy for browser-facing integrations.
