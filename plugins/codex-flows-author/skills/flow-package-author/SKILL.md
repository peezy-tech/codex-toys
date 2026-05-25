---
name: flow-package-author
description: Use when creating or updating advanced portable Codex flow packages that need flow.toml manifests, generic FlowEvent contracts, durable run state, JSON Schema payload validation, exec snippets, fixtures, and installed/source flow bundle layout.
---

# Flow Package Author

Use this skill for the mechanics of packaging arbitrary durable flows. Prefer turn automation when a script only needs to decide whether to start a native Codex prompt. This skill does not define project-specific release, remote, mirror, credential, or publishing policy.

## Core Rules

- Use `flow` naming: flow bundle, `flow.toml`, flow step, flow event, `FLOW_RESULT`.
- Treat flow packages as the heavier event/run-state layer, not the default plugin automation surface.
- Keep the event envelope generic: `id`, `type`, optional `source`, optional `occurredAt`, `receivedAt`, and `payload`.
- Put domain-specific payload shape in `schemas/*.schema.json`; do not bake repo, package, release, or git fields into the core event envelope.
- If a flow needs project-specific behavior, declare it in `guidance.skills` and read those skills/docs before writing push, publish, mirror, branch-protection, or credential behavior.
- Flow packages should be idempotent by `event.id`.

## Layout

Packageable source layout:

```text
flows/<name>/
  flow.toml
  schemas/*.schema.json
  exec/*.js
  README.md
  fixtures/
  tests/
```

Installed operational layout:

```text
.codex/flows/<name>/
  flow.toml
  schemas/*.schema.json
  exec/
```

## Manifest

`flow.toml` should define:

```toml
name = "example-flow"
version = 1
description = "Short purpose."

[guidance]
skills = []

[config]
# Package-specific, portable settings. Prefer env var names over secrets.
commit = false

[[steps]]
name = "step-name"
runner = "node"
script = "exec/step-name.js"
timeout_ms = 300000

[steps.trigger]
type = "example.event"
schema = "schemas/example-event.schema.json"
```

## Result Contract

Raw step scripts must emit exactly one line:

```text
FLOW_RESULT {"status":"completed","message":"...","artifacts":{},"next":[]}
```

Module-style Node step scripts can instead export a default handler that returns
the same result object.

Valid statuses are `skipped`, `completed`, `changed`, `needs_intervention`, `blocked`, and `failed`.

## Authoring Checklist

- Add a schema for every nontrivial event payload.
- Add at least one fixture event for each trigger.
- Keep exec snippets relative to the flow bundle.
- Put portable defaults and environment variable names in `[config]`; do not put secret values in the manifest.
- Avoid hidden local handled-state as truth; prefer event ids, durable artifacts, remote refs, or backend run records.
- Keep org-specific instructions out of this skill and inside the flow package README or referenced guidance skills.
