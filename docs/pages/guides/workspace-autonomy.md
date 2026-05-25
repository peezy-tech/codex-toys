---
title: Workspace autonomy
description: Configure and run repo-native scheduled workspace tasks with codex-flows.
---

# Workspace autonomy

Workspace autonomy lets a repository schedule and run Codex-backed work without
inventing a second home, skill, or memory system. Repo-local control config and
generated state live under `.codex`.

```text
.codex/
  workspace.toml
  skills/
  memories/
  workspace/
    actions/
      state/
      runs/
      outputs/
      health/
    local/
      state/
      runs/
      outputs/
      health/
```

There is no root-level `workspace/` directory and no persistent `logs/`
directory in the v1 workspace autonomy layout.

## Modes

| Mode | When to use it | Runtime `CODEX_HOME` | Generated state |
|------|----------------|----------------------|-----------------|
| `auto` | Default selection | `actions` when `GITHUB_ACTIONS=true`, otherwise `local` | Depends on resolved mode |
| `local` | Developer machines | The active user/global Codex home | `.codex/workspace/local` |
| `actions` | CI or local CI simulation | `<repo>/.codex` | `.codex/workspace/actions` |

Local mode does not override the active Codex home. Actions mode intentionally
uses the repository `.codex` directory so scheduled CI work can use repo skills
and memories. This is enforced centrally: `createWorkspaceContext({ mode:
"actions" })` sets both `workspaceCodexHome` and `runtimeCodexHome` to
`<repo>/.codex`, ignoring any external `CODEX_HOME`.

## Commands

```bash
codex-flows workspace doctor
codex-flows workspace tick --mode local
codex-flows workspace run morning-brief --mode actions
codex-flows workspace init actions --forgejo --with-smoke --with-agent-turn
CODEX_WORKSPACE_MODE=actions codex-flows workspace doctor
```

`doctor` reports mode, repo root, config path, runtime `CODEX_HOME`, state
roots, task health, latest run, memory roots, memory summary presence, and
workspace backend status when reachable. In Actions mode it reports an error if
the runtime Codex home would not be `<repo>/.codex`.

`tick` runs due scheduled tasks once and evaluates reactive rules.

`run <task-id>` runs one configured task immediately.

`init actions` scaffolds an Actions-ready workspace. The command can generate:

- `.codex/workspace.toml`
- `.codex/config.toml`
- `.forgejo/workflows/codex-flows-actions.yml` with `--forgejo`
- `.github/workflows/codex-flows-actions.yml` with `--github`
- an Actions smoke flow with `--with-smoke`
- a sample agent-turn flow with `--with-agent-turn`
- `.gitignore` entries for runtime-only Codex files

Existing JSON-RPC passthrough commands stay intact:

```bash
codex-flows workspace call <method>
codex-flows workspace app <method>
codex-flows workspace methods
```

## Config

Workspace control config lives at `.codex/workspace.toml`:

```toml
[workspace]
name = "meta-workspace"

[[workspace.tasks]]
id = "morning-brief"
enabled = true
kind = "skill"
skill = "morning-brief"
schedule = "0 14 * * *"
var = "workspace status"

[[workspace.reactive]]
id = "repair-failing-task"
enabled = true
task = "*"
consecutive_failures_gte = 3
kind = "skill"
skill = "skill-repair"
```

Task ids must be lowercase slug-like ids. Schedules use five-field cron syntax.

## Task Kinds

### `skill`

Runs a Codex skill.

Actions mode resolves skills from `.codex/skills/<skill>/SKILL.md` because
`CODEX_HOME` is the repository `.codex`. Local mode uses the active Codex home,
so a developer can run against their installed skills without mutating the repo
home.

```toml
[[workspace.tasks]]
id = "morning-brief"
enabled = true
kind = "skill"
skill = "morning-brief"
schedule = "0 14 * * *"
var = "workspace status"
```

### `flow`

Dispatches a generated `FlowEvent` through the workspace backend
`flow.dispatch` capability. The workspace backend discovers installed flows in
`.codex/flows/*` and source-local flows in `flows/*`, so repository-authored
flows can stay under `flows/`. Use `.codex/flows` for installed external
capabilities.

```toml
[[workspace.tasks]]
id = "release-health"
enabled = true
kind = "flow"
flow = "workspace.release.health"
schedule = "*/30 * * * *"

[workspace.tasks.event.payload]
lookback_sessions = 10
```

For each run, workspace autonomy creates a unique event id in the form
`workspace:<workspace-name>:<task-id>:<workspace-run-id>`, sets `type` from
`event.type` or `flow`, sets `source` from `event.source` or the workspace name,
and sets `occurredAt` and `receivedAt` to the task start time. Static
`event.payload` entries are merged over `{ taskId = "<task-id>" }`, so explicit
payload values win without reusing a static event id across recurring runs.

### `automation`

Runs a named turn automation from `.codex/automations/*` or `automations/*`.
The automation script can skip or start a native Codex turn through the same
workspace backend that `workspace tick` is using. With `--ssh --cwd /repo`, the
script still runs locally and the resulting turn targets the remote workspace
cwd.

```toml
[[workspace.tasks]]
id = "codex-bindings"
enabled = true
kind = "automation"
automation = "openai-codex-bindings"
schedule = "0 * * * *"

[workspace.tasks.event]
type = "upstream.release"

[workspace.tasks.event.payload]
repo = "openai/codex"
tag = "rust-v1.2.3"
```

Automation tasks use the same generated event id shape as flow tasks. `prompt`
and `cwd` can be set directly on the task to override manifest defaults.

### `command`

Runs an explicitly configured command. Use this for small, deliberate checks
where a full skill or flow would be unnecessary.

```toml
[[workspace.tasks]]
id = "node-version"
enabled = true
kind = "command"
command = ["node", "--version"]
schedule = "0 * * * *"
```

## Reactive Rules

Reactive rules inspect task health. A common pattern is to run a repair skill
after repeated failures:

```toml
[[workspace.reactive]]
id = "repair-failing-task"
enabled = true
task = "*"
consecutive_failures_gte = 3
kind = "skill"
skill = "skill-repair"
```

## Actions Mode

Actions jobs should prepare auth, run workspace tasks, cleanup runtime-only
state, and commit only durable workspace state:

```bash
codex-flows actions prepare-auth
codex-flows workspace tick --mode actions
codex-flows actions cleanup
```

`prepare-auth` accepts secrets in this order:

- `CODEX_AUTH_JSON_B64`
- `CODEX_AUTH_JSON`
- `OPENAI_API_KEY`

It writes `.codex/auth.json` with `0600` permissions. `cleanup` removes auth,
install ids, sessions, shell snapshots, temp dirs, SQLite databases,
`.codex/memories/.git`, and `phase2_workspace_diff.md`.

Actions commits should be limited to:

```text
.codex/memories/
.codex/workspace/actions/
```

Use job logs for verbose logs. Local mode generated state should not be
committed.

## Local Actions Simulation

Use the Actions helpers to exercise the same repository-scoped Codex home
without a hosted runner:

```bash
codex-flows actions dispatch --event ./event.json
codex-flows actions assert-run --flow actions-smoke --step smoke
```

`actions dispatch` writes the event to `.codex/workspace/actions/events` and
runs matching flows through a file-backed local flow client under
`.codex/workspace/actions/flow-client`.
