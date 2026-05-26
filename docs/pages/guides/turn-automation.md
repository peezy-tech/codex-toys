---
title: Turn automation
description: Run a pre-turn script that can skip, start, wait on, or compose native Codex turns.
---

# Turn automation

Turn automation is the plugin-native automation shape for codex-flows. A script
runs first, inspects external state, and can either return a simple decision or
programmatically compose native Codex turns.

This is prompt automation, not skill automation. Skills remain normal Codex
capabilities that the resulting turn may use. The automation itself is just code
that can check APIs, repositories, files, queues, release feeds, or any other
external signal before spending Codex turns.

```text
event, schedule, hook, or operator command
  -> pre-turn script
     -> skip
     -> start native Codex turn with prompt/cwd/settings
     -> start/wait/read multiple native Codex turns and return JSON
```

## Run an automation

Named automations live under `.codex/automations/<name>/automation.json` or
`automations/<name>/automation.json`:

```bash
codex-flows automation list
codex-flows automation run check-release --event event.json --via workspace
```

The manifest points to a module script and optional defaults:

```json
{
  "name": "check-release",
  "description": "Start a turn when a release needs inspection.",
  "script": "check-release.ts",
  "promptFile": "prompt.md",
  "cwd": "../.."
}
```

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
  "cwd": "/repo"
}
```

At runtime the context also includes a small host API:

- `context.app.call(method, params)`: call an app-server method.
- `context.workspace.call(method, params)`: call a workspace-backend method.
  This is only available when running `--via workspace`.
- `context.turn.start(params)`: start a native turn and return
  `{ id?, via, threadId, turnId, thread, turn }`.
- `context.turn.read(turn)`: read the latest snapshot for a started turn.
- `context.turn.wait(turn, options)`: wait until a turn is no longer
  `inProgress`, returning `status`, `outputText`, `thread`, and `turn`.
- `context.turn.waitAll(turns, options)`: wait for multiple turns.

```ts
export default async function run(context) {
  if (context.event?.payload?.repo !== "openai/codex") {
    return { action: "skip", reason: "not the Codex upstream" };
  }

  return {
    action: "turn",
    cwd: context.cwd,
    prompt: `Inspect ${context.event.payload.tag} and decide whether to update the fork.`
  };
}
```

## Return Contract

The handler must return a JSON object. Returning `skip` or `turn` is the simple
path; returning any other object is treated as the automation result and no
extra turn is started by the CLI.

Skip:

```json
{
  "action": "skip",
  "reason": "nothing changed"
}
```

Start a turn:

```json
{
  "action": "turn",
  "prompt": "Check the upstream release and prepare the patch stack update.",
  "cwd": "/repo",
  "model": "gpt-5.2",
  "permissions": "default"
}
```

Supported turn fields:

- `prompt`: required text for the native turn.
  If omitted from the script decision, `--prompt` or the manifest prompt is used
  as the default.
- `threadId`: continue an existing thread instead of creating a new one.
- `cwd`: target workspace cwd for the turn.
- `model`, `serviceTier`, `permissions`: forwarded to app-server when present.
- `responsesapiClientMetadata`: string metadata forwarded to the turn.
- `outputSchema`: JSON Schema for the final assistant response.
- `skills`: recorded in the automation result for routing and future
  turn-scoped skill filtering; current app-server builds do not enforce it.

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

Automation starts the turn through the configured workspace backend by default.
Use `--via app` only when deliberately targeting a direct app-server connection:

```bash
codex-flows automation run check-release --event event.json --via workspace
```

The same command can target a remote workspace through the SSH provider:

```bash
codex-flows --ssh devbox --cwd /repo automation run check-release \
  --event event.json \
  --via workspace
```

With `--ssh`, the script still runs locally. The resulting turn targets the
remote workspace. The provider uses the selected surface directly; it does not
try a second turn surface if the selected one is unavailable.
