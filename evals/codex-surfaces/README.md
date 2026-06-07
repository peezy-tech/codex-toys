# Codex Surface Evals

This is a repo-local eval harness for comparing real Codex usage surfaces. It is
not a package workspace and is not published with `codex-toys`.

## Profiles

- `closed-app-server-raw`: headless app-server with minimal extra affordances.
- `closed-app-server-toys`: headless app-server with codex-toys affordances made explicit.
- `native-app`: real Codex App run using native App tools.
- `native-app-toys`: real Codex App run with codex-toys plugins, skills, and workbench conventions.

The primary matrix intentionally excludes `codex exec`. It can be useful for
developer smoke checks, but it is not treated as real human/App usage.

## Commands

```bash
vp exec tsx evals/codex-surfaces/run.ts list
vp exec tsx evals/codex-surfaces/run.ts run --scenario workbench-health-triage --profile closed-app-server-raw
vp exec tsx evals/codex-surfaces/run.ts packet --scenario workbench-health-triage --profile native-app
vp exec tsx evals/codex-surfaces/run.ts ingest --manifest evals/codex-surfaces/.runs/<run>/run.json --session-jsonl <rollout.jsonl>
vp exec tsx evals/codex-surfaces/run.ts report
```

Generated run data lives under `evals/codex-surfaces/.runs/` and is ignored by
git.

## Scenario Boundary

Scenarios reflect the current scheduler boundary: host schedulers own
recurrence, while codex-toys owns explicit task execution, feed dispatch,
dispatch queues, and result collection. Do not add new scenarios that benchmark
the removed `workbench tick` path.
