---
title: Memory transplant
description: Move durable Codex memory files between global and repository homes.
---

# Memory transplant

Memory transplant copies durable Codex memory files between a global Codex home
and a repository Codex home. It is intentionally file-based in v1 and is scoped
to `memories/` only.

```bash
codex-toys memories transplant global-to-workspace
codex-toys memories transplant workspace-to-global
```

The default is always a dry-run. Use `--apply` only after reviewing the planned
adds, conflicts, skipped files, and byte count.

## Homes

Defaults:

| Option | Default |
|--------|---------|
| `--workspace-root <path>` | discovered repository root |
| `--global-codex-home <path>` | current/default global `CODEX_HOME` |
| `--workspace-codex-home <path>` | `<workspace-root>/.codex` |

Direction:

- `global-to-workspace`: `~/.codex/memories` to `<repo>/.codex/memories`
- `workspace-to-global`: `<repo>/.codex/memories` to `~/.codex/memories`

## Copied Artifacts

The transplant allowlist is deliberately narrow:

```text
MEMORY.md
memory_summary.md
raw_memories.md
rollout_summaries/*.md
```

These are treated as durable memory artifacts. Everything else is skipped unless
the implementation explicitly allows it.

## Exclusions

The command never copies:

- auth files
- logs
- sessions
- sqlite databases such as `state_5.sqlite`
- `.git`
- skills
- generated extension machinery
- non-memory Codex home files
- transient files such as Phase 2 workspace diffs

Memory transplant does not copy `.codex/skills` and does not migrate Codex state
database rows.

## Conflict Behavior

Dry-run:

- lists missing destination files as planned adds
- lists existing destination files as conflicts
- lists skipped files
- reports the estimated byte count
- makes no changes

Apply without overwrite or merge:

- copies only missing files
- leaves conflicts untouched

Apply with overwrite:

```bash
codex-toys memories transplant global-to-workspace --apply --overwrite
```

- writes backups before replacing destination files by default
- use `--no-backup` only when you deliberately do not want backups

Semantic merge:

```bash
codex-toys memories transplant global-to-workspace --apply --merge codex
```

`--merge codex` is reserved for semantic merge of `MEMORY.md` and
`memory_summary.md`. Supporting files are still copied only when non-conflicting
unless overwrite behavior is requested.

## JSON Output

Use `--json` when a script needs the transplant plan:

```bash
codex-toys memories transplant global-to-workspace --json
```

The report includes source, destination, added files, conflicts, skipped files,
and estimated bytes.

## Typical Workflow

1. Inspect the current workspace:

```bash
codex-toys workspace doctor
```

2. Dry-run the transplant:

```bash
codex-toys memories transplant global-to-workspace
```

3. Apply missing files only:

```bash
codex-toys memories transplant global-to-workspace --apply
```

4. Re-run `doctor` and inspect `.codex/memories`.

Do not use transplant as a general Codex home sync. It is only for durable
memory files.
