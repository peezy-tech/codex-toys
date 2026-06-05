---
title: CLI Reference
description: Command porcelain over codex-toys primitives and components.
---

# CLI Reference

`codex-toys` is stdio-first workbench porcelain. Local commands spawn a toybox
when needed. SSH commands run the toybox on the remote host over SSH stdio.

## Fetch And Runtime

```bash
codex-toys fetch [--json] [--no-color]
codex-toys neofetch [--json] [--no-color]
codex-toys toybox serve [--cwd <path>]
codex-toys mcp serve
codex-toys host overview --json
codex-toys --ssh <target> --cwd <remote-workbench> fetch
codex-toys --ssh <target> --cwd <remote-workbench> remote preflight [--json]
codex-toys --ssh <target> --cwd <remote-workbench> remote host-overview --json
```

## Turn

```bash
codex-toys turn run <prompt> [--wait] [--thread-id <id>]
codex-toys --ssh <target> --cwd <remote-workbench> turn run <prompt> --wait
```

SSH-backed `turn run` requires `--wait`. Use delegation or dispatch queues for
supervised background work.

## Workflow

```bash
codex-toys workflow list [--json]
codex-toys workflow run <name> [--event <event.json>] [--prompt <text>] [--via workbench|app]
codex-toys workflow run --script <path> [--event <event.json>] [--prompt <text>] [--via workbench|app]
codex-toys workflow run --script-stdin [--event <event.json>] [--prompt <text>] [--via workbench|app]
codex-toys --ssh <target> --cwd <remote-workbench> workflow list [--json]
codex-toys --ssh <target> --cwd <remote-workbench> workflow run <name> [--event <event.json>]
```

## App-Server Calls

```bash
codex-toys app <method> [params-json]
codex-toys app <method> --params-json <json>
codex-toys app <method> --params-file <file>
codex-toys app call <method> [params-json]
echo '<params-json>' | codex-toys app <method>
codex-toys app actions
```

## Functions

```bash
codex-toys functions list [--json]
codex-toys functions describe <name> [--json]
codex-toys functions call <name> [--params-json <json>] [--json]
codex-toys --ssh <target> --cwd <remote-workbench> functions list [--json]
```

## Feed

```bash
codex-toys feed doctor [--mode auto|local|actions] [--json]
codex-toys feed source list [--json]
codex-toys feed poll [--source <source-id>] [--json]
codex-toys feed item list [--source <source-id>] [--status new] [--limit <n>] [--json]
codex-toys feed item read <item-id> [--json]
codex-toys feed collect [--cursor <name>] [--source <source-id>] [--limit <n>] [--no-advance] [--json]
codex-toys feed cursor advance --cursor <name> --item <item-id> [--json]
codex-toys feed dispatch --source <source-id> --cursor <name> --target workbench-task:<task-id> [--limit <n>] [--no-poll] [--json]
codex-toys feed prune --older-than-days <days> [--dry-run]
```

## Workbench

```bash
codex-toys workbench <method> [params-json]
codex-toys workbench <method> --params-json <json>
codex-toys workbench <method> --params-file <file>
codex-toys workbench call <method> [params-json]
codex-toys workbench app <method> [params-json]
codex-toys workbench methods
codex-toys workbench overview [--json]
codex-toys workbench doctor [--mode auto|local|actions] [--json]
codex-toys workbench tick [--mode auto|local|actions]
codex-toys workbench run <task-id> [--mode auto|local|actions]
codex-toys workbench init actions [--forgejo|--github] [--image <ref>|--no-image]
```

## Delegation

```bash
codex-toys workbench delegate list [--json]
codex-toys workbench delegate start --cwd @/workbenches/name --prompt <text> [--wait]
codex-toys workbench delegate start --cwd @/repos/name --prompt <text> --return-mode record_only
codex-toys --ssh <target> --cwd <remote-root> workbench delegate start --target-cwd @/repos/name --prompt <text>
```

