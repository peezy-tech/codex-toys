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

## Run a script

```bash
codex-flows automation run ./automations/check-release.ts --event event.json
```

Named automations live under `.codex/automations/<name>/automation.json` or
`automations/<name>/automation.json`:

```bash
codex-flows automation list
codex-flows automation run check-release --event event.json
```

The script receives JSON on stdin:

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
  "prompt": "optional fallback prompt",
  "cwd": "/repo"
}
```

Module-style scripts can export a default handler:

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

Raw scripts can print a final prefixed JSON line:

```bash
echo 'TURN_AUTOMATION {"action":"skip","reason":"no matching release"}'
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
  If omitted from the script decision, `--prompt` is used as the fallback.
- `threadId`: continue an existing thread instead of creating a new one.
- `cwd`: target workspace cwd for the turn.
- `model`, `serviceTier`, `permissions`: forwarded to app-server when present.
- `responsesapiClientMetadata`: string metadata forwarded to the turn.
- `outputSchema`: JSON Schema for the final assistant response.
- `skills`: recorded in the automation result for routing and future
  turn-scoped skill filtering; current app-server builds do not enforce it.

## Local and remote targets

By default, automation starts the turn through the configured local workspace
backend or app-server:

```bash
codex-flows automation run ./automations/check-release.ts \
  --event event.json \
  --via auto
```

The same command can target a remote workspace through the SSH provider:

```bash
codex-flows --ssh devbox --cwd /repo automation run check-release \
  --event event.json \
  --via auto
```

With `--ssh`, the script still runs locally. The resulting turn targets the
remote workspace. The provider first tries an existing remote workspace backend,
then can spawn a transient backend, and app-only paths can fall back to
`codex app-server --listen stdio://` over SSH.

## Relationship to flow packages

Turn automation is the narrow path for "run code first, then maybe run Codex."
Generic flow packages remain useful when a product needs event/run persistence,
replay, attempts, leases, or a durable backend queue. Prefer turn automation for
plugin-installed prompt workflows that do not need the full flow ABI.
