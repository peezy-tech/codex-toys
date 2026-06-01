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

It does not own product-specific completion:

- Patch fork policy
- organization release rules
- pet-game asset registration
- payment state
- minting
- channel-specific write tools
- product dashboards and arbitrary app-server thread wrappers

Keep domain completion in the consuming app. For example, a release automation
can inspect an upstream signal and start a Codex turn, but the product still
owns publishing, branch protection, credential use, and any external writes.

Presenter wrappers follow the same rule. Their app-server thread presentation,
delegation policy, and workbench presentation state are not part of turn
automation itself.
