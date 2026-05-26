# Remote Golden Path Local Agent Handoff

Date: 2026-05-26

Goal: rerun the Windows local Codex App to SSH remote CodexFlows path without
temporary remote wrappers. The local CLI should own orchestration, while Codex
workspace execution happens on the remote host.

## Target

- Local machine: Windows Codex App host.
- Remote host: `peezy@rammstein`.
- Remote workspace: `/home/peezy/load-game-workspace`.
- Golden-path prompt: `scan current folder`.

## Required Updated Package

Upgrade the local Windows-side CLI to the released package that includes these
fixes:

```powershell
npm install -g @peezy.tech/codex-flows@0.132.8
codex-flows fetch --no-color
```

The `fetch` output should report `@peezy.tech/codex-flows@0.132.8`. If the
local agent is running from a source checkout instead of npm, pull the `0.132.8`
release commit or newer.

Version `0.132.8` includes the first SSH provider fix set plus the remote
workflow improvements below:

- `remote turn start` accepts and uses the SSH provider when `--ssh` is set.
- SSH provider accepts `--remote-path-prepend` and
  `CODEX_FLOWS_REMOTE_PATH_PREPEND`.
- `remote turn start` accepts `--sandbox`, `--approval-policy`, and
  `--permissions`.
- CLI JSON parsing tolerates a leading UTF-8 BOM.

- `turn run <prompt>` as the primary prompt primitive.
- `remote preflight` diagnostics for SSH, cwd, Node, Codex, backend startup, and
  app-server pass-through.
- `remote turn start --wait` final-answer readback.
- `--params-json` and `--params-file` for PowerShell-safe JSON params.
- Remote command args through `CODEX_FLOWS_REMOTE_CODEX_ARGS`,
  `CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_ARGS`, `--remote-codex-arg`, and
  `--remote-workspace-backend-arg`.
- Absolute `CODEX_FLOWS_REMOTE_CODEX_COMMAND` values are handed to the remote
  backend without literal shell quotes.
- `--params-json` tolerates the common PowerShell-stripped form such as
  `{limit:3,sourceKinds:[]}`.

Before retrying, make sure the local shell resolves this upgraded CLI. The
Codex plugin/skill alone is not enough; the local shell must be able to run
`codex-flows`.

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
codex-flows --ssh rammstein --cwd /home/peezy/load-game-workspace --remote-mode spawn remote preflight
```

If this fails only because PATH differs between interactive and non-interactive
SSH, continue with `CODEX_FLOWS_REMOTE_PATH_PREPEND`; do not add wrapper scripts
on the remote host.

## Local Environment For The Retry

Set remote PATH entries explicitly. Adjust the Node path if `fnm` has a
different active install path on `rammstein`.

```powershell
$env:CODEX_FLOWS_REMOTE_PATH_PREPEND="/home/peezy/.local/bin:/home/peezy/.bun/bin:/home/peezy/.cargo/bin:/home/peezy/.local/share/fnm/node-versions/v24.15.0/installation/bin"
$env:CODEX_FLOWS_REMOTE_CODEX_COMMAND="codex"
$env:CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND="codex-workspace-backend-local"
```

If command lookup still fails, switch to absolute command paths:

```powershell
$env:CODEX_FLOWS_REMOTE_CODEX_COMMAND="/home/peezy/.local/bin/codex"
$env:CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND="/home/peezy/.bun/bin/codex-workspace-backend-local"
```

Do not set `CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND` to an inline
`PATH=... command` string. PATH setup belongs in
`CODEX_FLOWS_REMOTE_PATH_PREPEND`.

## Smoke Tests

Run these from the local Windows machine:

```powershell
codex-flows --ssh rammstein --cwd /home/peezy/load-game-workspace --remote-mode spawn fetch
codex-flows --ssh rammstein --cwd /home/peezy/load-game-workspace --remote-mode spawn workspace doctor --json
$params = @{ limit = 20; sourceKinds = @() } | ConvertTo-Json -Compress
codex-flows --ssh rammstein --cwd /home/peezy/load-game-workspace --remote-mode spawn app thread/list --params-json $params
```

Expected:

- The provider starts a transient remote
  `codex-workspace-backend-local serve --local-app-server`.
- No remote `codex-flows` binary is required for these provider commands.
- No local credentials are copied to the remote host.

## Golden Path Command

Run:

```powershell
codex-flows --ssh rammstein --cwd /home/peezy/load-game-workspace --remote-mode spawn turn run "scan current folder" --wait --sandbox danger-full-access --approval-policy never
```

Expected:

- A remote thread is created in `/home/peezy/load-game-workspace`.
- A turn starts through the transient remote workspace backend.
- Shell tools run under the requested remote turn sandbox.
- The final assistant message is printed locally.
- The transient SSH/backend process exits when the command finishes.

## Cleanup Old Workarounds

These temporary remote wrappers were removed on `rammstein` during this handoff.
If they are recreated during debugging, remove them after the updated provider
path works:

```bash
rm -f /home/peezy/.local/bin/codex-danger-full-access
rm -f /home/peezy/.local/bin/codex-workspace-backend-local-path
```

## If It Still Fails

- `node` missing: update `CODEX_FLOWS_REMOTE_PATH_PREPEND` with the active fnm
  Node installation bin directory.
- `codex` missing: set `CODEX_FLOWS_REMOTE_CODEX_COMMAND` to the absolute remote
  Codex binary.
- `codex-workspace-backend-local` missing: set
  `CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND` to the absolute remote backend
  binary, or install the package on the remote host.
- SSH connection fails: fix local OpenSSH config or use `--ssh peezy@rammstein`
  if the identity is already discoverable.
- Turn starts but tools cannot execute: keep `--sandbox danger-full-access`, or
  use `--permissions <profile>` for a remote profile that exists in the remote
  Codex config. Do not combine `--sandbox` and `--permissions`.