## Dispatch Queues

```bash
codex-toys workbench dispatch create --params-json <json>
codex-toys workbench dispatch list [--mode auto|local|actions] [--json]
codex-toys workbench dispatch read <intent-id> [--include-output] [--json]
codex-toys workbench dispatch collect [--cursor <name>] [--json]
codex-toys workbench dispatch cancel <intent-id>
codex-toys workbench dispatch retry <intent-id> [--run-at <iso>]
codex-toys workbench dispatch run-due [--mode auto|local|actions]
codex-toys workbench dispatch prune --older-than-days <days> [--dry-run]
```

```bash
codex-toys workbench prompt enqueue <prompt> [--run-at <iso>] [--after <intent-id>]
codex-toys workbench prompt list [--queue <name>] [--status <status>] [--json]
codex-toys workbench prompt read <intent-id> [--include-output] [--json]
codex-toys workbench prompt pull <intent-id> [--json]
codex-toys workbench prompt collect [--cursor <name>] [--queue <name>] [--json]
codex-toys workbench prompt cancel <intent-id>
codex-toys workbench prompt retry <intent-id> [--run-at <iso>]
codex-toys workbench prompt run-due [--queue <name>] [--limit <n>]
```

```bash
codex-toys workbench handoff enqueue <prompt> [--target-host <host>] [--capability <name>]
codex-toys workbench handoff list [--queue <name>] [--status <status>] [--json]
codex-toys workbench handoff read <intent-id> [--include-output] [--json]
codex-toys workbench handoff pull <intent-id> [--json]
codex-toys workbench handoff collect [--cursor <name>] [--queue <name>] [--json]
codex-toys workbench handoff cancel <intent-id>
codex-toys workbench handoff retry <intent-id> [--run-at <iso>]
codex-toys workbench handoff drain [--host-id <host>] [--capability <name>] [--materialize]
```

## Codex State

```bash
codex-toys memories transplant global-to-workbench [--apply]
codex-toys memories transplant workbench-to-global [--apply]
codex-toys memories transplant global-to-workbench --merge codex [--apply]
```

```bash
codex-toys threads locate <thread-id> [--codex-home <home>]
codex-toys threads inspect <thread-id-or-rollout.jsonl> [--codex-home <home>]
codex-toys threads install-rollout <rollout.jsonl> [--codex-home <home>] [--cwd <path>] [--replace]
codex-toys threads transplant <thread-id> --from-codex-home <src> --to-codex-home <dst> [--cwd <path>] [--replace]
```

## Kits

```bash
codex-toys kit inspect <source> [--json]
codex-toys kit add <source> [--apply] [--include <name>] [--exclude <name>]
codex-toys kit setup <source> [--wait]
codex-toys kit doctor [--json]
codex-toys kit list [--json]
```

## Actions Helpers

```bash
codex-toys actions prepare-auth
codex-toys actions cleanup
```

## Proxy

```bash
codex-toys-proxy serve --cwd <workbench> [--static <dir>]
codex-toys-proxy serve --ssh <target> --cwd <remote-workbench> [--static <dir>]
```

Routes:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/host/overview
POST /api/app/:method
POST /api/workbench/:method
POST /api/workbench/overview
```

## Common Options

```text
--json
--pretty
--compact
--timeout-ms <ms>
--mode <auto|local|actions>
--workbench-root <path>
--feed-root <path>
--cwd <path>
--ssh <target>
--remote-path-prepend <paths>
--toybox-command <command>
--codex-command <command>
--codex-arg <arg>
--event <path>
--script <path>
--script-stdin
--prompt <text>
--title <text>
--queue <name>
--after <intent-id>
--after-status <status>
--limit <n>
--run-at <iso>
--sandbox <mode>
--approval-policy <policy>
--permissions <profile>
--apply
--overwrite
--replace
--dry-run
```
