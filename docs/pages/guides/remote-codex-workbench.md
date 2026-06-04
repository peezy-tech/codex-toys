---
title: Remote Codex Workbench
description: Set up a VPS as a separate Codex workbench and operate it from local over SSH.
---

# Remote Codex Workbench

A remote Codex workbench is a separate Codex environment on a VPS or other SSH
host. The local machine sends commands over SSH. The remote machine owns Codex
auth, Codex state, the workbench root, and command execution.

Use this guide when the remote host should run Codex work while local tools
inspect or control it without opening a remote HTTP service.

## 1. Prepare the Remote Host

Install these on the remote host:

```text
node
codex
codex-toys
git
```

Create or choose a workbench root:

```bash
mkdir -p /srv/codex/workbenches/ops
cd /srv/codex/workbenches/ops
codex-toys workbench doctor --json
```

Authenticate Codex on the remote host. Commands sent through `--ssh` use the
remote Codex home and remote config; they do not use local Codex auth.

## 2. Verify SSH Preflight

From the local machine:

```bash
codex-toys --ssh <host-or-alias> --cwd /srv/codex/workbenches/ops remote preflight --json
codex-toys --ssh <host-or-alias> --cwd /srv/codex/workbenches/ops fetch
codex-toys --ssh <host-or-alias> --cwd /srv/codex/workbenches/ops workbench doctor --json
```

Prefer a stable OpenSSH host alias when possible:

```bash
codex-toys --ssh workbox --cwd /srv/codex/workbenches/ops fetch
```

The local command starts `codex-toys toybox serve` on the remote host over SSH
stdio. No backend tunnel, remote WebSocket URL, or long-running remote service
is required.

## 3. Fix Non-Interactive PATH

Non-interactive SSH often has a smaller PATH than an interactive shell. If
preflight cannot find Node, Codex, or codex-toys, pass explicit paths:

```bash
codex-toys \
  --ssh workbox \
  --cwd /srv/codex/workbenches/ops \
  --remote-path-prepend /opt/node/bin:/usr/local/bin \
  --toybox-command /usr/local/bin/codex-toys \
  --codex-command /usr/local/bin/codex \
  workbench doctor --json
```

Equivalent environment defaults:

```text
CODEX_TOYS_REMOTE_SSH_TARGET=workbox
CODEX_TOYS_REMOTE_CWD=/srv/codex/workbenches/ops
CODEX_TOYS_REMOTE_PATH_PREPEND=/opt/node/bin:/usr/local/bin
CODEX_TOYS_TOYBOX_COMMAND=/usr/local/bin/codex-toys
CODEX_TOYS_REMOTE_CODEX_COMMAND=/usr/local/bin/codex
CODEX_TOYS_REMOTE_CODEX_ARGS=["-s","danger-full-access"]
```

Keep private SSH keys local. If a managed identity is not available to OpenSSH,
add a local SSH config entry instead of copying keys to the remote host.

## 4. Run Remote Work

Use direct remote calls for quick checks:

```bash
codex-toys --ssh workbox --cwd /srv/codex/workbenches/ops functions list --json
codex-toys --ssh workbox --cwd /srv/codex/workbenches/ops workflow list --json
codex-toys --ssh workbox --cwd /srv/codex/workbenches/ops workflow run release-check --event event.json
```

SSH-backed `turn run` must wait because the remote toybox exits when the command
exits:

```bash
codex-toys --ssh workbox --cwd /srv/codex/workbenches/ops turn run \
  "Check workbench status." \
  --wait \
  --sandbox danger-full-access \
  --approval-policy never
```

For background work, use workbench delegation or deferred queues instead of a
detached SSH command.

## 5. Inspect Remote State

Remote state stays remote:

```text
<remote-workbench>/.codex/workbench/local/
<remote-workbench>/.codex/feed/local/
<remote-codex-home>/sessions/
<remote-codex-home>/memories/
```

The local machine receives command results over SSH. It does not automatically
copy remote Codex sessions, memories, or workbench state.

## 6. Optional Local Dashboard

For a browser UI, run the proxy locally and let it speak SSH to the remote
toybox:

```bash
codex-toys-proxy serve \
  --ssh workbox \
  --cwd /srv/codex/workbenches/ops \
  --static ./dashboard
```

The browser talks to the local proxy. The remote host still exposes no HTTP
port.

## Troubleshooting

- `remote preflight` fails before toybox startup: SSH target, remote cwd,
  remote PATH, Node, Codex, or codex-toys is missing.
- Toybox starts but app calls fail: inspect remote Codex auth and remote Codex
  config.
- Shell commands inside a turn are blocked: pass a sandbox mode or permissions
  profile supported by the remote Codex config.
- Inline JSON fails in a shell: use `--params-file` instead of inline JSON.
