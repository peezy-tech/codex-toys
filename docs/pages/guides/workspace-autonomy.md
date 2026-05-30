---
title: Workspace autonomy
description: Configure and run repo-native scheduled workspace tasks with codex-toys.
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
      deferred/
        intents/
        attempts/
        outputs/
        claims/
    local/
      state/
      runs/
      outputs/
      health/
      deferred/
        intents/
        attempts/
        outputs/
        claims/
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
codex-toys workspace doctor
codex-toys workspace tick --mode local
codex-toys workspace run morning-brief --mode actions
codex-toys workspace deferred create --params-json '{"runAt":"2026-01-01T14:00:00.000Z","target":{"kind":"turn","prompt":"Review the workspace."}}'
codex-toys workspace deferred list --json
codex-toys workspace deferred pull <intent-id> --json
codex-toys workspace deferred collect --cursor operator --json
codex-toys workspace deferred run-due
codex-toys workspace init actions --forgejo
CODEX_WORKSPACE_MODE=actions codex-toys workspace doctor
```

`doctor` reports mode, repo root, config path, runtime `CODEX_HOME`, state
roots, task health, latest run, memory roots, memory summary presence, and
toybox status when reachable. In Actions mode it reports an error if
the runtime Codex home would not be `<repo>/.codex`.

`tick` creates due scheduled task intents, runs due deferred intents once, and
evaluates reactive rules.

`run <task-id>` runs one configured task immediately.

`deferred create`, `list`, `read`, `collect`, `cancel`, `run-due`, and `prune` manage
durable future run intents. A deferred target can wrap a direct Codex turn, a
named turn automation, or a configured workspace task. Pruning is explicit and
only removes terminal history older than the requested retention window.
`deferred read --include-output` and its `deferred pull` shorthand include
saved attempt outputs in the JSON response, which lets SSH callers pull remote
deferred results back to the local operator surface.

`deferred collect` is the cursor-based harvest path for completed, failed, or
canceled runs. Reusing the same cursor returns only terminal results newer than
that cursor; using a new cursor replays the terminal queue from the beginning.
The cursor lives in the queue being collected, including remote queues accessed
with `--ssh`.

`init actions` scaffolds an Actions-ready workspace. The command can generate:

- `.codex/workspace.toml`
- `.codex/config.toml`
- `.forgejo/workflows/codex-toys-actions.yml` with `--forgejo`
- `.github/workflows/codex-toys-actions.yml` with `--github`
- `.gitignore` entries for runtime-only Codex files

Existing JSON-RPC passthrough commands stay intact:

```bash
codex-toys workspace call <method>
codex-toys workspace app <method>
codex-toys workspace methods
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

### `automation`

Runs a named turn automation from `.codex/automations/*` or `automations/*`.
The automation script can skip, start, wait on, or compose native Codex turns
through the same codex-toys toybox that `workspace tick` is using. With
`--ssh --cwd /repo`, named automation resolution and script execution happen in
the remote workspace through the SSH toybox.

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

For each automation run, workspace autonomy creates a unique event id in the
form `workspace:<workspace-name>:<task-id>:<workspace-run-id>`, sets `type`
from `event.type` or the automation name, sets `source` from `event.source` or
the workspace name, and sets `occurredAt` and `receivedAt` to the task start
time. Static `event.payload` entries are merged over `{ taskId =
"<task-id>" }`, so explicit payload values win without reusing a static event
id across recurring runs. `prompt` and `cwd` can be set directly on the task to
override manifest defaults.

### `command`

Runs an explicitly configured command. Use this for small, deliberate checks
where a full skill or automation would be unnecessary.

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

## Deferred Runs

Deferred runs are mode-scoped. Local mode writes to `.codex/workspace/local`;
Actions mode writes to `.codex/workspace/actions`. SSH operation is transport:
`--ssh --cwd /repo` operates the remote workspace's local queue.

Each intent has a `runAt` time, target, status, and separate attempt records.
One-shot intents run at most once unless a new retry intent is created. Recurring
workspace schedules produce task intents, so scheduled and one-shot work share
the same claiming, output, and inspection path.

## Actions Mode

Actions jobs should prepare auth, run workspace tasks, cleanup runtime-only
state, and commit only durable workspace state:

```bash
codex-toys actions prepare-auth
codex-toys workspace tick --mode actions
codex-toys actions cleanup
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
codex-toys actions prepare-auth
codex-toys workspace tick --mode actions
codex-toys actions cleanup
```

`workspace tick --mode actions` runs due workspace tasks and records their
state under `.codex/workspace/actions`.
