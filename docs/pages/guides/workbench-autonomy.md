---
title: Workbench autonomy
description: Configure and run repo-native scheduled workbench tasks with codex-toys.
---

# Workbench autonomy

Workbench autonomy lets a repository schedule and run Codex-backed work without
inventing a second home, skill, or memory system. Repo-local control config and
generated state live under `.codex`.

```text
.codex/
  workbench.toml
  skills/
  memories/
  workbench/
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

There is no root-level `workbench/` directory and no persistent `logs/`
directory in the v1 workbench autonomy layout.

## Modes

| Mode | When to use it | Runtime `CODEX_HOME` | Generated state |
|------|----------------|----------------------|-----------------|
| `auto` | Default selection | `actions` when `GITHUB_ACTIONS=true`, otherwise `local` | Depends on resolved mode |
| `local` | Developer machines | The active user/global Codex home | `.codex/workbench/local` |
| `actions` | CI or local CI simulation | `<repo>/.codex` | `.codex/workbench/actions` |

Local mode does not override the active Codex home. Actions mode intentionally
uses the repository `.codex` directory so scheduled CI work can use repo skills
and memories. This is enforced centrally: `createWorkbenchContext({ mode:
"actions" })` sets both `workbenchCodexHome` and `runtimeCodexHome` to
`<repo>/.codex`, ignoring any external `CODEX_HOME`.

## Commands

```bash
codex-toys workbench doctor
codex-toys workbench tick --mode local
codex-toys workbench run morning-brief --mode actions
codex-toys workbench prompt enqueue "Review this branch later." --queue low-priority --effort low
codex-toys workbench prompt enqueue "Follow up after the audit." --after <intent-id>
codex-toys workbench prompt run-due --limit 1
codex-toys workbench prompt collect --queue low-priority --json
codex-toys workbench handoff enqueue "Run the dashboard smoke locally." --capability browser
codex-toys workbench handoff drain --capability browser --materialize --prompt-queue local-followups
codex-toys workbench deferred create --params-json '{"runAt":"2026-01-01T14:00:00.000Z","target":{"kind":"turn","prompt":"Review the workbench."}}'
codex-toys workbench deferred list --json
codex-toys workbench deferred pull <intent-id> --json
codex-toys workbench deferred collect --cursor operator --json
codex-toys workbench deferred retry <intent-id>
codex-toys workbench deferred run-due
codex-toys workbench init actions --forgejo
CODEX_WORKBENCH_MODE=actions codex-toys workbench doctor
```

`doctor` reports mode, repo root, config path, runtime `CODEX_HOME`, state
roots, task health, latest run, memory roots, memory summary presence, local
systemd user runner status when available, and toybox status when reachable. In
Actions mode it reports an error if the runtime Codex home would not be
`<repo>/.codex`.

`tick` creates due scheduled task intents, runs due deferred intents once, and
evaluates reactive rules.

`run <task-id>` runs one configured task immediately.

`prompt enqueue`, `list`, `read`, `collect`, `cancel`, `retry`, and `run-due`
are the Deferred Prompt Queue surface for one-off operator prompts. They create
ordinary deferred turn intents with `source.kind = "prompt-queue"` so queued
prompts share deferred claiming, attempts, output collection, retry, SSH, and
Actions behavior. `--after <intent-id>` adds a dependency gate; the queued prompt
is due only after that deferred intent reaches the requested `--after-status`
(`completed` by default, or `terminal` for any terminal state).

`handoff enqueue`, `list`, `read`, `collect`, `cancel`, `retry`, and `drain`
manage prompts that require a local controller host or local-only capability.
Handoffs are durable deferred intents, but generic deferred drains skip them;
only `workbench handoff drain` can claim and run or materialize them.

`deferred create`, `list`, `read`, `collect`, `cancel`, `retry`, `run-due`, and
`prune` manage durable future run intents. A deferred target can wrap a direct
Codex turn, a named turn automation, or a configured workbench task. Pruning is
explicit and only removes terminal history older than the requested retention
window.
`deferred read --include-output` and its `deferred pull` shorthand include
saved attempt outputs in the JSON response, which lets SSH callers pull remote
deferred results back to the local operator surface.

`deferred retry <intent-id>` creates a new pending intent from a terminal
`completed`, `failed`, or `canceled` intent. It defaults to retrying now; pass
`--run-at <iso>` to requeue for a later time. The original intent, attempts, and
outputs remain in place as audit history.

`deferred collect` is the cursor-based harvest path for completed, failed, or
canceled runs. Reusing the same cursor returns only terminal results newer than
that cursor; using a new cursor replays the terminal queue from the beginning.
The cursor lives in the queue being collected, including remote queues accessed
with `--ssh`.

`init actions` scaffolds an Actions-ready workbench. The command can generate:

- `.codex/workbench.toml`
- `.codex/config.toml`
- `.forgejo/workflows/codex-toys-actions.yml` with `--forgejo`
- `.github/workflows/codex-toys-actions.yml` with `--github`
- `.gitignore` entries for runtime-only Codex files

The generated workflow runs on `workflow_dispatch` and an hourly cron. It
prepares auth, runs `workbench tick --mode actions`, always cleans up
runtime-only files, and commits changed `.codex/memories`,
`.codex/feed/actions`, `.codex/workbench/actions`, and `.codex/sessions`
rollout data.

Existing JSON-RPC passthrough commands stay intact:

```bash
codex-toys workbench call <method>
codex-toys workbench app <method>
codex-toys workbench methods
```

## Config

Workbench control config lives at `.codex/workbench.toml`:

```toml
[workbench]
name = "meta-workbench"

