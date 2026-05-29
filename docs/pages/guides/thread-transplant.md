---
title: Thread transplant
description: Move Codex thread rollout files between CODEX_HOME roots.
---

# Thread transplant

Thread transplant copies native Codex rollout JSONL files between `CODEX_HOME`
roots. The rollout file is the durable artifact:

```text
sessions/<YYYY>/<MM>/<DD>/<rollout-file>.jsonl
```

Transplant preserves the original thread id, filename, relative `sessions/...`
path, byte length, and sha256 checksum so the target Codex home can resume the
same thread id from disk.

```bash
codex-toys threads locate <thread-id> --codex-home ~/.codex
codex-toys threads transplant <thread-id> --from-codex-home ~/.codex --to-codex-home ./workspace/.codex
```

`transplant` is the normal home-to-home path. It locates the rollout under the
source home, copies it byte-for-byte to the same
`sessions/<YYYY>/<MM>/<DD>/<rollout-file>.jsonl` path under the target home,
then verifies byte length and sha256.

To replace an existing rollout, opt in explicitly:

```bash
codex-toys threads transplant <thread-id> --from-codex-home <source> --to-codex-home <target> --replace
```

`--replace` writes a timestamped backup beside the existing target rollout
before copying the source file.

## Inspect

Inspect a thread in a Codex home:

```bash
codex-toys threads inspect <thread-id> --codex-home <home>
```

Inspect a rollout file directly:

```bash
codex-toys threads inspect .codex/sessions/2026/05/18/rollout-2026-05-18T15-12-25-019e3ba5-3c2a-74c1-bece-53a8ece3dc0e.jsonl
```

Inspect reads the native JSONL, identifies the thread id from
`session_meta.payload.id` first, falls back to the filename thread id when
needed, and prints byte length, sha256, relative sessions path, and source cwd
when available. Use `--json` for machine-readable output.

## Install Rollout

Use `install-rollout` when you have a loose rollout JSONL file and want to
place it into a Codex home:

```bash
codex-toys threads install-rollout ./rollout-2026-05-18T15-12-25-019e3ba5-3c2a-74c1-bece-53a8ece3dc0e.jsonl --codex-home .codex
```

If the file already lives under a `sessions/...` path, that relative path is
preserved. Otherwise the command infers the native `sessions/YYYY/MM/DD/...`
path from the rollout filename timestamp. The installed file is verified by byte
length and sha256. Existing target files fail by default; pass `--replace` to
write a timestamped backup and replace them.

## Scope

Thread transplant is for local or backend environments that can resume threads
from Codex rollout files. It is not app-server-native import, not a general
Codex home sync, and not a fork/id-rewrite tool. Cross-home resume or fork
preserves the original thread id by copying the native rollout into the target
home, then using the existing Codex/app-server thread resume or fork behavior.

Raw rollout JSONL can include prompts, model output, tool calls, command output,
file paths, and any sensitive text the toybox saw. Only transplant or commit
rollouts you deliberately trust as durable history.
