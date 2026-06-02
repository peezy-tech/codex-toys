---
title: Domain boundaries
description: What codex-toys owns and what products must keep.
---

# Domain boundaries

Turn automation owns prompt automation:

- running a pre-turn script
- reading the script's returned JSON result
- starting, reading, and waiting on native Codex turns through app-server or an
  codex-toys toybox
- targeting remote workbenches through SSH stdio

Feed owns external signal intake:

- reading `.codex/feed.toml`
- polling configured RSS sources
- normalizing entries into durable feed items
- recording source checkpoints
- collecting items through named cursors
- advancing cursors after acknowledged delivery
- generic dispatch to workbench-task targets

It does not own product-specific completion:

- Patch fork policy
- organization release rules
- feed source scoring and product dispatch policy
- pet-game asset registration
- payment state
- minting
- channel-specific write tools
- product dashboards and arbitrary app-server thread wrappers

Keep domain completion in the consuming app. For example, feed can ingest an
upstream RSS item and dispatch it to a release automation, but the product still
owns publishing, branch protection, credential use, prompt policy, and any
external writes.

Presenter wrappers follow the same rule. Their app-server thread presentation,
delegation policy, and workbench presentation state are not part of turn
automation itself.
