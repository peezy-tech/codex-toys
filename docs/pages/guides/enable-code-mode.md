---
title: Enable Code Mode
description: Gate Code Mode steps explicitly and configure the Codex executor.
---

# Enable Code Mode

`runner = "code-mode"` starts a Codex app-server and calls the fork-only
`thread/codeMode/execute` method. Code Mode remains opt-in because it executes
Codex work with repository access and tool permissions.

## Enable the mode

```bash
CODEX_FLOWS_MODE=code-mode
```

That mode also makes stdio app-server launches default to:

```bash
bunx @peezy.tech/codex app-server
```

Use `CODEX_APP_SERVER_CODEX_COMMAND` when a specific local binary should run
instead. `CODEX_APP_SERVER_CODEX_PACKAGE` can point at another npm package.

## Narrow runner-only gate

The older flag is still accepted:

```bash
CODEX_FLOWS_ENABLE_CODE_MODE=1
```

Prefer `CODEX_FLOWS_MODE=code-mode` for deployments because it configures both
flow selection and the default Codex command.

## Keep orchestration and execution separate

Local flow orchestration can still use a local or remote Codex executor in the
future. Do not simulate remote Code Mode by shelling out through unrelated HTTP
APIs; wait for a real remote app-server transport.
