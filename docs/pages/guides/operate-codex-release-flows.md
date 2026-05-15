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

- `openai-codex-bindings`: Bun runner. Uses canonical `@openai/codex@version`,
  regenerates `@peezy.tech/codex-flows` app-server bindings, runs checks,
  commits when changed, and can push or trigger trusted publishing when
  configured.
- `peezy-codex-fork`: Code Mode runner. Rebases the Peezy fork patch stack onto
  the upstream release tag, optionally squashes the patch stack, verifies the
  fork, and can push or tag to trigger the fork release flow when configured.

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

## Safe verification

Do not fabricate a full `openai/codex` release lifecycle test. Until the next
real upstream release, use:

- backend health checks
- non-release smoke events
- stored event inspection
- replay of already accepted events when recovery is needed

This avoids accidentally running release, push, or publishing automation from a
made-up upstream lifecycle.