[[workbench.tasks]]
id = "morning-brief"
enabled = true
kind = "skill"
skill = "morning-brief"
schedule = "0 14 * * *"
var = "workbench status"

[[workbench.reactive]]
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
[[workbench.tasks]]
id = "morning-brief"
enabled = true
kind = "skill"
skill = "morning-brief"
schedule = "0 14 * * *"
var = "workbench status"
```

### `automation`

Runs a named turn automation from `.codex/automations/*` or `automations/*`.
The automation script can skip, start, wait on, or compose native Codex turns
through the same codex-toys toybox that `workbench tick` is using. With
`--ssh --cwd /repo`, named automation resolution and script execution happen in
the remote workbench through the SSH toybox.

```toml
[[workbench.tasks]]
id = "codex-bindings"
enabled = true
kind = "automation"
automation = "openai-codex-bindings"
schedule = "0 * * * *"

[workbench.tasks.event]
type = "upstream.release"

[workbench.tasks.event.payload]
repo = "openai/codex"
tag = "rust-v1.2.3"
```

For each automation run, workbench autonomy creates a unique event id in the
form `workbench:<workbench-name>:<task-id>:<workbench-run-id>`, sets `type`
from `event.type` or the automation name, sets `source` from `event.source` or
the workbench name, and sets `occurredAt` and `receivedAt` to the task start
time. Static `event.payload` entries are merged over `{ taskId =
"<task-id>" }`, so explicit payload values win without reusing a static event
id across recurring runs. `prompt` and `cwd` can be set directly on the task to
override manifest defaults.

### `command`

Runs an explicitly configured command. Use this for small, deliberate checks
where a full skill or automation would be unnecessary.

```toml
[[workbench.tasks]]
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
[[workbench.reactive]]
id = "repair-failing-task"
enabled = true
task = "*"
consecutive_failures_gte = 3
kind = "skill"
skill = "skill-repair"
```

## Deferred Runs

Deferred runs are mode-scoped. Local mode writes to `.codex/workbench/local`;
Actions mode writes to `.codex/workbench/actions`. SSH operation is transport:
`--ssh --cwd /repo` operates the remote workbench's local queue.

Each intent has a `runAt` time, target, status, and separate attempt records.
One-shot intents run at most once unless a new retry intent is explicitly
created from terminal history. Recurring workbench schedules produce task
intents, so scheduled and one-shot work share the same claiming, output, and
inspection path.

## Deferred Prompt Queue

The Deferred Prompt Queue is a friendly surface over deferred turn intents. Use
it for one-off prompts that should run later under normal workbench permissions,
without promoting them to repeatable workbench tasks or named automations.

```bash
codex-toys workbench prompt enqueue "Draft the migration notes." --queue low-priority --effort low
codex-toys workbench prompt list --queue low-priority
codex-toys workbench prompt run-due --queue low-priority --limit 1
codex-toys workbench prompt collect --queue low-priority --json
```

Prompt queue entries can target an existing thread with `--thread-id`, override
turn settings with flags such as `--model`, `--service-tier`, `--effort`,
`--sandbox`, `--approval-policy`, or `--permissions`, and wait on another
deferred intent:

```bash
codex-toys workbench prompt enqueue "Continue only after the audit finishes." --after audit-intent --after-status completed
```

The prompt queue does not create a second scheduler. `workbench tick` runs due
queued prompts along with other deferred work, while `workbench prompt run-due`
drains only prompt-queue intents.

## Local Handoff Queue

The Local Handoff Queue is for work that is discovered in one workbench but
requires a local controller host, local browser, plugin install, dashboard
smoke, or another host-specific capability. It stores durable deferred turn
intents marked with `source.kind = "local-handoff"`, but ordinary
`workbench tick` and `workbench deferred run-due` skip them. A local controller
must drain them explicitly.

```bash
codex-toys workbench handoff enqueue "Run the dashboard smoke locally." \
  --queue local --capability browser --requester-thread-id <remote-thread-id>
codex-toys workbench handoff list --queue local
codex-toys workbench handoff drain --capability browser --limit 1
```

Use `--target-host <host-id>` when a handoff must be claimed by one specific
local host. A drainer can advertise that host with `--host-id <host-id>` and
advertise capabilities with repeated `--capability <name>` flags.

```bash
codex-toys workbench handoff enqueue "Update the local plugin install." \
  --target-host range-windows --capability plugin-install
codex-toys workbench handoff drain --host-id range-windows --capability plugin-install
```

If the local controller should schedule the work instead of running it
immediately, use `--materialize`. The handoff is completed and a prompt-queue
intent is created for the local queue.

```bash
codex-toys workbench handoff drain \
  --capability browser \
  --materialize \
  --prompt-queue local-followups
```

## Actions Mode

Actions jobs should prepare auth, run workbench tasks, cleanup runtime-only
state, and commit only durable workbench state:

```bash
codex-toys actions prepare-auth
codex-toys workbench tick --mode actions
codex-toys actions cleanup
```

`prepare-auth` accepts secrets in this order:

- `CODEX_AUTH_JSON_B64`
- `CODEX_AUTH_JSON`
- `OPENAI_API_KEY`

It writes `.codex/auth.json` with `0600` permissions. `cleanup` removes auth,
install ids, shell snapshots, temp dirs, SQLite databases,
`.codex/memories/.git`, and `phase2_workbench_diff.md`. It preserves
`.codex/sessions` because Actions-created or resumed thread rollouts are
durable handoff data for later thread transplant.

Actions commits should be limited to:

```text
.codex/memories/
.codex/feed/actions/
.codex/workbench/actions/
.codex/sessions/
```

Use job logs for verbose logs. Local mode generated state should not be
committed. Raw rollout JSONL can contain prompts, model output, tool calls,
command output, file paths, and other sensitive text, so only enable the
scheduled runner in repositories where that durable history belongs in git.

## Local Actions Simulation

Use the Actions helpers to exercise the same repository-scoped Codex home
without a hosted runner:

```bash
codex-toys actions prepare-auth
codex-toys workbench tick --mode actions
codex-toys actions cleanup
```

`workbench tick --mode actions` runs due workbench tasks and records workbench
state under `.codex/workbench/actions`; feed dispatch and polling state lives
under `.codex/feed/actions`.
