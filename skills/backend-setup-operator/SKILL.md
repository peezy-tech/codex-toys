---
name: agent-operator
description: Use when checking or operating codex-flows local/SSH agents and the optional generic HTTP proxy after a Codex plugin install.
---

# Agent Operator

Use this skill when a user wants the local or SSH codex-flows runtime story
after installing a codex-flows plugin.

## Boundaries

- Plugin install gives Codex skills, MCP config, hooks, and scripts.
- Core codex-flows operation is stdio-first: local stdio or SSH stdio.
- `codex-flows agent serve` is the runtime primitive.
- `codex-flows-proxy serve` is the explicit browser/dashboard HTTP edge.
- Do not revive service/profile setup commands or WebSocket backend hosting.

## Local Agent Flow

Check the workspace:

```bash
codex-flows workspace doctor
```

Run one-shot commands through the spawned local agent:

```bash
codex-flows fetch
codex-flows workspace methods
codex-flows functions list --json
codex-flows automation list --json
codex-flows turn run "Check workspace status" --wait
```

Start the agent directly only when another process needs stdio JSON-RPC:

```bash
codex-flows agent serve --cwd <workspace>
```

## Proxy Flow

Use the proxy only when a browser needs HTTP:

```bash
codex-flows-proxy serve --cwd <workspace> --static ./dashboard
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
codex-flows --ssh <user@host> --cwd <remote-workspace> remote preflight
codex-flows --ssh <user@host> --cwd <remote-workspace> fetch
codex-flows --ssh <user@host> --cwd <remote-workspace> workspace doctor
```

Examples:

```bash
codex-flows --ssh <user@host> --cwd <remote-workspace> workspace methods
codex-flows --ssh <user@host> --cwd <remote-workspace> functions list --json
codex-flows --ssh <user@host> --cwd <remote-workspace> automation run check-release --event event.json --sandbox danger-full-access --approval-policy never
codex-flows --ssh <user@host> --cwd <remote-workspace> app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-flows --ssh <user@host> --cwd <remote-workspace> turn run "Check workspace status" --wait --sandbox danger-full-access --approval-policy never
```

Do not auto-install remote binaries. The local side needs `codex-flows`; the
remote side needs `node`, `codex-flows`, and `codex`.

Useful variables:

```bash
CODEX_FLOWS_REMOTE_SSH_TARGET=<user@host>
CODEX_FLOWS_REMOTE_CWD=<remote-workspace>
CODEX_FLOWS_REMOTE_PATH_PREPEND=/home/user/.local/bin:/home/user/.bun/bin:/home/user/.cargo/bin
CODEX_FLOWS_AGENT_COMMAND=codex-flows
CODEX_FLOWS_REMOTE_CODEX_COMMAND=codex
```

Non-interactive SSH does not necessarily load login-shell PATH setup. Prefer
`CODEX_FLOWS_REMOTE_PATH_PREPEND` or absolute command overrides. Do not put
inline `PATH=... command` strings in command variables.
