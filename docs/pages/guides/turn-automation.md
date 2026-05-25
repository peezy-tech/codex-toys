---
title: Turn automation
description: Run a pre-turn script that can skip or start a native Codex turn.
---

# Turn automation

Turn automation is the plugin-native automation shape for codex-flows. A script
runs first, inspects external state, and decides whether a native Codex turn
should start.

This is prompt automation, not skill automation. Skills remain normal Codex
capabilities that the resulting turn may use. The automation itself is just code
that can check APIs, repositories, files, queues, release feeds, or any other
external signal before spending a Codex turn.

```text
event, schedule, hook, or operator command
  -> pre-turn script
     -> skip
     -> start native Codex turn with prompt/cwd/settings
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

## Decision contract

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
