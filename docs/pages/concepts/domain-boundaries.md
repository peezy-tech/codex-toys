---
title: Domain boundaries
description: What codex-flows owns and what products must keep.
---

# Domain boundaries

Turn automation owns prompt automation:

- running a pre-turn script
- reading the script's returned JSON result
- starting, reading, and waiting on native Codex turns through app-server or a
  workspace backend
- targeting remote workspaces through the SSH provider

It does not own product-specific completion:

- Patch fork policy
- organization release rules
- pet-game asset registration
- payment state
- minting
- channel-specific write tools
- workspace backend presenters and arbitrary app-server thread wrappers

Keep domain completion in the consuming app. For example, a release automation
can inspect an upstream signal and start a Codex turn, but the product still
owns publishing, branch protection, credential use, and any external writes.

Presenter wrappers follow the same rule. Their app-server thread orchestration,
delegation policy, workbench presentation state, and hook-spool wake behavior
are not part of turn automation itself.
