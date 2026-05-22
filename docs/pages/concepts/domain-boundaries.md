---
title: Domain boundaries
description: What generic flow infrastructure owns and what products must keep.
---

# Domain boundaries

Generic flow infrastructure owns reusable automation mechanics:

- event dispatch
- flow discovery
- payload schema matching
- local step execution
- backend event/run persistence
- replay and cancellation where supported
- output, attempts, and result payload storage
- normalized inspection views

It does not own product-specific completion:

- Patch fork policy
- organization release rules
- pet-game asset registration
- payment state
- minting
- channel-specific write tools
- workspace backend presenters and arbitrary app-server thread wrappers

Keep domain completion in the consuming app. For example, a pet-game worker can
generate an asset through a flow step, upload the asset, update payment state,
mint if needed, and only then complete the generic run.

This boundary keeps flow packages portable and prevents generic backends from
depending on app-specific Convex schemas, credentials, or release policy.

Presenter wrappers follow the same rule. They may inspect generic flow runs and
events for an operator, but their app-server thread orchestration, delegation
policy, workbench presentation state, and hook-spool wake behavior are not part
of the generic codex-flow backend contract.
