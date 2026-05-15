---
title: Author a flow package
description: Structure a reusable flow package with triggers, schemas, and steps.
---

# Author a flow package

Use a flow package when automation should be reusable across products or
backends. A package is just a manifest, schemas, and executable step files.

## Layout

```text
flow.toml
schemas/*.schema.json
exec/*
```

Source packages live under `flows/*`. Installed packages can live under
`.codex/flows/*`; installed copies take precedence so a workspace can override
or pin a flow without editing source packages.

## Manifest

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

Keep event payload shape in JSON Schema. Product-specific payload fields belong
in the schema and event payload, not in the generic runner.

## Step input

Bun steps receive a JSON context on stdin:

```json
{
  "flow": {
    "name": "example-flow",
    "version": 1,
    "root": "/repo/flows/example-flow",
    "step": "do-work",
    "config": {},
    "event": {}
  }
}
```

## Step output

Print a final `FLOW_RESULT` line:

```ts
console.log(`FLOW_RESULT ${JSON.stringify({
  status: "completed",
  message: "updated bindings",
})}`);
```

Use `blocked` or `needs_intervention` when a human or external condition is
required. Clients and backends mark those statuses as needing attention.
