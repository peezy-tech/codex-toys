# Remote Golden Path Local Agent Handoff

Date: 2026-05-26

Goal: rerun the Windows local Codex App to SSH remote CodexFlows path through
the remote-agent provider. The local CLI owns orchestration, while Codex
workspace execution happens on the remote host.

## Target

- Local machine: Windows Codex App host.
- Remote host: `peezy@rammstein`.
- Remote workspace: `/home/peezy/load-game-workspace`.
- Golden-path prompt: `scan current folder`.

## Required Package

Upgrade both the local Windows-side CLI and the remote host to the release that
includes the remote-agent provider:

```powershell
npm install -g @peezy.tech/codex-flows@latest
codex-flows fetch --no-color
```

On the remote host, `codex-flows` must also resolve from non-interactive SSH.
The SSH provider now starts:

```bash
codex-flows remote-agent serve --cwd /home/peezy/load-game-workspace
```

over SSH automatically. Do not pre-run this command manually during normal use.

## Local SSH Setup

Confirm the local OpenSSH client can use the Codex App managed remote identity.
If the host alias is not already configured, add this to
`C:\Users\range\.ssh\config`:

```sshconfig
Host rammstein
  HostName rammstein
  User peezy
  IdentityFile C:\Users\range\.ssh\keyless
```

Then verify from PowerShell:

```powershell
ssh rammstein 'pwd'
codex-flows --ssh rammstein --cwd /home/peezy/load-game-workspace remote preflight
```

If this fails only because PATH differs between interactive and non-interactive
SSH, continue with `CODEX_FLOWS_REMOTE_PATH_PREPEND`; do not add wrapper scripts
on the remote host.

## Local Environment For The Retry

Set remote PATH entries explicitly. Adjust the Node path if `fnm` has a
different active install path on `rammstein`.

```powershell
$env:CODEX_FLOWS_REMOTE_PATH_PREPEND="/home/peezy/.local/bin:/home/peezy/.bun/bin:/home/peezy/.cargo/bin:/home/peezy/.local/share/fnm/node-versions/v24.15.0/installation/bin"
$env:CODEX_FLOWS_REMOTE_AGENT_COMMAND="codex-flows"
$env:CODEX_FLOWS_REMOTE_CODEX_COMMAND="codex"
```

If command lookup still fails, switch to absolute command paths:

```powershell
$env:CODEX_FLOWS_REMOTE_AGENT_COMMAND="/home/peezy/.local/bin/codex-flows"
$env:CODEX_FLOWS_REMOTE_CODEX_COMMAND="/home/peezy/.local/bin/codex"
```

Do not set removed backend/tunnel variables such as
`CODEX_FLOWS_REMOTE_MODE`, `CODEX_FLOWS_REMOTE_TUNNEL_PORT`,
`CODEX_FLOWS_REMOTE_BACKEND_HOST`,
`CODEX_FLOWS_REMOTE_BACKEND_PORT`,
`CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND`, or
`CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_ARGS`. The new provider intentionally
rejects them so stale setup cannot mask the remote-agent path.

## Smoke Tests

Run these from the local Windows machine:

```powershell
codex-flows --ssh rammstein --cwd /home/peezy/load-game-workspace remote preflight
codex-flows --ssh rammstein --cwd /home/peezy/load-game-workspace fetch
codex-flows --ssh rammstein --cwd /home/peezy/load-game-workspace workspace doctor --json
$params = @{ limit = 20; sourceKinds = @() } | ConvertTo-Json -Compress
codex-flows --ssh rammstein --cwd /home/peezy/load-game-workspace app thread/list --params-json $params
```

Expected:

- The local CLI starts `codex-flows remote-agent serve` on the remote host.
- The remote agent starts Codex app-server on the remote host.
- No WebSocket port or SSH tunnel is opened.
- No local credentials are copied to the remote host.

## Golden Path Command

Run:

```powershell
codex-flows --ssh rammstein --cwd /home/peezy/load-game-workspace turn run "scan current folder" --wait --sandbox danger-full-access --approval-policy never
```

Expected:

- A remote thread is created in `/home/peezy/load-game-workspace`.
- A turn starts through the remote-agent workspace bridge.
- Shell tools run under the requested remote turn sandbox.
- The final assistant message is printed locally.
- The SSH remote-agent process exits when the command finishes.

## Cleanup Old Workarounds

These temporary remote wrappers are no longer part of the supported path. If
they are recreated during debugging, remove them after the remote-agent path
works:

```bash
rm -f /home/peezy/.local/bin/codex-danger-full-access
rm -f /home/peezy/.local/bin/codex-workspace-backend-local-path
```

## If It Still Fails

- `node` missing: update `CODEX_FLOWS_REMOTE_PATH_PREPEND` with the active fnm
  Node installation bin directory.
- `codex-flows` missing: install `@peezy.tech/codex-flows` on the remote host or
  set `CODEX_FLOWS_REMOTE_AGENT_COMMAND` to the absolute remote CLI path.
- `codex` missing: set `CODEX_FLOWS_REMOTE_CODEX_COMMAND` to the absolute remote
  Codex binary.
- SSH connection fails: fix local OpenSSH config or use `--ssh peezy@rammstein`
  if the identity is already discoverable.
- Turn starts but tools cannot execute: keep `--sandbox danger-full-access`, or
  use `--permissions <profile>` for a remote profile that exists in the remote
  Codex config. Do not combine `--sandbox` and `--permissions`.
