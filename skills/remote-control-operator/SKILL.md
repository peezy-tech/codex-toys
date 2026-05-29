---
name: remote-control-operator
description: Use when a local Codex App or codex-flows CLI needs to operate a remote Codex workspace over SSH through the codex-flows agent.
---

# Remote Control Operator

Use this skill when the user is operating from a local Codex App or local
`codex-flows` CLI and the target Codex workspace is on a remote machine
reachable over SSH or Tailscale.

## Direction

- Local machine: where the Codex App plugin and this skill are installed.
- Remote target: the machine where Codex, the workspace, `codex-flows`, and
  `CODEX_HOME` live.
- The local plugin does not install hooks or start a local service.
- Prefer the global `--ssh` provider. It starts `codex-flows agent serve` on
  the target over SSH and speaks workspace JSON-RPC over stdio.
- Do not guide users toward backend tunnels, service profiles, or WebSocket
  URLs.

## Codex App Managed Remotes

When the user has Codex App managed remote connection state, discover and use
that state as the map for the SSH provider. Do not hard-code a host, project,
identity path, or cwd from an example.

Extract these fields when available:

- selected remote
- remote display name or host id
- OpenSSH target or host alias
- identity or SSH config profile
- registered projects mapped to remote workspace paths

Build commands from discovered values:

```bash
codex-flows --ssh <host-or-alias> --cwd <remote-project-path> remote preflight
codex-flows --ssh <host-or-alias> --cwd <remote-project-path> fetch
codex-flows --ssh <host-or-alias> --cwd <remote-project-path> workspace doctor
codex-flows --ssh <host-or-alias> --cwd <remote-project-path> functions list --json
codex-flows --ssh <host-or-alias> --cwd <remote-project-path> automation list --json
codex-flows --ssh <host-or-alias> --cwd <remote-project-path> automation run <name> --event event.json
codex-flows --ssh <host-or-alias> --cwd <remote-project-path> turn run "Check workspace status" --wait --sandbox danger-full-access --approval-policy never
```

If a local OpenSSH host alias already includes the user and identity, prefer the
alias for stability:

```bash
codex-flows --ssh workbox --cwd /srv/repo fetch
```

If Codex App has a managed identity but OpenSSH cannot use it, ask the user to
add a local SSH config entry or use `CODEX_FLOWS_SSH_COMMAND`. Do not copy
private keys to the remote host.

## SSH Provider Flow

Start with an explicit remote target and remote workspace cwd:

```bash
codex-flows --ssh <user@host> --cwd <remote-workspace> remote preflight
codex-flows --ssh <user@host> --cwd <remote-workspace> fetch
codex-flows --ssh <user@host> --cwd <remote-workspace> workspace doctor
codex-flows --ssh <user@host> --cwd <remote-workspace> app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-flows --ssh <user@host> --cwd <remote-workspace> automation list --json
codex-flows --ssh <user@host> --cwd <remote-workspace> automation run check-release --event event.json --sandbox danger-full-access --approval-policy never
codex-flows --ssh <user@host> --cwd <remote-workspace> turn run "Check workspace status" --wait --sandbox danger-full-access --approval-policy never
```

With `--ssh`, automation listing, named resolution, `--event` loading, and
script execution happen on the remote target. Event paths are remote paths
resolved relative to `--cwd` unless absolute.

Useful defaults:

```bash
CODEX_FLOWS_REMOTE_SSH_TARGET=<user@host>
CODEX_FLOWS_REMOTE_CWD=<remote-workspace>
CODEX_FLOWS_REMOTE_PATH_PREPEND=/home/user/.local/bin:/home/user/.bun/bin:/home/user/.cargo/bin
CODEX_FLOWS_AGENT_COMMAND=codex-flows
CODEX_FLOWS_REMOTE_CODEX_COMMAND=codex
CODEX_FLOWS_REMOTE_CODEX_ARGS=["-s","danger-full-access"]
```

Non-interactive SSH may not load the same PATH as an interactive shell. Use
`CODEX_FLOWS_REMOTE_PATH_PREPEND` for remote Node, Bun/npm, Cargo, and local bin
directories, or use absolute command paths. Keep environment setup out of
command variables.

## Dashboard Option

For browser dashboards, use the explicit proxy:

```bash
codex-flows-proxy serve --ssh <user@host> --cwd <remote-workspace> --static ./dashboard
```

Dashboards should call `/api/schema`, `/api/app/:method`, and
`/api/workspace/:method` through `fetch`.

## Troubleshooting

- `remote preflight` fails before the agent starts: SSH target unreachable,
  remote cwd missing, remote `node`, `codex-flows`, or `codex` missing, or
  non-interactive SSH PATH missing expected bin directories.
- Agent starts but app-server initialization fails: inspect remote stderr and
  Codex auth/config on the remote host.
- A turn in the remote workspace cannot run shell commands: retry with
  `--sandbox danger-full-access` or a named `--permissions <profile>` that
  exists in the remote Codex config.
- Inline JSON fails on PowerShell: use `--params-json $params` or
  `--params-file params.json`.
