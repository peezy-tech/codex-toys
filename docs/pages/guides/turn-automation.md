---
title: Turn automation
description: Run a pre-turn script that can return JSON, start turns, wait on turns, or compose native Codex work.
---

# Turn automation

Turn automation is the plugin-native automation shape for codex-toys. A script
runs first, inspects external state, and returns a JSON object. When it needs
Codex work, it starts, reads, waits on, or composes native Codex turns through
the host API.

This is prompt automation, not skill automation. Skills remain normal Codex
capabilities that the resulting turn may use. The automation itself is just code
that can check APIs, repositories, files, queues, release feeds, or any other
external signal before spending Codex turns.

```text
event, schedule, or operator command
  -> pre-turn script
     -> return JSON
     -> optionally start native Codex turns with prompt/cwd/settings
     -> start/wait/read multiple native Codex turns and return JSON
```

## Run an automation

Named automations live under `.codex/automations/<name>/automation.json` or
`automations/<name>/automation.json`:

```bash
codex-toys automation list
codex-toys automation run check-release --event event.json --via workbench
```

The manifest points to a module script and optional defaults:

```json
{
  "name": "check-release",
  "description": "Start a turn when a release needs inspection.",
  "script": "check-release.ts",
  "promptFile": "prompt.md",
  "cwd": "@/fork"
}
```

Manifest `cwd` supports three path forms:

- `@`: the workbench root used to discover the automation.
- `@/path`: a path inside that workbench root, such as `@/fork`.
- Relative paths: legacy paths relative to the automation directory.

The script exports a default handler and receives a context object:

```json
{
  "automation": {
    "scriptPath": "/repo/automations/check-release.ts"
  },
  "runtime": {
    "startedAt": "2026-05-25T00:00:00.000Z"
  },
  "event": {
    "type": "upstream.release",
    "payload": {
      "repo": "openai/codex",
      "tag": "rust-v1.2.3"
    }
  },
  "prompt": "optional default prompt",
  "cwd": "/repo/fork",
  "workbenchRoot": "/repo"
}
```

At runtime the context also includes a small host API:

- `context.app.call(method, params)`: call an app-server method.
- `context.workbench.call(method, params)`: call a codex-toys toybox method.
  This is only available when running `--via workbench`.
- `context.turn.start(params)`: start a native turn and return
  `{ id?, via, threadId, turnId, thread, turn }`.
- `context.turn.read(turn)`: read the latest snapshot for a started turn.
- `context.turn.wait(turn, options)`: wait until a turn is no longer
  `inProgress`, returning `status`, `outputText`, `thread`, and `turn`.
- `context.turn.waitAll(turns, options)`: wait for multiple turns.
- `context.delegate.start(params)`: start a delegated Codex thread through the
  toybox. This is only available when running `--via workbench`.
- `context.delegate.read(delegation)` and `context.delegate.wait(delegation,
  options)`: refresh or wait on a delegated thread record.

```ts
export default async function run(context) {
  if (context.event?.payload?.repo !== "openai/codex") {
    return { status: "skipped", reason: "not the Codex upstream" };
  }

  const turn = await context.turn.start({
    cwd: context.cwd,
    prompt: `Inspect ${context.event.payload.tag} and decide whether to update the fork.`
  });

  return {
    status: "started",
    turn
  };
}
```

## Return Contract

The handler must return a JSON object. The CLI records that object as the
automation result; it does not interpret `action` fields or start an implicit
turn from the return value.

Skip-like results are just ordinary JSON:

```json
{
  "status": "skipped",
  "reason": "nothing changed"
}
```

Start a turn through `context.turn.start`:

```ts
export default async function run(context) {
  const turn = await context.turn.start({
    prompt: "Check the upstream release and prepare the patch stack update.",
    cwd: "/repo",
    model: "gpt-5.2",
    permissions: "default"
  });

  return {
    status: "started",
    turn
  };
}
```

Supported turn fields:

- `prompt`: required text for the native turn.
- `threadId`: continue an existing thread instead of creating a new one.
- `cwd`: target workbench cwd for the turn.
- `model`, `serviceTier`, `sandbox`, `approvalPolicy`, `permissions`:
  forwarded to app-server when present.
- `responsesapiClientMetadata`: string metadata forwarded to the turn.
- `outputSchema`: JSON Schema for the final assistant response.
- `skills`: forwarded as turn-scoped routing metadata for hosts that support it.

Delegated work:

```ts
export default async function run(context) {
  const delegation = await context.delegate.start({
    cwd: "@/workbenches/trading",
    title: "Trading workbench check",
    prompt: "Inspect the trading workbench status and report risks.",
    returnMode: "wake_on_done"
  });

  return {
    status: "delegated",
    delegation
  };
}
```

Delegation `cwd` supports `@/path` relative to the toybox workbench root. Use
absolute cwd values only for trusted local toyboxes that explicitly allow them.

Programmatic orchestration:

```ts
export default async function run(context) {
  const turns = await Promise.all(["linux", "mac"].map((id) =>
    context.turn.start({
      id,
      prompt: `Check the release on ${id}.`,
      cwd: context.cwd
    })
  ));

  const results = await context.turn.waitAll(turns, {
    timeoutMs: 20 * 60 * 1000,
    pollIntervalMs: 1000
  });

  return {
    status: "completed",
    rows: results.map((item) => ({
      id: item.id,
      threadId: item.threadId,
      turnId: item.turnId,
      outputText: item.outputText
    }))
  };
}
```

If the automation needs a CSV, markdown report, or other file, write it directly
from the script with normal JavaScript APIs such as `node:fs/promises`, then
include the path in the returned JSON object.

## Local and remote targets

Automation starts the turn through the codex-toys toybox by default.
Use `--via app` only when deliberately targeting a direct app-server connection:

```bash
codex-toys automation run check-release --event event.json --via workbench
```

The same command can target a remote workbench through the SSH provider:

```bash
codex-toys --ssh devbox --cwd /repo automation list --json
codex-toys --ssh devbox --cwd /repo automation run check-release \
  --event event.json \
  --sandbox danger-full-access \
  --approval-policy never \
  --via workbench
```

With `--ssh`, automation discovery, named resolution, event loading, and script
execution happen on the remote host inside the remote workbench. `--event` is a
remote path in this mode, resolved relative to `--cwd` unless it is absolute.
The SSH toybox stays alive until the automation script returns, so scripts
can call `context.turn.start` and then `context.turn.wait` or
`context.turn.waitAll` for long-running turns in remote workbenches. The provider uses the
selected surface directly; it does not try a second turn surface if the selected
one is unavailable.
