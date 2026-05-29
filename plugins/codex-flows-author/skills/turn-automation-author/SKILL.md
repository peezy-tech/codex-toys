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
- Return an ordinary JSON object. Use shapes such as
  `{ "status": "skipped", "reason": "nothing changed" }` when no Codex turn is
  needed.
- Start native Codex turns from the script with `context.turn.start`, then
  return the turn metadata or wait for it with `context.turn.wait`.
- When the work belongs in another checkout, start delegated Codex threads with
  `context.delegate.start` while running through `--via workspace`.
- The CLI does not interpret returned `action` fields; the script owns its own
  orchestration.
- Scripts must `export default async function run(context)` or an equivalent
  default function.

## Host Helpers

- `context.app.call(method, params)` calls app-server.
- `context.workspace.call(method, params)` calls the codex-flows agent when
  running through `--via workspace`.
- `context.turn.start(params)` starts a native turn.
- `context.turn.read(turn)` reads a started turn.
- `context.turn.wait(turn, options)` waits for one turn and returns
  `status`, `outputText`, `thread`, and `turn`.
- `context.turn.waitAll(turns, options)` waits for multiple turns.
- `context.delegate.start(params)` starts a delegated Codex thread through the
  agent. Use `cwd: "@/workspaces/name"` or `cwd: "@/repos/name"`.
- `context.delegate.read(delegation)` and `context.delegate.wait(delegation,
  options)` refresh or wait on a delegated thread record.

## Named Layout

```text
automations/<name>/
  automation.json
  check.ts
  prompt.md
```

`automation.json` should include `script`, and may include `name`,
`description`, `prompt`, `promptFile`, `cwd`, and advisory `skills`.

## Turn Start Fields

- `prompt`: required for `context.turn.start` unless the CLI or manifest
  supplies a default prompt.
- `threadId`: continue an existing thread instead of creating a new one.
- `cwd`: target workspace cwd. With `--ssh`, this is the remote cwd.
- `model`, `serviceTier`, `sandbox`, `approvalPolicy`, `permissions`: optional
  app-server turn settings. Do not combine `sandbox` with `permissions`.
- `responsesapiClientMetadata`: string metadata for the turn.
- `outputSchema`: optional JSON Schema for the final assistant response.
- `skills`: advisory routing metadata for now; current app-server builds do not
  enforce turn-scoped skill filtering.

## Delegation Start Fields

- `cwd`: required target cwd. Prefer `@/workspaces/name` or `@/repos/name`
  relative to the agent workspace root.
- `prompt`, `title`, `groupId`, `returnMode`: optional delegation metadata and
  first-turn prompt.
- `model`, `serviceTier`, `sandbox`, `approvalPolicy`, `permissions`: optional
  app-server settings. Do not combine `sandbox` with `permissions`.
- `allowAbsoluteCwd`: permits an absolute cwd only for trusted local agents.

## Rules

- Prefer structured APIs over shell text scraping when practical.
- Make skip decisions explicit and explainable.
- Use ordinary JavaScript APIs such as `node:fs/promises` for files, CSVs, and
  reports; there is no codex-flows artifact helper on the context.
- Keep external side effects small before the turn starts; the turn should own
  work that needs Codex reasoning, tools, or skill guidance.
- Use the SSH provider for remote workspaces. In SSH mode, named resolution,
  event loading, and script execution happen on the remote host, and `--event`
  paths are remote paths relative to `--cwd` unless absolute:
  `codex-flows --ssh <target> --cwd /repo automation run <name> --event .codex/events/name/manual.json --sandbox danger-full-access --approval-policy never`.
