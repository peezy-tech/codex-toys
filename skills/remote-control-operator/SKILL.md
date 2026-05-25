---
name: remote-control-operator
description: Use when a local Codex App or codex-flows CLI needs to operate a remote Codex workspace over SSH, including SSH-backed fetch/app/workspace/automation commands, transient remote workspace backends, manual tunnels, or remote turn starts.
---

# Remote Control Operator

Use this skill when the user is operating from a local Codex App or local
`codex-flows` CLI and the target Codex workspace is on a remote machine
reachable over SSH or Tailscale.

## Direction

- Local machine: where the Codex App plugin and this skill are installed.
- Remote target: the machine where Codex, the workspace, and any workspace
  backend or transient backend process runs.
- The local plugin does not install hooks or start a local backend.
- Prefer the global `--ssh` provider for one-shot automation. It starts a
  transient remote backend by default, or uses an existing remote backend when
  `--remote-mode existing` is set.
- Keep manual tunnels for long-lived sessions, diagnostics, or when another
  local process needs a stable `ws://127.0.0.1:<port>` backend URL.

## SSH Provider Flow

Start with an explicit remote target and remote workspace cwd:

```bash
codex-flows --ssh <user@host> --cwd <remote-workspace> fetch
codex-flows --ssh <user@host> --cwd <remote-workspace> workspace doctor
codex-flows --ssh <user@host> --cwd <remote-workspace> app thread/list '{"limit":20,"sourceKinds":[]}'
codex-flows --ssh <user@host> --cwd <remote-workspace> automation run check-release --event event.json
```

Use `--remote-mode spawn` by default. It starts a transient remote
`codex-workspace-backend-local serve --local-app-server`. Use `existing` when a
daemon or manual backend must already be running.

Local files such as `--event event.json` are read locally. Codex tools,
`CODEX_HOME`, and workspace execution happen on the remote target. Do not copy
local credentials to the target; SSH config and the remote environment own auth.

Useful defaults:

```bash
CODEX_FLOWS_REMOTE_SSH_TARGET=<user@host>
CODEX_FLOWS_REMOTE_CWD=<remote-workspace>
CODEX_FLOWS_REMOTE_MODE=spawn
CODEX_FLOWS_REMOTE_TUNNEL_PORT=3586
CODEX_FLOWS_REMOTE_BACKEND_HOST=127.0.0.1
CODEX_FLOWS_REMOTE_BACKEND_PORT=3586
CODEX_FLOWS_REMOTE_CODEX_COMMAND=codex
CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND=codex-workspace-backend-local
```

If the remote binary is missing, report the command hint. Do not auto-install
Codex or codex-flows on the remote machine.

## Remote Status

Use the older remote-status surface when the user specifically wants to inspect
the local Codex App remote-control connection or a long-lived backend URL:

```bash
codex-flows remote status --timeout-ms 1500
```

If both surfaces are unavailable, report that clearly. No backend is a valid
diagnostic result.

## Manual Tunnel Flow

Preview the tunnel command:

```bash
codex-flows remote tunnel start --ssh <user@tailscale-host> --dry-run
```

Start the tunnel in a long-running terminal:

```bash
codex-flows remote tunnel start --ssh <user@tailscale-host>
```

Defaults:

- Local WebSocket URL: `ws://127.0.0.1:3586`
- Remote backend address: `127.0.0.1:3586`
- Override with `--local-port`, `--remote-host`, and `--remote-port`.

Environment variables:

```bash
CODEX_FLOWS_REMOTE_SSH_TARGET=<user@tailscale-host>
CODEX_FLOWS_REMOTE_TUNNEL_PORT=3586
CODEX_FLOWS_REMOTE_BACKEND_HOST=127.0.0.1
CODEX_FLOWS_REMOTE_BACKEND_PORT=3586
```

## Persistent Remote Backend

Use this only when the user wants a long-lived remote backend rather than the
transient `--ssh` provider. On the remote target, run the backend from the
target workspace:

```bash
codex-flows workspace backend init local
codex-flows workspace backend start
```

The backend can stay bound to `127.0.0.1`; the SSH tunnel exposes it to the
local Codex App machine.

## Remote Turn Start

After a manual tunnel is up, recheck status:

```bash
codex-flows remote status --workspace-url ws://127.0.0.1:3586
```

Start a turn on the remote backend:

```bash
codex-flows remote turn start --via workspace --prompt "Check workspace status"
```

Use `--cwd <path>` when the remote app-server should start the thread in a
specific remote workspace path.

## Troubleshooting

- `--ssh` unavailable: SSH target unreachable, local forwarded port in use,
  remote backend binary missing, or remote `codex` command missing.
- `existing` mode unavailable: no remote backend is listening on the configured
  remote host/port.
- `spawn` mode unavailable: transient backend could not start on the remote
  host; check remote `codex-workspace-backend-local`, `codex`, Node, and cwd.
- `remote status` unavailable: no tunnel, backend not running, or wrong port.
- `remoteControl/status/read` unavailable on the app-server: the local Codex App
  may not expose the remote-control API yet; continue through the workspace
  backend tunnel if that is reachable.
- `remote turn start` fails through `auto`: retry with `--via workspace` to make
  the intended tunnel path explicit.
