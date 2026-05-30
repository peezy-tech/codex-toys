---
title: Deferred Runs Roadmap
description: Recommended order for turning deferred run intents into a complete local, SSH, and CI operator workflow.
---

# Deferred Runs Roadmap

Deferred runs give codex-toys a durable way to say "do this later" without
leaving an ad hoc agent process running forever. The first slices are live in
`codex-toys@0.140.1`: workspaces can create one-shot future intents, run due
intents locally or over SSH, inspect pending/completed/failed state, prune old
terminal history, pull one saved attempt output back through the toybox, and
collect unseen terminal results with a queue-local cursor.

This roadmap keeps the next work ordered around operator trust: first make
results easy to harvest, then make scheduled runners easy to install, then add
retention and broader scheduling ergonomics.

## Current Model

Deferred runs are mode-scoped:

- Local mode writes to `.codex/workspace/local`.
- Actions mode writes queue state to `.codex/workspace/actions` and durable
  thread rollouts to `.codex/sessions`.
- SSH is transport, not a third queue. `--ssh --cwd /repo` operates the remote
  workspace's local queue.

A deferred target can wrap:

- a direct Codex turn
- a named turn automation
- a configured workspace task

One-shot intents have a `runAt` timestamp and run at most once unless another
intent is explicitly created. Recurring workspace schedules create run intents,
so scheduled and one-shot work share claiming, attempt records, output records,
and inspection commands.

The current local schedule support is intentionally simple. Workspace task
schedules use five-field cron syntax with `*`, numbers, and comma lists, and
scheduled tasks are de-duped once per calendar day. Minute-level mechanical
jobs, such as trade collection or frequent aggregation, should remain under
systemd, cron, or product-owned services until codex-toys grows explicit
interval scheduling.

## Recommended Order

1. Harden deferred result collection.

   An operator can inspect one completed result with:

   ```bash
   codex-toys workspace deferred pull <intent-id> --json
   codex-toys --ssh rammstein --cwd /repo workspace deferred pull <intent-id> --json
   ```

   `deferred collect` adds the batch form:

   ```bash
   codex-toys workspace deferred collect --cursor operator --json
   codex-toys --ssh rammstein --cwd /repo workspace deferred collect --cursor operator --json
   ```

   The cursor lives with the queue being collected. Local collection advances a
   local queue cursor; SSH collection advances a remote queue cursor. The next
   hardening work is about operator presentation, not semantics: friendlier
   summaries, dashboard use, and optional cursor naming conventions.

2. Harden CI and scheduled-runner setup.

   `workspace tick --mode actions` runs due workspace tasks and due
   Actions-mode deferred intents. `workspace init actions` scaffolds a
   Forgejo/GitHub workflow that prepares auth, runs tick, cleans up runtime
   auth, and commits only durable workspace state when needed.

   This should land after result collection so CI-produced outputs have a clear
   local harvest path.

   The scaffold commits `.codex/memories`, `.codex/workspace/actions`, and
   `.codex/sessions`. Sessions are included because generated or resumed Codex
   thread rollouts are durable handoff data for local thread transplant. The
   next hardening work is around configurable cadence and clearer operator
   setup prompts, not a separate scheduler model.

3. Add an explicit retention policy.

   `workspace deferred prune --older-than-days <days> [--dry-run]` is available
   now and intentionally only removes terminal history. The next improvement is
   a scaffolded optional prune task or workflow, not automatic pruning during
   execution. Operators should be able to see and dry-run retention before it
   deletes old outputs.

4. Improve recurring agentic scheduling.

   Current workspace schedules are useful for daily briefs and other low
   frequency agentic tasks, but they are not a general interval scheduler. After
   collect, CI setup, and retention are stable, recurring turn or automation
   ergonomics should improve around clearer schedule semantics, slot-based
   de-dupe, and possibly interval syntax.

5. Add operator surfaces.

   The CLI is enough for the first workflow. Once collection and CI setup are in
   place, dashboards or workspace summaries can show queued, due, completed,
   failed, and uncollected results. This should remain an inspection and
   operation surface over the same intent records, not a second scheduler.

6. Keep release hygiene current.

   GitHub trusted publishing is working. The publish workflow should still be
   updated for the GitHub Actions Node runtime warning so future npm releases do
   not depend on deprecated action runtimes.

