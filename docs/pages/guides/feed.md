---
title: Feed
description: Poll RSS and Atom feeds into durable codex-toys feed items and collect them by cursor.
---

# Feed

`feed` is the codex-toys primitive for durable external signal intake. It polls
configured RSS and Atom sources, normalizes entries into feed items, records source
checkpoints, and lets consumers collect new items with named cursors.

Feed does not decide what a signal means. HQ/Radar, a turn automation, or a
workbench task can read feed items and decide whether to enqueue a prompt,
create a deferred run, update a dashboard, or ignore the item.

## Config

Feed config lives at `.codex/feed.toml`:

```toml
[feed]
name = "example"

[[feed.sources]]
id = "openai-blog"
kind = "rss"
url = "https://example.com/rss.xml"
latest_only = true
# max_items = 3
max_content_bytes = 20000
store_raw = false

[[feed.sources]]
id = "cli-utility-releases"
kind = "atom"
url = "https://github.com/peezy-tech/cli-utility/releases.atom"
latest_only = true
store_raw = true
```

Source ids are stable durable ids. They should use only letters, numbers, dots,
underscores, and hyphens.

Use `latest_only = true` for release feeds where a cold start should only
observe the newest release. Use `max_items` for a small bounded replay window.

## Commands

```bash
codex-toys feed doctor
codex-toys feed source list
codex-toys feed poll --source openai-blog --json
codex-toys feed item list --source openai-blog --status new --json
codex-toys feed item read <item-id> --json
codex-toys feed collect --cursor radar --limit 50 --no-advance --json
codex-toys feed cursor advance --cursor radar --item <item-id> --json
codex-toys feed dispatch --source openai-blog --cursor radar --target workbench-task:release-refresh --json
codex-toys feed prune --older-than-days 90 --dry-run
```

With `--ssh`, the local CLI starts the remote toybox and calls the same
`feed.*` methods in the remote root selected by `--cwd`:

```bash
codex-toys --ssh devbox --cwd /repo feed poll --json
codex-toys --ssh devbox --cwd /repo feed collect --cursor radar --json
```

## State

Feed state is mode-scoped:

```text
.codex/
  feed.toml
  feed/
    local/
      sources/
      items/
      runs/
      collect-cursors/
      locks/
    actions/
      sources/
      items/
      runs/
      collect-cursors/
      locks/
```

Local mode writes `.codex/feed/local`. Actions mode writes
`.codex/feed/actions` only when explicitly selected by `--mode actions` or when
`--mode auto` runs under `GITHUB_ACTIONS=true`. Workbench Actions helpers include
`.codex/feed/actions` in the durable state commit path.

## SDK

```ts
import {
  advanceFeedCursor,
  collectFeedItems,
  createFeedContext,
  dispatchFeedItems,
  loadFeedConfig,
  pollFeedSources,
  toFeedEvent,
} from "codex-toys/feed";

const context = await createFeedContext({ root: "/repo", mode: "local" });
const config = await loadFeedConfig(context);

await pollFeedSources(context, config, {
  sourceId: "openai-blog",
});

const batch = await collectFeedItems(context, {
  cursor: "radar",
  limit: 50,
  advance: false,
});

for (const item of batch.items) {
  const event = toFeedEvent(item);
  // Product code decides whether to enqueue a prompt or take another action.
  await advanceFeedCursor(context, { cursor: "radar", itemId: item.id });
}

await dispatchFeedItems(context, config, {
  sourceId: "openai-blog",
  cursor: "radar",
  target: "workbench-task:release-refresh",
  runTarget: async (_target, event) => {
    // CLI/toybox integrations provide the workbench target runner.
    return event;
  },
});
```

## Boundary

Feed owns generic intake:

- source config
- RSS/Atom polling
- HTTP checkpoints
- item dedupe
- durable item storage
- collection cursors
- explicit cursor advancement
- ack-aware dispatch mechanics
- pruning

Products own domain completion:

- source catalogs
- scoring and filtering
- prompt templates
- dashboards
- queue/deferred-run and dispatch policy
- external writes
