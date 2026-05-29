---
title: Single package platform
description: Target shape for exposing Codex app-server clients, turn automation, agent primitives, proxy helpers, and CLIs through one package.
---

# Single package platform

The platform goal is to make `@peezy.tech/codex-flows` the one package users
install when they want the core Codex workspace surface: app-server clients,
turn automation helpers, stdio agent helpers, optional proxy helpers, workspace
autonomy, and transplant tools.

## Goal

`@peezy.tech/codex-flows` is the canonical public package for:

- app-server JSON-RPC clients, generated protocol types, and stdio transports
- turn automation helpers
- local and SSH agent helpers
- generic proxy helpers for browser dashboards
- terminal tools for app-server calls, turn automation, memory transplant,
  workspace autonomy, and pack installation

External presenters remain separate products. They should consume the agent or
proxy surfaces and advertise capabilities instead of depending on private
in-repo app structure.

## Composition Model

`workspace.initialize` is the stable composition point. Agents expose
capabilities such as app-server pass-through, functions, delegation, workbench
state, hook-spool handling, and workspace task execution. The proxy projects
that self-described surface into HTTP without duplicating feature-specific
routes.

## Package Boundary

The package keeps browser-safe exports separate from Node-only process code:

- browser helpers stay fetch-only
- process bins are exposed through package `bin` entries
- product-specific presenter dependencies stay outside the core package
- release checks smoke-test importable subpaths and runnable bins

## Release Implications

New public core runtime surfaces should ship through `@peezy.tech/codex-flows`
first. Product-owned presenter surfaces should use `@peezy.tech/codex-flows`
without becoming part of this release surface.