## Later Improvements

1. Local runner scaffolding.

   Add a first-class setup path for a local systemd user timer that calls
   `workspace tick` for one workspace root. The default shape should be one
   runner per queue, not one timer per deferred intent. That keeps recurring
   workspace schedules and one-shot deferred runs on the same durable state
   path, and it avoids creating timer files for every future turn.

2. Runner doctor remediation.

   `workspace doctor` now reports matching local systemd user runners. The next
   layer should turn that into actionable remediation: show the expected runner
   cadence, identify disabled deferred-only legacy timers, and suggest the
   setup or repair action without mutating anything during doctor.

3. Bounded concurrent execution.

   A single `workspace tick` currently claims and runs due work in one process.
   Separate workspace timers run independently, but a long-running task inside
   one workspace can delay later due intents in that same queue. The next
   runtime slice should split claiming from execution so tick can start bounded
   worker executions, preserve one-shot leases, and keep per-intent attempt
   records isolated.

4. Explicit retry and repair.

   Failed runs should remain terminal until the operator asks for a retry or
   creates a new intent. Add a clear retry/requeue path that copies the failed
   target into a new pending intent with a link to the original failure. This is
   especially important for failures such as missing thread ids, stale cwd
   paths, or unavailable app-server state.

5. Optional workspace registry.

   A future global timer can be useful, but it should be a registry-driven
   operator convenience rather than an always-on agent. The safer shape is a
   low-frequency user timer that runs a `tick-all` style command over explicitly
   registered workspace roots. Each workspace still owns a separate queue.

6. Exact wakeups as optimization.

   Per-intent timers can be revisited later as an optimization for exact
   wakeups. They should enqueue or wake a workspace tick, not bypass the queue
   lease and attempt machinery. The simple one-timer-per-workspace model should
   stay the default until the operator experience proves it needs finer
   granularity.

7. Better operator surfaces.

   Add compact views for pending, due, running, failed, completed, and
   uncollected results, plus the runner that is expected to service each queue.
   This can be a CLI summary first and a dashboard later. It should read the
   same intent records and doctor data rather than inventing a second state
   source.

## Local Usage Today

Create a one-shot turn or automation for later:

```bash
codex-toys workspace deferred create --params-json '{"runAt":"2026-05-30T14:00:00.000Z","target":{"kind":"turn","prompt":"Review the workspace state and summarize what changed."}}'
codex-toys workspace deferred list --json
```

Run due work from the machine that owns the queue:

```bash
codex-toys workspace deferred run-due --mode local
codex-toys workspace tick --mode local
```

Pull a completed result:

```bash
codex-toys workspace deferred pull <intent-id> --json
codex-toys workspace deferred collect --cursor operator --json
```

Operate a remote workspace's local queue over SSH:

```bash
codex-toys --ssh rammstein --cwd /remote/workspace workspace deferred list --json
codex-toys --ssh rammstein --cwd /remote/workspace workspace deferred run-due
codex-toys --ssh rammstein --cwd /remote/workspace workspace deferred pull <intent-id> --json
codex-toys --ssh rammstein --cwd /remote/workspace workspace deferred collect --cursor operator --json
```

Configure a low-frequency local scheduled task in `.codex/workspace.toml`:

```toml
[workspace]
name = "example"

[[workspace.tasks]]
id = "morning-brief"
enabled = true
kind = "automation"
automation = "morning-brief"
schedule = "0 14 * * *"
```

Then run `workspace tick` from a user timer, cron, CI workflow, or a manual
operator command. A local systemd user timer should call `workspace tick`, not a
separate deferred-only runner, so scheduled tasks and one-shot deferred intents
share the same queue and claiming path. `workspace doctor` reports whether it
can see a matching local systemd user timer for the current workspace root.
Today this is best for daily or occasional agentic work. Keep frequent runtime
jobs, such as market-data collection or short interval aggregation, in
product-owned system services.

## Boundaries

codex-toys should own durable run intent state, claiming, output inspection,
remote operation over SSH, and CI-friendly workspace execution. Product
workspaces should own exchange-facing execution, market-data daemons, raw
runtime stores, and domain-specific decisions about when a result becomes
durable workspace memory.

This keeps the deferred-run system useful for trading work, infrastructure
soak checks, and repository automation without turning codex-toys into a
general process supervisor.
