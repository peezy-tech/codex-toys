---
title: Runtimes
description: Compare direct app-server access, codex-flows agents, SSH-backed operation, and the optional proxy.
---

# Runtimes

codex-flows has three runtime shapes:

- direct app-server access for protocol inspection
- the codex-flows agent for local and SSH workspace operation
- the optional proxy for browser dashboards

## Direct app-server

Direct app-server access is useful for local development, protocol inspection,
and one-off debugging. It talks to Codex app-server without workspace policy.

Use `--via app` only when you deliberately want this direct path.

## Agent

The agent is the normal automation surface. It owns app-server pass-through,
functions, delegation, workspace state, and repo-local task execution. Turn
automation uses `--via workspace` by default.

Local commands spawn the agent over stdio. SSH commands start the same agent on
the target and speak JSON-RPC over SSH stdio.

## Proxy

The proxy is an optional HTTP edge:

```bash
codex-flows-proxy serve --cwd /repo --static ./dashboard
codex-flows-proxy serve --ssh devbox --cwd /repo --static ./dashboard
```

It exists so plain HTML/JS dashboards can use `fetch`. It does not replace the
agent as the core control transport.
