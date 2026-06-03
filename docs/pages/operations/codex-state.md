---
title: Codex State
description: Move durable memory markdown and thread rollout files between Codex homes.
---

# Codex State

codex-toys includes two file-based state helpers: memory transplant and thread
transplant. They are deliberately narrow. They are not a general Codex home sync.

## Memory Transplant

Memory transplant copies durable Codex memory markdown between a global Codex
home and a workbench Codex home.

```bash
codex-toys memories transplant global-to-workbench
codex-toys memories transplant workbench-to-global
codex-toys memories transplant global-to-workbench --apply
codex-toys memories transplant global-to-workbench --apply --merge codex
```

Default roots:

| Option | Default |
|--------|---------|
| `--workbench-root <path>` | discovered repository root |
| `--global-codex-home <path>` | current/default global `CODEX_HOME` |
| `--workbench-codex-home <path>` | `<workbench-root>/.codex` |

Allowed artifacts:

```text
MEMORY.md
memory_summary.md
raw_memories.md
rollout_summaries/*.md
```

The command skips auth, logs, sessions, sqlite databases, `.git`, skills,
generated extension machinery, and non-memory Codex home files.

Memory transplant is dry-run by default. `--apply` copies missing files.
`--overwrite` replaces conflicts after backup unless `--no-backup` is set.
`--merge codex` semantically merges `MEMORY.md` and `memory_summary.md`.

## Thread Transplant

Thread transplant copies native Codex rollout JSONL files between Codex homes.

```bash
codex-toys threads locate <thread-id> --codex-home ~/.codex
codex-toys threads inspect <thread-id-or-rollout.jsonl> --codex-home ~/.codex
codex-toys threads install-rollout ./rollout-2026-01-01T00-00-00-01900000-0000-7000-8000-000000000000.jsonl --codex-home ~/.codex --cwd "$PWD"
codex-toys threads transplant <thread-id> --from-codex-home <source> --to-codex-home <target> --cwd "$PWD"
```

The durable artifact is the native sessions path:

```text
sessions/<YYYY>/<MM>/<DD>/<rollout-file>.jsonl
```

Transplant preserves the thread id, filename, and relative sessions path. By
default it rewrites `session_meta.payload.cwd` to the destination project cwd so
the imported thread appears for that project. Use `--preserve-cwd` for an
archival copy.

Existing target rollouts fail by default. Pass `--replace` to write a
timestamped backup and replace the existing rollout.

Raw rollout JSONL can include prompts, model output, tool calls, command output,
file paths, and sensitive text. Only transplant or commit rollouts that belong
in durable history.
