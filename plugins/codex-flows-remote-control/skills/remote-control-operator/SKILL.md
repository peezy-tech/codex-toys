---
name: remote-control-operator
description: Use when a local Codex App or codex-flows CLI needs to operate a remote Codex workspace over SSH, including Codex App managed remote connections, SSH-backed fetch/app/workspace/automation commands, transient remote workspace backends, manual tunnels, or remote turn starts.
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

## Codex App Managed Remotes

When the user has Codex App managed remote connection state, discover and use
that state as the map for the SSH provider. Do not hard-code a host, project,
identity path, or cwd from an example.

Discovery inputs may come from the local Codex App, app-server state, user
provided remote-inventory output, or local SSH config. Extract these fields when
available:

- Selected remote: the default target when the user did not name one.
- Remote display name or host id: a friendly label for disambiguation.
- Hostname: the OpenSSH target for `--ssh`, usually `user@host` or an alias.
- Identity: the local SSH key or auth profile the local machine must be able to
  use.
- Registered projects: project names mapped to remote workspace paths for
  `--cwd`.

Selection rules:

- If the user named a project, choose the remote project with that name.
- If the user named a remote, choose that remote and then the matching project
  or current workspace path.
- If neither is named, use the selected remote and the current/project-matching
  workspace when the inventory makes it unambiguous.
- If multiple remotes or projects match, ask a short clarifying question instead
  of guessing.

Build commands from the discovered values:

```bash
codex-flows --ssh <discovered-host-or-alias> --cwd <discovered-remote-project-path> remote preflight
codex-flows --ssh <discovered-host-or-alias> --cwd <discovered-remote-project-path> fetch
codex-flows --ssh <discovered-host-or-alias> --cwd <discovered-remote-project-path> workspace doctor
codex-flows --ssh <discovered-host-or-alias> --cwd <discovered-remote-project-path> automation run <name> --event event.json
```

For example, if discovery reports selected remote `workbox`, hostname
`user@workbox`, and project `repo` at `/srv/repo`, then run from the local
machine:

```bash
codex-flows --ssh user@workbox --cwd /srv/repo fetch
```

If a local OpenSSH host alias already includes the user and identity, prefer the
alias for stability:

```bash
codex-flows --ssh workbox --cwd /srv/repo fetch
```

Before running CodexFlows, verify the local shell can use the same connection:

```bash
codex-flows --ssh <discovered-host-or-alias> --cwd <discovered-remote-project-path> remote preflight
```

If this fails because Codex App has a managed identity but OpenSSH does not,
ask the user to add a local SSH config entry, or use a wrapper command via
`CODEX_FLOWS_SSH_COMMAND`. Do not copy private keys to the remote host.

If this Codex thread is already running inside the selected remote, do not treat
remote shell checks as a successful SSH-provider test. Target-side checks can
run without `--ssh`; the provider path itself must be exercised from the local
machine with `codex-flows --ssh ...`.

## SSH Provider Flow

Start with an explicit remote target and remote workspace cwd:

```bash
codex-flows --ssh <user@host> --cwd <remote-workspace> remote preflight
codex-flows --ssh <user@host> --cwd <remote-workspace> fetch
codex-flows --ssh <user@host> --cwd <remote-workspace> workspace doctor
codex-flows --ssh <user@host> --cwd <remote-workspace> app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-flows --ssh <user@host> --cwd <remote-workspace> automation run check-release --event event.json
codex-flows --ssh <user@host> --cwd <remote-workspace> turn run "Check workspace status" --wait --sandbox danger-full-access --approval-policy never
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
CODEX_FLOWS_REMOTE_PATH_PREPEND=/home/user/.local/bin:/home/user/.bun/bin:/home/user/.cargo/bin
CODEX_FLOWS_REMOTE_CODEX_COMMAND=codex
CODEX_FLOWS_REMOTE_CODEX_ARGS=["-s","danger-full-access"]
CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND=codex-workspace-backend-local
CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_ARGS=["--verbose"]
```

Non-interactive SSH may not load the same PATH as an interactive shell. Use
`CODEX_FLOWS_REMOTE_PATH_PREPEND` for remote Node, Bun, Cargo, and local bin
directories, or use absolute `CODEX_FLOWS_REMOTE_CODEX_COMMAND` and
`CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND` values. Use the JSON-array args
variables when a remote command needs flags. Keep environment setup out of
`CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND`; do not use inline `PATH=...
command` there.

If a remote binary is missing, report the command hint. The local machine needs
`codex-flows`; the remote machine needs `node`, `codex`, and
`codex-workspace-backend-local`. Do not auto-install Codex or codex-flows on the
remote machine.

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
codex-flows remote turn start --via workspace --prompt "Check workspace status" --wait
```

Use `--cwd <path>` when the remote app-server should start the thread in a
specific remote workspace path.

For the one-shot SSH provider path, start the turn directly through `--ssh`:

```bash
codex-flows --ssh <user@host> --cwd <remote-workspace> turn run "Check workspace status" --wait --sandbox danger-full-access --approval-policy never
```

## Troubleshooting

- `--ssh` unavailable: SSH target unreachable, local forwarded port in use,
  remote backend binary missing, remote `codex` command missing, or
  non-interactive SSH PATH missing Node/Bun/Cargo/local bin directories.
- `existing` mode unavailable: no remote backend is listening on the configured
  remote host/port.
- `spawn` mode unavailable: transient backend could not start on the remote
  host; check remote `codex-workspace-backend-local`, `codex`, Node, and cwd.
- `remote status` unavailable: no tunnel, backend not running, or wrong port.
- `remoteControl/status/read` unavailable on the app-server: the local Codex App
  may not expose the remote-control API yet; continue through the workspace
  backend tunnel if that is reachable.
- `remote turn start` cannot run shell commands: retry with
  `--sandbox danger-full-access` or a named `--permissions <profile>` that
  exists on the remote Codex config.
- Inline JSON fails on PowerShell: use `--params-json $params` or
  `--params-file params.json`.
