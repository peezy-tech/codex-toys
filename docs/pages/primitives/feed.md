---
title: Feed
description: RSS and Atom intake, durable items, cursors, and ack-aware dispatch.
---

# Feed

Feed is the durable external signal intake primitive. It polls RSS or Atom
sources, normalizes entries into feed items, records source checkpoints, and lets
consumers collect items with named cursors.

Feed does not decide what a signal means. A workflow, workbench task, dashboard,
or product function decides whether to enqueue a prompt, create a dispatch run,
or ignore the item.

## Config

Feed config lives at `.codex/feed.toml`.

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

Source ids should use letters, numbers, dots, underscores, and hyphens.

Use `latest_only = true` for feeds where a cold start should only observe the
newest entry. Use `max_items` for a small bounded replay window.

## Commands

```bash
codex-toys feed doctor --json
codex-toys feed source list --json
codex-toys feed poll --source project-releases --json
codex-toys feed item list --source project-releases --status new --json
codex-toys feed item read <item-id> --json
codex-toys feed collect --cursor radar --limit 50 --no-advance --json
codex-toys feed cursor advance --cursor radar --item <item-id> --json
codex-toys feed dispatch --source project-releases --cursor radar --target workbench-task:release-check --json
codex-toys feed prune --older-than-days 90 --dry-run
```

With `--ssh`, the local CLI starts the remote toybox and calls the same feed
methods in the remote root selected by `--cwd`.

```bash
codex-toys --ssh <target> --cwd <remote-workbench> feed poll --json
codex-toys --ssh <target> --cwd <remote-workbench> feed collect --cursor radar --json
```

## State

Feed state is mode-scoped.

```text
.codex/feed/local/
  sources/
  items/
  runs/
  collect-cursors/
  locks/

.codex/feed/actions/
  sources/
  items/
  runs/
  collect-cursors/
  locks/
```

Local mode writes `.codex/feed/local`. Actions mode writes
`.codex/feed/actions` only when explicitly selected or when auto mode resolves
under an Actions environment.

## SDK

```ts
import {
  advanceFeedCursor,
  collectFeedItems,
  createFeedContext,
  dispatchFeedItems,
  loadFeedConfig,
  pollFeedSources,
  toFeedEvent
} from "codex-toys/feed";

const context = await createFeedContext({ root: "/repo", mode: "local" });
const config = await loadFeedConfig(context);

await pollFeedSources(context, config, { sourceId: "project-releases" });

const batch = await collectFeedItems(context, {
  cursor: "radar",
  limit: 50,
  advance: false
});

for (const item of batch.items) {
  const event = toFeedEvent(item);
  await advanceFeedCursor(context, { cursor: "radar", itemId: item.id });
}

await dispatchFeedItems(context, config, {
  sourceId: "project-releases",
  cursor: "radar",
  target: "workbench-task:release-check",
  runTarget: async (_target, event) => event
});
```

## Boundary

Feed owns source config, polling, HTTP checkpoints, item dedupe, durable item
storage, collection cursors, cursor advancement, ack-aware dispatch mechanics,
and pruning.

Products own source catalogs, scoring, filtering, prompt templates, dashboards,
dispatch-run policy, and external writes.
