---
title: CLI reference
description: Commands for local flow execution and backend operation.
---

# CLI reference

## Local runner

```bash
bun run flow list
bun run flow fire --event event.json
bun run flow run <flow> <step> --event event.json
```

`flow fire` dispatches through the local client and runs every step whose
trigger type and schema match the event.

## systemd-local backend

```bash
bun run flow:backend serve --cwd <workspace>
bun run flow:backend list-events --limit 20
bun run flow:backend show-event <event-id>
bun run flow:backend list-runs --status failed --limit 20
bun run flow:backend show-run <run-id>
bun run flow:backend replay-event <event-id> --wait
```

## Common environment

| Variable | Purpose |
|----------|---------|
| `CODEX_FLOWS_MODE=code-mode` | Enables Code Mode flow steps and Peezy Codex defaults. |
| `CODEX_APP_SERVER_CODEX_COMMAND` | Overrides the Codex command for stdio app-server launches. |
| `CODEX_FLOW_BACKEND_URL` | HTTP backend URL for consumers such as Discord bridge inspection. |
| `CODEX_FLOW_BACKEND_SECRET` | Shared HMAC secret for systemd-local dispatch. |
| `CODEX_FLOW_BACKEND_EXECUTOR` | `direct` or `systemd-run`. |
| `CODEX_FLOW_BACKEND_DATA_DIR` | Durable backend state directory. |
