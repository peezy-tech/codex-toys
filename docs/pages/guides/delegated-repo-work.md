---
title: Delegated Repo Work
description: Start and track Codex work in another checkout from a controlling workbench.
---

# Delegated Repo Work

Delegated repo work starts a normal Codex thread in another cwd and records the
delegation in the controlling workbench. Use it when one workbench should fan
out review, repair, or inspection tasks into sibling checkouts.

Delegation is not the same as SSH. SSH chooses where the toybox runs.
Delegation chooses where the Codex turn runs relative to that toybox's
workbench root.

## 1. Discover Targets

From the controlling workbench:

```bash
codex-toys workbench delegate list --json
```

Common target forms:

```text
@
@/repos/example
@/workbenches/ops
./relative-target
```

Absolute paths require deliberate opt-in with `--allow-absolute-cwd`.

## 2. Start a Delegation

Start and record a delegation:

```bash
codex-toys workbench delegate start \
  --cwd @/repos/example \
  --prompt "Inspect the current branch and report risks." \
  --return-mode record_only
```

Wait for completion when the caller needs the result immediately:

```bash
codex-toys workbench delegate start \
  --cwd @/repos/example \
  --prompt "Run the focused test suite and summarize failures." \
  --wait
```

Use return modes to describe how the caller should be notified:

```text
detached
record_only
wake_on_done
wake_on_group
manual
```

## 3. Delegate Through SSH

With SSH, `--cwd` selects the remote controlling workbench. The delegated target
uses `--target-cwd`:

```bash
codex-toys --ssh workbox --cwd /srv/codex/root workbench delegate start \
  --target-cwd @/repos/example \
  --prompt "Review the repository status." \
  --return-mode record_only
```

The remote toybox resolves `@/repos/example` under `/srv/codex/root`.

## 4. Delegate From a Workflow

Workflow scripts can delegate when they run through the workbench surface:

```ts
export default async function run(context) {
  const delegation = await context.delegate.start({
    cwd: "@/repos/example",
    prompt: "Inspect this repository and summarize risks.",
    returnMode: "wake_on_done"
  });

  return { status: "delegated", delegation };
}
```

`context.delegate.*` requires the toybox/workbench surface. It is not available
when a workflow deliberately runs through direct app-server calls.

## 5. Choose Delegation vs Dispatch Queues

Use delegation when:

- the work belongs in another checkout
- the target should get a normal Codex thread
- the controlling workbench should keep a delegation record

Use dispatch queues when:

- the work should run later
- retries, attempts, output capture, or claiming matter
- the target is a prompt, command, workflow, task, or handoff intent

Use direct SSH `turn run --wait` only for short remote checks tied to the
current command lifecycle.

## Boundary

The controlling workbench owns target resolution and delegation records. The
target Codex thread owns its own prompts, tools, files, and output. The caller
owns return policy and any follow-up action after the delegated work completes.
