---
name: turn-automation-author
description: Use when creating or reviewing codex-flows turn automation scripts that run before a Codex turn, inspect external state, and return a skip-or-turn decision.
---

# Turn Automation Author

Use this skill for plugin-native prompt automation. The automation is a script,
not a skill: it runs first, then decides whether to start a native Codex turn.

## Contract

- Run scripts through `codex-flows automation run <script>`.
- Prefer named automations under `automations/<name>/automation.json` when the
  script should be reused, scheduled, or installed by a plugin.
- Read one JSON context object from stdin with `automation`, `runtime`, optional
  `event`, optional `prompt`, and optional `cwd`.
- Return `{ "action": "skip" }` when no Codex turn is needed.
- Return `{ "action": "turn", "prompt": "..." }` when Codex should start a
  native turn.
- Module-style scripts may `export default async function run(context)`.
- Raw scripts must print one final `TURN_AUTOMATION <json>` line.

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
- Keep external side effects small before the turn starts; the turn should own
  work that needs Codex reasoning, tools, or skill guidance.
- Use the SSH provider for remote workspaces:
  `codex-flows --ssh <target> --cwd /repo automation run <script>`.
- Use flow packages only when durable event/run state, replay, leases, attempts,
  or backend queues are needed.
