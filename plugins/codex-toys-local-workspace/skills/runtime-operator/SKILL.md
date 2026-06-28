---
name: runtime-operator
description: Use when checking or operating codex-toys local and SSH runtimes and the optional local HTTP runtime edge after a Codex plugin install.
---

# Runtime Operator

Use this skill when a user wants the local or SSH codex-toys runtime story after
installing a codex-toys plugin.

## Boundaries

- Plugin install gives Codex skills and marketplace metadata. It does not start
  a daemon or install a persistent service.
- Core codex-toys operation is runtime-first: local stdio, SSH stdio, or an
  optional local HTTP edge for browsers.
- `codex-toys runtime serve` is the stdio JSON-RPC primitive.
- `codex-toys runtime http` is the explicit browser/dashboard HTTP edge.
- Do not use the retired toybox, remote, or standalone proxy command families.

## Local Runtime Flow

Check the workbench:

```bash
codex-toys fetch
codex-toys runtime host-overview --json
codex-toys workbench doctor
```

Run one-shot commands through a spawned local runtime:

```bash
codex-toys workbench methods
codex-toys functions list --json
codex-toys workflow list --json
codex-toys turn run "Check workbench status" --wait
```

Start the runtime directly only when another process needs stdio JSON-RPC:

```bash
codex-toys runtime serve --cwd <workspace>
```

## HTTP Runtime Flow

Use the HTTP runtime only when a browser needs HTTP:

```bash
codex-toys runtime http --cwd <workspace> --static ./dashboard
```

The HTTP runtime exposes:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/app/:method
POST /api/workbench/:method
```

Build dashboards from `/api/schema` and generic RPC calls; do not add
feature-specific duplicated endpoint logic.

## SSH Runtime Flow

Start with a probe:

```bash
codex-toys --ssh <user@host> --cwd <remote-workspace> runtime preflight --json
codex-toys --ssh <user@host> --cwd <remote-workspace> fetch
codex-toys --ssh <user@host> --cwd <remote-workspace> runtime host-overview --json
codex-toys --ssh <user@host> --cwd <remote-workspace> workbench doctor
```

Examples:

```bash
codex-toys --ssh <user@host> --cwd <remote-workspace> workbench methods
codex-toys --ssh <user@host> --cwd <remote-workspace> functions list --json
codex-toys --ssh <user@host> --cwd <remote-workspace> workflow run check-release --event event.json --sandbox danger-full-access --approval-policy never
codex-toys --ssh <user@host> --cwd <remote-workspace> app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-toys --ssh <user@host> --cwd <remote-workspace> turn run "Check workbench status" --wait --sandbox danger-full-access --approval-policy never
```

Do not auto-install remote binaries. The local side needs `codex-toys`; the
remote side needs `node`, `codex-toys`, and `codex`.

Useful variables:

```bash
CODEX_TOYS_REMOTE_SSH_TARGET=<user@host>
CODEX_TOYS_REMOTE_CWD=<remote-workspace>
CODEX_TOYS_REMOTE_PATH_PREPEND=/home/user/.local/bin:/home/user/.bun/bin:/home/user/.cargo/bin
CODEX_TOYS_RUNTIME_COMMAND=codex-toys
CODEX_TOYS_REMOTE_CODEX_COMMAND=codex
```

Non-interactive SSH does not necessarily load login-shell PATH setup. Prefer
`CODEX_TOYS_REMOTE_PATH_PREPEND` or absolute command overrides. Do not put
inline `PATH=... command` strings in command variables.
