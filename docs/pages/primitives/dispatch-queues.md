---
title: Dispatch And Queues
description: Durable future run intents, prompt queues, local handoffs, retries, and collection.
---

# Dispatch And Queues

Dispatch is the durable "run this later" primitive. Prompt queue and local
handoff queue are intake surfaces that create dispatch intents without leaving
an agent process running. All dispatch state is stored under the workbench state
root for the selected mode.

```text
.codex/workbench/local/dispatch/
  intents/
  attempts/
  outputs/
  claims/
  collect-cursors/
```

Actions mode uses `.codex/workbench/actions/dispatch`.

## Dispatch Runs

The base dispatch queue stores future workbench intents. A target can be:

- a direct Codex turn
- a named workflow
- a configured workbench task

```bash
codex-toys workbench dispatch create --params-json '{"runAt":"2026-01-01T14:00:00.000Z","target":{"kind":"turn","prompt":"Review the workbench."}}'
codex-toys workbench dispatch list --json
codex-toys workbench dispatch run-due
codex-toys workbench dispatch read <intent-id> --include-output --json
codex-toys workbench dispatch collect --cursor operator --json
codex-toys workbench dispatch cancel <intent-id>
codex-toys workbench dispatch retry <intent-id>
codex-toys workbench dispatch prune --older-than-days 30 --dry-run
```

One-shot intents run at most once. Retry creates a new pending intent from
terminal history and leaves the original intent, attempts, and outputs in place.

## Prompt Queue

The prompt queue is the friendly surface for one-off prompts. It stores prompts
as dispatch turn intents with `source.kind = "prompt-queue"`.

```bash
codex-toys workbench prompt enqueue "Draft migration notes." --queue low-priority --effort low
codex-toys workbench prompt list --queue low-priority --json
codex-toys workbench prompt read <intent-id> --include-output --json
codex-toys workbench prompt run-due --queue low-priority --limit 1
codex-toys workbench prompt collect --cursor operator --queue low-priority --json
codex-toys workbench prompt cancel <intent-id>
codex-toys workbench prompt retry <intent-id>
```

Prompt entries can target an existing thread with `--thread-id`, set turn
options such as `--model`, `--service-tier`, `--effort`, `--sandbox`,
`--approval-policy`, or `--permissions`, and depend on another dispatch intent:

```bash
codex-toys workbench prompt enqueue "Continue after the audit." \
  --after <intent-id> \
  --after-status terminal
```

`terminal` accepts completed, failed, or canceled parents.

## Local Handoff Queue

The local handoff queue is for work discovered in one workbench that requires a
specific local controller host or local-only capability. Handoffs are dispatch
turn intents with `source.kind = "local-handoff"`, but generic drains skip them.

```bash
codex-toys workbench handoff enqueue "Run the dashboard smoke." \
  --queue local \
  --capability browser

codex-toys workbench handoff list --queue local --json
codex-toys workbench handoff drain --capability browser --limit 1
```

Use `--target-host <host-id>` when a handoff must be claimed by one specific
host. A drainer advertises itself with `--host-id <host-id>` and repeated
`--capability <name>` flags.

```bash
codex-toys workbench handoff enqueue "Update the local plugin install." \
  --target-host workstation \
  --capability plugin-install

codex-toys workbench handoff drain --host-id workstation --capability plugin-install
```

Use `--materialize` when the local controller should create a local prompt queue
entry instead of running the handoff immediately.

```bash
codex-toys workbench handoff drain \
  --capability browser \
  --materialize \
  --prompt-queue local-followups
```

## SSH

SSH is transport, not a third queue. With `--ssh`, queue commands operate on the
remote workbench's local queue through the remote toybox.

```bash
codex-toys --ssh <target> --cwd <remote-workbench> workbench dispatch list --json
codex-toys --ssh <target> --cwd <remote-workbench> workbench prompt run-due --limit 1
codex-toys --ssh <target> --cwd <remote-workbench> workbench handoff collect --cursor operator --json
```
