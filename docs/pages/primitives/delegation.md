---
title: Delegation
description: Start, track, and return Codex work in another workbench-relative cwd.
---

# Delegation

Delegation starts normal Codex threads in another cwd and records workbench
metadata under `.codex/workbench/local/delegations.json`.

Use delegation when background work should be supervised by the toybox instead
of tied to a single SSH command lifecycle.

```bash
codex-toys workbench delegate list --json
codex-toys workbench delegate start --cwd @/repos/example --prompt "Inspect this repository."
codex-toys workbench delegate start --cwd @/workbenches/ops --prompt "Run the check." --wait
```

## Cwd Rules

Delegation cwd values are resolved relative to the toybox workbench root:

- `@` means the workbench root
- `@/repos/name` means a path under the workbench root
- `@/workbenches/name` means a path under the workbench root
- relative paths are resolved under the workbench root
- absolute paths require `--allow-absolute-cwd`

For SSH, `--cwd` selects the remote workbench root and `--target-cwd` selects the
delegated target inside that remote root:

```bash
codex-toys --ssh <target> --cwd <remote-root> workbench delegate start \
  --target-cwd @/repos/example \
  --prompt "Review the branch"
```

## Return Modes

Delegations can record return behavior:

- `detached`: start and record, no return wake
- `record_only`: record result for manual collection
- `wake_on_done`: wake the requesting thread when this delegation finishes
- `wake_on_group`: wake when the delegation group finishes
- `manual`: operator-managed return

```bash
codex-toys workbench delegate start \
  --cwd @/repos/example \
  --prompt "Run the review." \
  --return-mode wake_on_done
```

## Workflow Integration

Workflow scripts can delegate through `context.delegate.start` when running via
the workbench surface:

```ts
export default async function run(context) {
  const delegated = await context.delegate.start({
    cwd: "@/repos/example",
    prompt: "Inspect this repository and report findings.",
    returnMode: "record_only"
  });

  return { status: "delegated", delegated };
}
```

`context.delegate.read` and `context.delegate.wait` can refresh or wait on the
recorded delegation.
