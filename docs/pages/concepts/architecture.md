---
title: Architecture
description: How turn automation, Codex app-server, workspace backends, and apps fit together.
---

# Architecture

codex-flows centers on plugin-native prompt automation and native Codex turns.
The primary runtime is intentionally narrow: a named automation runs code,
decides whether work is needed, and starts a native app-server turn only when
there is something worth asking Codex to do.

```mermaid
sequenceDiagram
  participant Signal as Event, schedule, hook, or operator
  participant Script as Pre-turn script
  participant Codex as Codex app-server

  Signal->>Script: JSON context
  Script-->>Signal: skip
  Script-->>Codex: turn decision with prompt/cwd/settings
  Codex-->>Codex: native turn uses normal tools and skills
```

The workspace backend is the remote-friendly control surface. It owns app-server
pass-through, delegation, hook-spool routing, workspace state, and the policy
needed to run scheduled tasks. Product-specific completion still stays outside
codex-flows: each product owns credentials, release rules, external writes, and
the final side effects that happen after a Codex turn.
