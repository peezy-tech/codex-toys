---
title: Single package platform
description: Target shape for exposing Codex flows clients, runtime, backend primitives, and CLIs through one package.
---

# Single package platform

The platform goal is to make `@peezy.tech/codex-flows` the one package users
install when they want the core Codex flows/workspace surface: app-server
clients, flow runtime helpers, workspace backend primitives, and the local
backend process.

## Goal

`@peezy.tech/codex-flows` is the canonical public package for:

- app-server JSON-RPC clients, generated protocol types, and transports
- flow helpers and local flow execution under
  `@peezy.tech/codex-flows/flow-runtime`
- workspace backend protocol client/server helpers
- the local workspace backend process
- terminal tools for app-server calls, local flow runs, memory transplant,
  workspace autonomy, and pack installation

Backends and external presenters remain separate processes. The package
boundary is the core protocol/runtime boundary, not the product surface
boundary. A user can install the core package and operate the local workspace
backend directly:

```bash
codex-workspace-backend-local serve --local-app-server
```

## Composition Model

The workspace backend protocol is the stable composition point. Backends expose
capabilities such as app-server pass-through, delegation, workbench state, hook
spool handling, and flow inspection. External presenters can consume that
protocol and project selected behavior into product-owned surfaces.

External backends and presenters are expected. They should implement or consume
the workspace backend protocol and advertise capabilities instead of depending
on private in-repo app structure.

## Package Boundary

The package should keep browser-safe exports separate from Node-only
process code:

- browser-safe clients stay under `@peezy.tech/codex-flows/browser` and similar
  importable subpaths
- process bins are exposed through package `bin` entries
- product-specific presenter dependencies stay outside the core package and
  release surface
- release checks smoke-test both importable subpaths and runnable bins

The current consolidation path keeps the private workspace app source layout for
development, then builds the reusable flow runtime and selected app entries into
the publishable package dist. That gives users a single package while avoiding a
large source move up front.

## Release Implications

New public core runtime surfaces should ship through `@peezy.tech/codex-flows`
first. Product-owned presenter surfaces should use `@peezy.tech/codex-flows` for
the protocol and backend composition layer without becoming part of this release
surface.

Release validation for the canonical package must cover:

- TypeScript declarations and importable subpath smoke tests
- `--help` smoke tests for every published bin
- package dry-run output that includes the expected dist files
- docs that show backend composition through the core package

When a compatibility package is still published, the release notes should state
whether it is a compatibility artifact or a required install target.
