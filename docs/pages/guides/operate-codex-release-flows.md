---
title: Operate Codex release flows
description: Understand the packaged openai/codex release automation and its safety gates.
---

# Operate Codex release flows

The upstream `openai/codex` release event fans out to packaged automation in
this repository. Treat these flows as real release machinery, not as generic
smoke tests.

## Event

The release path starts from a generic event:

```json
{
  "id": "patch:upstream.release:openai/codex:rust-v1.2.3",
  "type": "upstream.release",
  "source": "patch",
  "receivedAt": "2026-05-15T00:00:00.000Z",
  "payload": {
    "repo": "openai/codex",
    "tag": "rust-v1.2.3"
  }
}
```

Products such as Patch create this event from upstream release feeds and
dispatch it through the shared flow client or HTTP backend.

## Packaged steps

- `openai-codex-bindings`: Node runner. Uses canonical `@openai/codex@version`,
  regenerates `@peezy.tech/codex-flows` app-server bindings, runs checks,
  commits when changed, and can push or trigger trusted publishing when
  configured.
- `peezy-codex-fork`: Node runner. Rebases the Peezy fork patch stack onto
  the upstream release tag, verifies the fork, and can push or tag to trigger
  the fork release flow when configured. It also accepts `upstream.branch_update`
  for upstream main movement.
- `peezy-codex-flows-fork`: Node runner. Accepts `downstream.release` events for
  `@peezy.tech/codex` and `@peezy.tech/codex-flows`, rebuilds a local `fork`
  branch from `main` plus the ordered `patch/*` branches, applies release
  package metadata, runs the `@peezy.tech/codex-flows` release check, and packs
  a local fork tarball.

## Publishing gates

Packaged defaults may commit local changes when appropriate, but they do not
push or publish unless deployment configuration allows it:

```bash
CODEX_FLOW_PUSH=1
CODEX_FLOW_PUBLISH=1
```

Equivalent flow config fields can enable the same behavior:

```toml
[config]
push = true
publish = true
```

The codex-flows fork release flow also supports:

```bash
CODEX_FLOW_LINK_LOCAL_PACKAGE=1
PEEZY_CODEX_VERSION=0.130.0
```

`CODEX_FLOW_LINK_LOCAL_PACKAGE=1` links the fork package locally after packing.
`PEEZY_CODEX_VERSION` pins the Codex fork dependency when the triggering event
is a codex-flows release rather than a Codex release.

The codex-flows fork release flow treats Git patch branches as the source of
truth for fork-only behavior. Code Mode flow support, fork-generated app-server
bindings, and Peezy Codex defaults belong on ordered `patch/*` branches, not on
the upstream-compatible `main` branch.

## Safe verification

Do not fabricate a full `openai/codex` release lifecycle test. Until the next
real upstream release, use:

- backend health checks
- non-release smoke events
- stored event inspection
- replay of already accepted events when recovery is needed

This avoids accidentally running release, push, or publishing automation from a
made-up upstream lifecycle.
