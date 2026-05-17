---
title: flow.toml
description: Manifest fields for codex-flow packages.
---

# flow.toml

`flow.toml` declares a flow package and its steps.

```toml
name = "example-flow"
version = 1
description = "Short operational purpose."

[config]
commit = true

[[steps]]
name = "do-work"
runner = "bun"
script = "exec/do-work.ts"
timeout_ms = 300000

[steps.trigger]
type = "upstream.release"
schema = "schemas/upstream-release.schema.json"
```

## Top-level fields

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `name` | string | Yes | Stable flow package name. |
| `version` | number | Yes | Manifest version for run records and workers. |
| `description` | string | Yes | Human-readable purpose. |
| `config` | table | No | Flow-owned configuration passed to steps. |

## Step fields

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `name` | string | Yes | Step name within the flow. |
| `runner` | `"bun"` or `"code-mode"` | Yes | Execution runner. |
| `script` | string | Yes | Path relative to the flow root. |
| `timeout_ms` | number | Yes | Step timeout. |
| `cwd` | string | No | Working directory relative to the flow root. |

For `runner = "bun"`, `script` may be either a raw script that reads context
from stdin and emits `FLOW_RESULT`, or a module-style script with a default
export that returns a `FlowResult`. Module-style scripts can use
`defineBunFlow()` and `createCodexFlowClientFromContext()` from
`@peezy.tech/codex-flows/flow-runtime/bun`.

## Trigger fields

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `type` | string | Yes | `FlowEvent.type` to match. |
| `schema` | string | Yes | JSON Schema file for `FlowEvent.payload`. |
