---
title: Single package platform
description: Target shape for exposing Codex flows clients, runtime, backend primitives, and CLIs through one package.
---

# Single package platform

The platform goal is to make `@peezy.tech/codex-flows` the one package users
install when they want the core Codex flows/workspace surface: app-server
clients, flow runtime helpers, workspace backend primitives, and the local
backend process. Gateway packages should consume that core package instead of
being bundled into it.

## Goal

`@peezy.tech/codex-flows` is the canonical public package for:

- app-server JSON-RPC clients, generated protocol types, and transports
- flow helpers and local flow execution under
  `@peezy.tech/codex-flows/flow-runtime`
- workspace backend protocol client/server helpers
- the local workspace backend process
- terminal tools for app-server calls, local flow runs, memory transplant,
  workspace autonomy, and pack installation

Backends and gateways remain separate processes. The package boundary is the
core protocol/runtime boundary, not the channel boundary. A user can install the
core package, then combine it with separately published gateway packages:

```bash
codex-workspace-backend-local serve --local-app-server
# from an external gateway package:
codex-workspace-voice-gateway --workspace-backend-url ws://127.0.0.1:3586
```

## Composition Model

The workspace backend protocol is the stable composition point. Backends expose
capabilities such as app-server pass-through, delegation, workbench state, hook
spool handling, and flow inspection. Gateways consume that protocol and project
selected behavior into another surface, such as Discord text or Discord voice.

External backends and gateways are expected. They should implement or consume the
workspace backend protocol and advertise capabilities instead of depending on
private in-repo app structure. `@peezy.tech/codex-discord-bridge` and
`@peezy.tech/codex-workspace-voice-gateway` are examples of gateway packages
that should depend on `@peezy.tech/codex-flows`.

## Package Boundary

The package should keep browser-safe exports separate from Node-only
process code:

- browser-safe clients stay under `@peezy.tech/codex-flows/browser` and similar
  importable subpaths
- process bins are exposed through package `bin` entries
- gateway dependencies that are heavy, platform-sensitive, or channel-specific
  stay in their own gateway packages
- release checks smoke-test both importable subpaths and runnable bins

The current consolidation path keeps the private workspace app source layout for
development, then builds the reusable flow runtime and selected app entries into
the publishable package dist. That gives users a single package while avoiding a
large source move up front.

## Release Implications

New public core runtime surfaces should ship through `@peezy.tech/codex-flows`
first. Gateway packages may publish separately when they add channel-specific
dependencies or policy, but they should use `@peezy.tech/codex-flows` for the
protocol and backend composition layer.

Release validation for the canonical package must cover:

- TypeScript declarations and importable subpath smoke tests
- `--help` smoke tests for every published bin
- package dry-run output that includes the expected dist files
- docs that show backend and gateway composition through the core package

When a compatibility package is still published, the release notes should state
whether it is a compatibility artifact or a required install target.
