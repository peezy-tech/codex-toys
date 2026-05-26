---
name: backend-setup-operator
description: Use when setting up, starting, checking, or repairing codex-flows workspace backends from a Codex plugin install, including local backend env files, hook spool alignment, backend reachability, and remote backend configuration.
---

# Backend Setup Operator

Use this skill when a user wants the backend setup story after installing a
codex-flows plugin.

## Boundaries

- Plugin install gives Codex skills, hooks, MCP config, and scripts.
- A workspace backend is a process. Starting or installing it must stay an
  explicit user-approved action.
- Prefer plugin-bundled hooks over editing `~/.codex/hooks.json`.
- Keep local and remote backend setup separate. Local backends own a host
  process and hook spool. Remote backends own endpoint/auth configuration and
  should not install local hooks.

## Local Backend Flow

1. Check the workspace:

```bash
codex-flows workspace doctor
```

2. Create local backend defaults:

```bash
codex-flows workspace backend init local
```

3. Start the backend in the foreground:

```bash
codex-flows workspace backend start
```

4. Check status:

```bash
codex-flows workspace backend status
```

The local backend defaults to `ws://127.0.0.1:3586`, starts a local Codex
app-server over stdio, and uses `.codex/workspace/local/hook-spool` for plugin
hook events.

## Remote Backend Flow

For a remote backend, do not start local hooks or a local backend process. The
preferred automation path is the SSH-backed provider: the local CLI reads local
inputs, while Codex tools, `CODEX_HOME`, and workspace execution happen on the
remote target.

Start with a probe:

```bash
codex-flows --ssh <user@host> --cwd <remote-workspace> fetch
codex-flows --ssh <user@host> --cwd <remote-workspace> workspace doctor
```

Provider modes:

- `auto`: probe an existing remote backend, then spawn a transient remote
  `codex-workspace-backend-local serve --local-app-server`.
- `existing`: require a remote backend already listening on the configured
  host/port.
- `spawn`: always own a transient remote backend for this command.

Examples:

```bash
codex-flows --ssh <user@host> --cwd <remote-workspace> --remote-mode existing workspace methods
codex-flows --ssh <user@host> --cwd <remote-workspace> --remote-mode spawn automation run check-release --event event.json
codex-flows --ssh <user@host> --cwd <remote-workspace> app thread/list '{"limit":20,"sourceKinds":[]}'
codex-flows --ssh <user@host> --cwd <remote-workspace> remote turn start --sandbox danger-full-access --approval-policy never --prompt "Check workspace status"
```

Do not auto-install remote binaries. The local side needs `codex-flows`; the
remote side needs `node`, `codex`, and `codex-workspace-backend-local`. If a
remote command is missing, report the command override and PATH hints and let
the user install or configure the remote environment.

Useful variables:

```bash
CODEX_FLOWS_REMOTE_SSH_TARGET=<user@host>
CODEX_FLOWS_REMOTE_CWD=<remote-workspace>
CODEX_FLOWS_REMOTE_MODE=spawn
CODEX_FLOWS_REMOTE_PATH_PREPEND=/home/user/.local/bin:/home/user/.bun/bin:/home/user/.cargo/bin
CODEX_FLOWS_REMOTE_CODEX_COMMAND=codex
CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND=codex-workspace-backend-local
```

Non-interactive SSH does not necessarily load login-shell PATH setup. Prefer
`CODEX_FLOWS_REMOTE_PATH_PREPEND` or absolute command overrides; do not put
inline `PATH=... command` strings in
`CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND`.

Manual tunnels remain useful for long-lived sessions or diagnostics:

```bash
codex-flows remote status
codex-flows remote tunnel start --ssh <user@tailscale-host> --dry-run
codex-flows remote tunnel start --ssh <user@tailscale-host>
```

With a manual tunnel up, a remote turn can still be started through the
tunneled backend:

```bash
codex-flows remote turn start --via workspace --prompt "Check workspace status"
```

## Checks

- `workspace doctor` should show Node version, backend reachability, hook spool
  path, plugin hook discovery, and a suggested next command.
- If hooks are not discovered, install `codex-flows-local-workspace` and start a
  new Codex thread.
- If the backend is unreachable after setup, run `workspace backend start`.
- If the backend starts but hooks do not write events, align
  `CODEX_FLOWS_HOOK_SPOOL_DIR` with the setup env file.
