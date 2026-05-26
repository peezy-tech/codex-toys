---
name: remote-control-operator
description: Use when a local Codex App or codex-flows CLI needs to operate a remote Codex workspace over SSH, including Codex App managed remote connections, SSH-backed fetch/app/workspace/automation commands, remote-agent preflight, or remote turn starts.
---

# Remote Control Operator

Use this skill when the user is operating from a local Codex App or local
`codex-flows` CLI and the target Codex workspace is on a remote machine
reachable over SSH or Tailscale.

## Direction

- Local machine: where the Codex App plugin and this skill are installed.
- Remote target: the machine where Codex, the workspace, `codex-flows`, and
  `CODEX_HOME` live.
- The local plugin does not install hooks or start a local backend.
- Prefer the global `--ssh` provider for one-shot automation. It starts
  `codex-flows remote-agent serve` on the target over SSH and speaks workspace
  JSON-RPC over the SSH stdio stream.
- Do not guide users toward old backend tunnels, `--remote-mode`, or remote
  workspace backend command overrides.

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
codex-flows --ssh <discovered-host-or-alias> --cwd <discovered-remote-project-path> turn run "Check workspace status" --wait --sandbox danger-full-access --approval-policy never
```

If a local OpenSSH host alias already includes the user and identity, prefer the
alias for stability:

```bash
codex-flows --ssh workbox --cwd /srv/repo fetch
```

Before running a workflow, verify the local shell can use the same connection:

```bash
codex-flows --ssh <discovered-host-or-alias> --cwd <discovered-remote-project-path> remote preflight
```

If this fails because Codex App has a managed identity but OpenSSH does not,
ask the user to add a local SSH config entry, or use a wrapper command via
`CODEX_FLOWS_SSH_COMMAND`. Do not copy private keys to the remote host.

If this Codex thread is already running inside the selected remote, do not treat
target-side shell checks as a successful SSH-provider test. The provider path
itself must be exercised from the local machine with `codex-flows --ssh ...`.

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

Local files such as `--event event.json` are read locally. Codex tools,
`CODEX_HOME`, and workspace execution happen on the remote target. Do not copy
local credentials to the target; SSH config and the remote environment own auth.

Useful defaults:

```bash
CODEX_FLOWS_REMOTE_SSH_TARGET=<user@host>
CODEX_FLOWS_REMOTE_CWD=<remote-workspace>
CODEX_FLOWS_REMOTE_PATH_PREPEND=/home/user/.local/bin:/home/user/.bun/bin:/home/user/.cargo/bin
CODEX_FLOWS_REMOTE_AGENT_COMMAND=codex-flows
CODEX_FLOWS_REMOTE_CODEX_COMMAND=codex
CODEX_FLOWS_REMOTE_CODEX_ARGS=["-s","danger-full-access"]
```

Non-interactive SSH may not load the same PATH as an interactive shell. Use
`CODEX_FLOWS_REMOTE_PATH_PREPEND` for remote Node, Bun/npm, Cargo, and local bin
directories, or use absolute `CODEX_FLOWS_REMOTE_AGENT_COMMAND` and
`CODEX_FLOWS_REMOTE_CODEX_COMMAND` values. Use
`CODEX_FLOWS_REMOTE_CODEX_ARGS` when Codex needs flags. Keep environment setup
out of command variables; do not use inline `PATH=... command` strings there.

If a remote binary is missing, report the command hint. The local machine needs
`codex-flows`; the remote machine needs `node`, `codex-flows`, and `codex`. Do
not auto-install Codex or codex-flows on the remote machine unless the user asks
for installation help.

## Remote Status

Use `remote status` when the user specifically wants to inspect the local Codex
App remote-control connection or direct local backend URLs:

```bash
codex-flows remote status --timeout-ms 1500
```

No backend is a valid diagnostic result. For SSH workflows, prefer
`remote preflight`.

## Remote Turn Start

For the one-shot SSH provider path, start the turn directly through `--ssh`:

```bash
codex-flows --ssh <user@host> --cwd <remote-workspace> turn run "Check workspace status" --wait --sandbox danger-full-access --approval-policy never
```

The older spelling is still useful when the user is specifically exercising
remote turn APIs:

```bash
codex-flows --ssh <user@host> --cwd <remote-workspace> remote turn start --via workspace --prompt "Check workspace status" --wait
```

## Troubleshooting

- `remote preflight` fails before the agent starts: SSH target unreachable,
  remote cwd missing, remote `node`, `codex-flows`, or `codex` missing, or
  non-interactive SSH PATH missing Node/Bun/npm/Cargo/local bin directories.
- `remote agent` starts but app-server initialization fails: inspect remote
  stderr and Codex auth/config on the remote host.
- `remote status` unavailable: no local app-server or direct backend URL is
  configured; use `remote preflight` for SSH.
- `remote turn start` cannot run shell commands: retry with
  `--sandbox danger-full-access` or a named `--permissions <profile>` that
  exists on the remote Codex config.
- Inline JSON fails on PowerShell: use `--params-json $params` or
  `--params-file params.json`.
