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
app-server over stdio, stores flow data under `.codex/workspace/local`, and
uses `.codex/workspace/local/hook-spool` for plugin hook events.

## Remote Backend Flow

For a remote backend, do not start local hooks or a local backend process.
Capture the endpoint and authentication model first. When the local Codex App
is on Windows and the target backend is on a Tailscale VPS, prefer the hookless
`codex-flows-remote-control` plugin plus an SSH tunnel.

Probe the local app and expected backend URL:

```bash
codex-flows remote status
```

Preview and then start the tunnel:

```bash
codex-flows remote tunnel start --ssh <user@tailscale-host> --dry-run
codex-flows remote tunnel start --ssh <user@tailscale-host>
```

Start a turn through the tunneled backend:

```bash
codex-flows remote turn start --via workspace --prompt "Check workspace status"
```

Useful variables:

```bash
CODEX_FLOWS_REMOTE_BACKEND_URL=
CODEX_FLOWS_REMOTE_BACKEND_TOKEN=
CODEX_FLOWS_REMOTE_SSH_TARGET=
```

## Checks

- `workspace doctor` should show Node version, backend reachability, hook spool
  path, plugin hook discovery, and a suggested next command.
- If hooks are not discovered, install `codex-flows-local-workspace` and start a
  new Codex thread.
- If the backend is unreachable after setup, run `workspace backend start`.
- If the backend starts but hooks do not write events, align
  `CODEX_FLOWS_HOOK_SPOOL_DIR` with the setup env file.
