---
title: Remote Runtime
description: Operate a Codex workspace on an SSH host through codex-toys runtime stdio.
---

# Remote Runtime

A remote runtime is a Codex environment on a VPS or SSH host that is controlled
from local commands. The remote machine owns Codex auth, config, sessions,
memories, and workspace state. The local machine starts a short-lived
`codex-toys runtime serve` process over SSH stdio for each command.

## Prepare The Host

Install these on the remote host:

- Node 24
- Codex CLI
- `codex-toys`
- a working shell for non-interactive SSH

Authenticate Codex on the remote host. Commands sent through `--ssh` use the
remote Codex home and remote config; they do not use local Codex auth.

## Check Connectivity

```bash
codex-toys --ssh <host-or-alias> --cwd /srv/codex/workspaces/ops runtime preflight --json
```

Preflight checks SSH, cwd, Node, Codex, codex-toys, runtime startup, and native
app-server initialization.

## Configure PATH

Non-interactive SSH shells often have a smaller PATH than login shells. Use
explicit command paths or prepend entries:

```bash
codex-toys --ssh workbox \
  --cwd /srv/codex/workspaces/ops \
  --remote-path-prepend /opt/node/bin:/usr/local/bin \
  --runtime-command /usr/local/bin/codex-toys \
  --codex-command /usr/local/bin/codex \
  runtime preflight --json
```

Environment equivalents:

```text
CODEX_TOYS_REMOTE_SSH_TARGET=workbox
CODEX_TOYS_REMOTE_CWD=/srv/codex/workspaces/ops
CODEX_TOYS_REMOTE_PATH_PREPEND=/opt/node/bin:/usr/local/bin
CODEX_TOYS_RUNTIME_COMMAND=/usr/local/bin/codex-toys
CODEX_TOYS_REMOTE_CODEX_COMMAND=/usr/local/bin/codex
CODEX_TOYS_REMOTE_CODEX_ARGS=["-s","danger-full-access"]
```

## Run Remote Work

Use direct remote calls for quick checks:

```bash
codex-toys --ssh workbox --cwd /srv/codex/workspaces/ops fetch
codex-toys --ssh workbox --cwd /srv/codex/workspaces/ops functions list --json
codex-toys --ssh workbox --cwd /srv/codex/workspaces/ops workflow run release-check --event event.json
codex-toys --ssh workbox --cwd /srv/codex/workspaces/ops turn run "Scan current folder" --wait
```

SSH-backed `turn run` must wait because the remote runtime exits when the
command exits. Use prompt queues, dispatch queues, workflows, or native Codex
threads for work that should continue independently.

## Inspect Remote State

Remote state stays remote:

```text
<remote-workspace>/.codex/workbench/local/
<remote-workspace>/.codex/feed/local/
<remote-codex-home>/sessions/
<remote-codex-home>/memories/
```

`codex-toys` does not copy remote Codex sessions, memories, or workbench state.
Use the Codex App and native thread links for app-native thread discovery.

## Browser Access

For a browser UI, run the HTTP edge locally and let it speak SSH to the remote
runtime:

```bash
codex-toys runtime http \
  --ssh workbox \
  --cwd /srv/codex/workspaces/ops \
  --static ./dashboard
```

The browser talks to localhost. The remote host still exposes no HTTP port.

## Troubleshooting

- `runtime preflight` fails before runtime startup: SSH target, remote cwd,
  remote PATH, Node, Codex, or codex-toys is missing.
- Runtime starts but app calls fail: inspect remote Codex auth and remote Codex
  config.
- SSH prompt turns need `--wait`: use native Codex threads, queues, or workflows
  for supervised background work.
