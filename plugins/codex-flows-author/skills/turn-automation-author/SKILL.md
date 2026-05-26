---
name: turn-automation-author
description: Use when creating or reviewing codex-flows turn automation scripts that run before Codex turns, inspect external state, and either return a skip/turn decision or programmatically compose turns.
---

# Turn Automation Author

Use this skill for plugin-native prompt automation. The automation is a script,
not a skill: it runs first, then decides whether to skip, start, wait on, or
compose native Codex turns.

## Contract

- Run scripts through `codex-flows automation run <name>`.
- Use named automations under `automations/<name>/automation.json`.
- Export a default handler that receives a context object with `automation`,
  `runtime`, optional `event`, optional `prompt`, optional `cwd`, and host
  helpers.
- Return `{ "action": "skip" }` when no Codex turn is needed.
- Return `{ "action": "turn", "prompt": "..." }` when Codex should start a
  native turn.
- Return any other JSON object when the script has done the orchestration itself.
- Scripts must `export default async function run(context)` or an equivalent
  default function.

## Host Helpers

- `context.app.call(method, params)` calls app-server.
- `context.workspace.call(method, params)` calls the workspace backend when
  running through `--via workspace`.
- `context.turn.start(params)` starts a native turn.
- `context.turn.read(turn)` reads a started turn.
- `context.turn.wait(turn, options)` waits for one turn and returns
  `status`, `outputText`, `thread`, and `turn`.
- `context.turn.waitAll(turns, options)` waits for multiple turns.

## Named Layout

```text
automations/<name>/
  automation.json
  check.ts
  prompt.md
```

`automation.json` should include `script`, and may include `name`,
`description`, `prompt`, `promptFile`, `cwd`, and advisory `skills`.

## Turn Decision Fields

- `prompt`: required for `action = "turn"` unless the CLI supplies `--prompt`.
- `threadId`: continue an existing thread instead of creating a new one.
- `cwd`: target workspace cwd. With `--ssh`, this is the remote cwd.
- `model`, `serviceTier`, `permissions`: optional app-server turn settings.
- `responsesapiClientMetadata`: string metadata for the turn.
- `outputSchema`: optional JSON Schema for the final assistant response.
- `skills`: advisory routing metadata for now; current app-server builds do not
  enforce turn-scoped skill filtering.

## Rules

- Prefer structured APIs over shell text scraping when practical.
- Make skip decisions explicit and explainable.
- Use ordinary JavaScript APIs such as `node:fs/promises` for files, CSVs, and
  reports; there is no codex-flows artifact helper on the context.
- Keep external side effects small before the turn starts; the turn should own
  work that needs Codex reasoning, tools, or skill guidance.
- Use the SSH provider for remote workspaces:
  `codex-flows --ssh <target> --cwd /repo automation run <name>`.
