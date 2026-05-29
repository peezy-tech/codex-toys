---
title: Architecture
description: How turn automation, Codex app-server, agents, proxy edges, and apps fit together.
---

# Architecture

codex-flows centers on plugin-native prompt automation and native Codex turns.
The primary runtime is intentionally narrow: a named automation runs code,
decides whether work is needed, and can start, wait on, and compose native
app-server turns only when there is something worth asking Codex to do.

```mermaid
sequenceDiagram
  participant Signal as Event, schedule, hook, or operator
  participant Agent as codex-flows agent
  participant Script as Pre-turn script
  participant Codex as Codex app-server

  Signal->>Agent: local stdio or SSH stdio
  Agent->>Script: JSON context
  Script-->>Agent: JSON result
  Script-->>Codex: optional turn.start with prompt/cwd/settings
  Script-->>Codex: optional turn.read / turn.wait orchestration
  Codex-->>Codex: native turn uses normal tools and skills
```

The agent is the remote-friendly control surface. It owns app-server
pass-through, workspace functions, delegation, automation helpers, and the
policy needed to run scheduled tasks. Product-specific completion still stays
outside codex-flows: each product owns credentials, release rules, external
writes, and final side effects.

Browser dashboards are optional edges. They run `codex-flows-proxy`, fetch
`/api/schema`, and call generic app/workspace methods. The proxy does not add a
second orchestration model.
