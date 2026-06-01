---
title: Workbench toybox deployments
description: Local stdio, SSH stdio, and optional proxy deployment shapes.
---

# Workbench toybox deployments

The toybox is a capability model first. The product surface is local
workbench operation plus SSH-backed remote operation.

## Local stdio

Local mode has no operator-facing HTTP surface and no public socket. The CLI,
MCP server, Vite plugin, or proxy starts:

```bash
codex-toys toybox serve --cwd <workbench>
```

The toybox starts Codex app-server over stdio, exposes workbench methods, and
advertises method metadata through `toybox.initialize`.

## SSH stdio

SSH mode keeps the operator command local and runs Codex workbench capabilities
on the target host. The local CLI starts `codex-toys toybox serve` over SSH and
speaks workbench JSON-RPC over the SSH stdio stream. The remote toybox starts
Codex app-server on the remote host; it does not expose a network port.

The remote host owns its checkout, `CODEX_HOME`, installed tools, and
credentials.

```bash
codex-toys --ssh devbox --cwd /repo remote preflight
codex-toys --ssh devbox --cwd /repo turn run "Inspect status" --wait
```

Remote SSH commands are non-interactive. If the target only exposes Node, Bun,
Cargo, or local user bins from login shell startup files, set
`CODEX_TOYS_REMOTE_PATH_PREPEND` or absolute command overrides through
`CODEX_TOYS_TOYBOX_COMMAND` and `CODEX_TOYS_REMOTE_CODEX_COMMAND`.

## Optional proxy

The proxy is explicit:

```bash
codex-toys-proxy serve --cwd /repo --static ./dashboard
codex-toys-proxy serve --ssh devbox --cwd /repo --static ./dashboard
```

It exposes generic HTTP routes backed by the toybox. It is the place for future
auth, origin, and permission policy for browser-facing integrations.
