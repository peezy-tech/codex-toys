---
title: Package stack
description: How the codex-toys packages separate native Codex bridge, toybox, remote, workbench, Actions, proxy, kits, and CLI surfaces.
---

# Package stack

The project is a feature stack, not one large library with many subpath exports.
Each package owns a coherent boundary, while `codex-toys` remains the CLI and
umbrella runtime export for users who want everything.

## Boundaries

- `@codex-toys/bridge`: native Codex app-server and durable Codex state bridge.
- `@codex-toys/toybox`: stdio JSON-RPC protocol between operators and toyboxes.
- `@codex-toys/workbench`: repo-local workbench policy, queues, functions,
  delegation, automation, and overview.
- `@codex-toys/actions`: CI auth and state preparation for workbench runs.
- `@codex-toys/remote`: SSH transport and remote preflight/control helpers.
- `@codex-toys/proxy`: optional HTTP, browser, and Vite edge for dashboards.
- `@codex-toys/kits`: optional file-copy kits for skills, plugins, and
  automation templates.
- `codex-toys`: CLI plus umbrella export.

## Composition Model

`toybox.initialize` is the stable runtime composition point. Toyboxes advertise
available methods and metadata; the CLI, proxy, browser client, and custom tools
can discover the same surface without duplicating route definitions.

The workbench package builds on that surface. It owns durable queue state under
`.codex/workbench/*`, but product-specific completion remains outside the stack:
credentials, deployments, trading actions, release side effects, and domain
state belong to the installing product.

## Naming Contract

The clean-cut user surface uses:

```text
codex-toys workbench ...
codex-toys kit inspect
codex-toys kit add
codex-toys kit list
codex-toys kit doctor
codex-kit.toml
.codex/kit-lock.json
.codex/kit-backups/
```

Earlier command names are intentionally not part of this package line.
