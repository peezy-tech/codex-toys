---
title: Package stack
description: How codex-toys separates native Codex bridge, toybox, remote, workbench, Actions, proxy, kits, and CLI surfaces.
---

# Package stack

The project is a feature stack with internal packages and one public npm
package. Each internal package owns a coherent boundary, while `codex-toys`
remains the CLI and public runtime package for users who want everything.

## Boundaries

- `packages/bridge`: native Codex app-server and durable Codex state bridge,
  exposed publicly as `codex-toys/bridge`.
- `packages/toybox`: stdio JSON-RPC protocol between operators and toyboxes,
  exposed publicly as `codex-toys/toybox`.
- `packages/workbench`: repo-local workbench policy, queues, functions,
  delegation, automation, and overview.
- `packages/actions`: CI auth and state preparation for workbench runs,
  exposed publicly as `codex-toys/actions`.
- `packages/remote`: SSH transport and remote preflight/control helpers,
  exposed publicly as `codex-toys/remote`.
- `packages/proxy`: optional HTTP, browser, and Vite edge for dashboards,
  exposed publicly as `codex-toys/proxy`.
- `packages/kits`: optional file-copy kits for skills, plugins, and
  automation templates.
- `packages/codex-toys`: CLI, bundled public tarball, and umbrella export.

The `@codex-toys/*` package names are internal workspace names. Consumers should
install `codex-toys` and import from `codex-toys/*` subpaths.

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
