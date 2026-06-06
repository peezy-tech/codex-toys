---
title: Workbench
description: Repo-local config, tasks, modes, functions, health, and overview.
---

# Workbench

A workbench is the repository root codex-toys operates against. It can define
tasks, functions, feed sources, workflows, and generated runtime state under
`.codex`.

```text
.codex/
  workbench.toml
  feed.toml
  functions.ts
  workbench/
    local/
    actions/
```

## Modes

| Mode | Runtime Codex home | Generated state |
|------|--------------------|-----------------|
| `local` | The active user/global Codex home | `.codex/workbench/local` |
| `actions` | `<workbench>/.codex` | `.codex/workbench/actions` |
| `auto` | `actions` when `GITHUB_ACTIONS=true`, otherwise `local` | Resolved mode root |

Local mode avoids changing the user's active Codex home. Actions mode uses the
repo `.codex` home so CI work can use repo-local skills and memories.

## Commands

```bash
codex-toys workbench doctor
codex-toys workbench doctor --mode actions --json
codex-toys workbench run <task-id> --mode actions
codex-toys workbench dispatch run-due --mode actions
codex-toys workbench overview --json
codex-toys workbench init actions --forgejo [--image <ref>|--no-image]
```

`doctor` reports mode, roots, config, memory presence, task health, latest runs,
and queue health.

`run <task-id>` runs one configured task immediately. `dispatch run-due` drains
durable queued dispatch work. Clocks are owned by the host scheduler: systemd
timers for local machines and Actions schedules for repository autonomy.

## Config

```toml
[workbench]
name = "example"

[[workbench.tasks]]
id = "daily-check"
enabled = true
kind = "workflow"
workflow = "release-check"
history = "latest"

[[workbench.tasks]]
id = "node-version"
enabled = true
kind = "command"
command = ["node", "--version"]
history = "full"
```

Task ids should be lowercase slug-like ids. `history = "full"` is the default
and writes per-run status and output files. `history = "latest"` overwrites
stable latest status and output files for that task.

Task-level schedules and reactive rule blocks are not workbench config
surfaces. Put recurrence in systemd timers or Actions workflow schedules and
have those schedulers call explicit codex-toys commands.

## Task Kinds

`skill` runs a Codex skill. Actions mode resolves skills from
`.codex/skills/<skill>/SKILL.md`; local mode uses the active Codex home.

`workflow` runs a named workflow from `.codex/workflows/*` or `workflows/*`.
Workflow task runs create events with unique ids and can override manifest
defaults with task-level `prompt` and `cwd`.

`command` runs an explicitly configured command. Use it for small checks where a
skill or workflow would be unnecessary.

## Actions Mode

Scaffold an Actions-ready workbench:

```bash
codex-toys workbench init actions --forgejo
codex-toys workbench init actions --github
```

For the full GitHub Actions schedule setup, see
[Repository autonomy](../guides/repository-autonomy).

The generated runner prepares auth, runs `workbench dispatch run-due --mode actions`,
cleans up runtime-only files, and preserves durable workbench state. By default
it runs inside `ghcr.io/peezy-tech/codex-toys-actions:latest`, which supplies
Node, VitePlus, native Codex CLI, codex-toys, Git, and common shell tools. Pass
`--image <ref>` to use a custom image built from that base image, or `--no-image`
to generate a workflow that installs the runtime during every run. Durable state
may include:

```text
.codex/memories/
.codex/feed/actions/
.codex/workbench/actions/
.codex/sessions/
```

Raw rollout JSONL can include prompts, model output, tool calls, command output,
file paths, and other sensitive text. Commit Actions-mode sessions only in repos
where that history belongs in git.

## Overview

`workbench overview --json` returns a bounded dashboard-friendly snapshot:

- fetch and doctor summary
- queue counts and compact intents
- latest dispatch output status
- workflows
- functions
- recent cwd threads
- git state
- health checks for Node, codex-toys, Codex, toybox, app-server, and config

The proxy exposes the same data through `POST /api/workbench/overview`.
