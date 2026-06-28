---
title: Workflow
description: The codex-toys primitive for running script code before composing native Codex work.
---

# Workflow

Workflow is the pre-turn orchestration primitive. A workflow runs a JavaScript or
TypeScript module, gives it a JSON context, and records the JSON object returned
by the module. The script can decide to skip, return data, start a Codex turn,
or wait on several native Codex turns.

```text
event, schedule, or operator command
  -> workflow script
     -> return JSON
     -> optionally call context.turn.*
```

The CLI does not interpret returned `action` fields. The script owns its own
decision and uses host helpers when it needs Codex work.

## Layout

Named workflows live under either `.codex/workflows/<name>/workflow.json` or
`workflows/<name>/workflow.json`.

```text
workflows/release-check/
  workflow.json
  check.ts
  prompt.md
```

```json
{
  "name": "release-check",
  "description": "Inspect a release signal before asking Codex to act.",
  "script": "check.ts",
  "promptFile": "prompt.md",
  "cwd": "@",
  "timeoutMs": 1800000,
  "config": {
    "source": "release-feed"
  }
}
```

Manifest `cwd` supports:

- `@` for the workbench root that discovered the workflow
- `@/path` for a path inside that workbench root
- relative paths from the workflow directory
- absolute paths only when the caller deliberately supplies one

## Run

```bash
codex-toys workflow list
codex-toys workflow run release-check --event event.json
codex-toys workflow run --script ./check.ts --event event.json
printf '%s\n' 'export default () => ({ status: "ok" })' | codex-toys workflow run --script-stdin
```

By default, workflow turns use the workbench runtime surface. Use `--via app`
only when deliberately targeting direct app-server calls without workbench
helpers.

```bash
codex-toys workflow run release-check --event event.json --via workbench
codex-toys workflow run release-check --event event.json --via app
```

Run the workflow on a remote host through SSH stdio:

```bash
codex-toys --ssh <target> --cwd <remote-workspace> workflow list --json
codex-toys --ssh <target> --cwd <remote-workspace> workflow run release-check --event event.json
```

With `--ssh`, discovery, named resolution, event loading, and script execution
happen on the remote host. `--event` is a remote path, resolved relative to
`--cwd` unless it is absolute.

## Context

The script exports a default handler:

```ts
export default async function run(context) {
  if (context.event?.type !== "release.detected") {
    return { status: "skipped", reason: "not a release event" };
  }

  const turn = await context.turn.start({
    prompt: context.prompt ?? "Inspect the release and report next steps.",
    cwd: context.cwd
  });

  return { status: "started", turn };
}
```

The context includes:

- `workflow`: source kind, name, manifest path, script path, and manifest config
- `runtime.startedAt`
- optional `event`
- optional `prompt`
- optional `cwd`
- optional `workbenchRoot`

Host helpers include:

- `context.app.call(method, params)`
- `context.workbench.call(method, params)`, only through the runtime surface
- `context.turn.start(params)`
- `context.turn.read(turn)`
- `context.turn.wait(turn, options)`
- `context.turn.waitAll(turns, options)`

## Turn Fields

`context.turn.start` accepts:

- `prompt`
- `threadId`
- `cwd`
- `model`
- `serviceTier`
- `effort`
- `sandbox`
- `approvalPolicy`
- `permissions`
- `responsesapiClientMetadata`
- `outputSchema`
- `skills`

Do not combine a sandbox mode with a permissions profile unless the target Codex
host explicitly supports that combination.

## Background Work

Workflow does not create a second thread registry. When background work belongs
in another checkout, start or resume native Codex turns directly through
`context.turn.*`, dispatch queues, or explicit app-server calls, then return the
thread id and `codex://thread/<id>` link from the script result.

```ts
export default async function run(context) {
  const turn = await context.turn.start({
    cwd: "@/repos/example",
    prompt: "Inspect this repository and summarize risks."
  });

  return {
    status: "started",
    threadId: turn.threadId,
    threadUrl: turn.threadId ? `codex://thread/${turn.threadId}` : undefined
  };
}
```

Native Codex owns thread discovery, open links, archive/delete, fork, resume,
and app UI control.

## Workbench Tasks

Workbench tasks can run named workflows from `workbench run`, dispatch targets,
or feed dispatch:

```toml
[workbench]
name = "example"

[[workbench.tasks]]
id = "release-check"
enabled = true
kind = "workflow"
workflow = "release-check"
```

Use systemd timers or Actions schedules to call explicit commands when a
workflow should run on a clock. Durable dispatch and feed dispatch can also
target the workflow-backed task so queued work shares the same attempt, output,
retry, and collection path.
