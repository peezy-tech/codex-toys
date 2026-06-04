---
title: Toybox
description: Local and SSH stdio runtime for codex-toys workbench methods.
---

# Toybox

The toybox is the stdio JSON-RPC runtime behind codex-toys workbench operation.
It is not an HTTP service. Local commands spawn it over stdio. SSH commands start
the same toybox on the remote host and speak JSON-RPC over SSH stdio.

```bash
codex-toys toybox serve --cwd <workbench>
codex-toys --ssh <target> --cwd <remote-workbench> fetch
```

## Method Families

`toybox.initialize` advertises available methods and metadata. Built-in method
families include:

- app-server pass-through through `app.call`
- workflow list/run methods
- workbench functions from `.codex/functions.ts`, `.js`, or `.mjs`
- feed methods
- delegation methods
- deferred, prompt queue, and local handoff methods
- workbench doctor, task, and overview methods
- host overview methods

## Direct App Calls

Use app calls for native Codex app-server methods:

```bash
codex-toys app thread/list '{"limit":20,"sourceKinds":[]}'
codex-toys app thread/read --params-json '{"threadId":"<thread-id>"}'
codex-toys --ssh <target> --cwd <remote-workbench> app thread/list '{"limit":20,"sourceKinds":[]}'
```

The toybox forwards those methods without turning them into workbench-owned
state.

## Workbench Calls

Use workbench calls for toybox-owned behavior:

```bash
codex-toys workbench methods
codex-toys workbench overview --json
codex-toys workbench delegation.list
codex-toys workbench deferred.list --params-json '{"limit":5}'
```

The shorter command groups, such as `workbench delegate` and `workbench
deferred`, are CLI porcelain over these JSON-RPC methods.

## SSH

SSH operation keeps the command local while the workbench runs on the remote
host.

```bash
codex-toys --ssh <target> --cwd <remote-workbench> remote preflight --json
codex-toys --ssh <target> --cwd <remote-workbench> workbench doctor
codex-toys --ssh <target> --cwd <remote-workbench> workflow run release-check --event event.json
```

Useful remote options:

```bash
--ssh <target>
--cwd <remote-workbench>
--remote-path-prepend /home/user/.local/bin:/home/user/.bun/bin
--toybox-command /home/user/.local/bin/codex-toys
--codex-command /home/user/.local/bin/codex
--codex-arg -s --codex-arg danger-full-access
```

Useful environment variables:

```bash
CODEX_TOYS_REMOTE_SSH_TARGET=<target>
CODEX_TOYS_REMOTE_CWD=<remote-workbench>
CODEX_TOYS_REMOTE_PATH_PREPEND=/home/user/.local/bin:/home/user/.bun/bin
CODEX_TOYS_TOYBOX_COMMAND=codex-toys
CODEX_TOYS_REMOTE_CODEX_COMMAND=codex
CODEX_TOYS_REMOTE_CODEX_ARGS=["-s","danger-full-access"]
```

SSH-backed `turn run` requires `--wait`, because the remote toybox exits when the
command exits. Use delegation or deferred queues for supervised background work.

## Functions

Workbench functions are JSON-in/JSON-out helpers loaded from the selected
workbench.

```bash
codex-toys functions list --json
codex-toys functions describe <name> --json
codex-toys functions call <name> --params-json '{"key":"value"}' --json
codex-toys --ssh <target> --cwd <remote-workbench> functions list --json
```

Functions are a good fit for dashboard snapshots and product-owned read/write
helpers. The product owns function semantics; codex-toys owns discovery and
transport.
