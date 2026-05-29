---
name: toybox-operator
description: Use when checking or operating codex-toys local and SSH toyboxes and the optional generic HTTP proxy after a Codex plugin install.
---

# Agent Operator

Use this skill when a user wants the local or SSH codex-toys runtime story
after installing a codex-toys plugin.

## Boundaries

- Plugin install gives Codex skills, MCP config, hooks, and scripts.
- Core codex-toys operation is stdio-first: local stdio or SSH stdio.
- `codex-toys toybox serve` is the runtime primitive.
- `codex-toys-proxy serve` is the explicit browser/dashboard HTTP edge.
- Do not revive service/profile setup commands or WebSocket backend hosting.

## Local Agent Flow

Check the workspace:

```bash
codex-toys workspace doctor
```

Run one-shot commands through the spawned local toybox:

```bash
codex-toys fetch
codex-toys workspace methods
codex-toys functions list --json
codex-toys automation list --json
codex-toys turn run "Check workspace status" --wait
```

Start the toybox directly only when another process needs stdio JSON-RPC:

```bash
codex-toys toybox serve --cwd <workspace>
```

## Proxy Flow

Use the proxy only when a browser needs HTTP:

```bash
codex-toys-proxy serve --cwd <workspace> --static ./dashboard
```

The proxy exposes:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/app/:method
POST /api/workspace/:method
```

Build dashboards from `/api/schema` and generic RPC calls; do not add
feature-specific duplicated endpoint logic.

## SSH Agent Flow

Start with a probe:

```bash
codex-toys --ssh <user@host> --cwd <remote-workspace> remote preflight
codex-toys --ssh <user@host> --cwd <remote-workspace> fetch
codex-toys --ssh <user@host> --cwd <remote-workspace> workspace doctor
```

Examples:

```bash
codex-toys --ssh <user@host> --cwd <remote-workspace> workspace methods
codex-toys --ssh <user@host> --cwd <remote-workspace> functions list --json
codex-toys --ssh <user@host> --cwd <remote-workspace> automation run check-release --event event.json --sandbox danger-full-access --approval-policy never
codex-toys --ssh <user@host> --cwd <remote-workspace> app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-toys --ssh <user@host> --cwd <remote-workspace> turn run "Check workspace status" --wait --sandbox danger-full-access --approval-policy never
```

Do not auto-install remote binaries. The local side needs `codex-toys`; the
remote side needs `node`, `codex-toys`, and `codex`.

Useful variables:

```bash
CODEX_TOYS_REMOTE_SSH_TARGET=<user@host>
CODEX_TOYS_REMOTE_CWD=<remote-workspace>
CODEX_TOYS_REMOTE_PATH_PREPEND=/home/user/.local/bin:/home/user/.bun/bin:/home/user/.cargo/bin
CODEX_TOYS_TOYBOX_COMMAND=codex-toys
CODEX_TOYS_REMOTE_CODEX_COMMAND=codex
```

Non-interactive SSH does not necessarily load login-shell PATH setup. Prefer
`CODEX_TOYS_REMOTE_PATH_PREPEND` or absolute command overrides. Do not put
inline `PATH=... command` strings in command variables.
