---
title: Feed To Workflow
description: Dispatch RSS or Atom feed items into explicit workbench workflow tasks.
---

# Feed To Workflow

Feed-to-workflow wiring lets a feed source create workflow task runs with
ack-aware cursor advancement. Feed owns polling and item cursors. The workflow
owns interpretation and Codex actions.

Use this guide when an external RSS or Atom signal should trigger repository
work, release checks, dependency review, or a follow-up Codex turn.

## 1. Configure a Feed Source

Create `.codex/feed.toml`:

```toml
[feed]
name = "example"

[[feed.sources]]
id = "project-releases"
kind = "atom"
url = "https://github.com/example/project/releases.atom"
enabled = true
latest_only = true
max_content_bytes = 20000
store_raw = false
```

Use `latest_only = true` when a cold start should only observe the newest item.
Use `max_items` when a source needs a bounded replay window.

## 2. Define a Workflow

Create `workflows/release-check/workflow.json`:

```json
{
  "name": "release-check",
  "description": "Inspect release feed items before Codex acts.",
  "script": "check.ts",
  "promptFile": "prompt.md",
  "cwd": "@",
  "timeoutMs": 1800000
}
```

Create `workflows/release-check/check.ts`:

```ts
export default async function run(context) {
  if (context.event?.type !== "feed.item") {
    return { status: "skipped", reason: "not a feed item" };
  }

  const item = context.event.payload;
  const turn = await context.turn.start({
    cwd: context.cwd,
    prompt: [
      context.prompt,
      `Feed source: ${item.sourceId}`,
      `Title: ${item.title}`,
      `URL: ${item.url ?? "none"}`
    ].filter(Boolean).join("\n")
  });

  return { status: "started", itemId: item.id, turn };
}
```

## 3. Add a Workbench Task

Create `.codex/workbench.toml`:

```toml
[workbench]
name = "example"

[[workbench.tasks]]
id = "release-check"
enabled = true
kind = "workflow"
workflow = "release-check"
```

The task has no schedule. Feed dispatch is the trigger, and the host scheduler
decides when to call feed dispatch.

## 4. Poll and Dispatch

Run a dry inspection first:

```bash
codex-toys feed doctor --json
codex-toys feed poll --source project-releases --json
codex-toys feed collect --source project-releases --cursor release-feed --limit 5 --no-advance --json
```

Dispatch collected items to the workbench task:

```bash
codex-toys feed dispatch \
  --source project-releases \
  --cursor release-feed \
  --target workbench-task:release-check \
  --limit 5 \
  --json
```

`feed.dispatch` polls by default, collects unseen items without advancing first,
runs the target once per item, and advances the cursor only after successful
delivery.

## 5. Schedule the Dispatch

For GitHub Actions, let `on.schedule` own recurrence and run feed dispatch as a
workflow step:

```yaml
- run: >-
    codex-toys feed dispatch
    --source project-releases
    --cursor release-feed
    --target workbench-task:release-check
    --limit 5
```

For a local machine, put the same command in a systemd user service and attach
an `OnCalendar` timer.

## Boundary

Feed owns source config, polling, item storage, dedupe, cursors, and ack-aware
dispatch. Workflows own filtering, prompt construction, Codex turn policy, and
external writes.
