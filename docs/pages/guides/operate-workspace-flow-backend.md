---
title: Operate the workspace flow backend
description: Run the local workspace backend flow capability and inspect stored events.
---

# Operate the workspace flow backend

The local workspace backend includes the durable flow capability. It can accept
generic `FlowEvent` JSON over the networked HTTP surface, persist events and
runs, start matching steps locally, and replay stored events.

In embedded local mode, tools can call the same flow capability directly without
HTTP. The routes below are the optional networked surface mounted by
`codex-workspace-backend-local`.

## Start the backend

```bash
bun run workspace:backend --cwd /home/peezy/codex-flows-public
```

Useful environment:

```bash
CODEX_WORKSPACE_BACKEND_HOST=127.0.0.1
CODEX_WORKSPACE_BACKEND_PORT=3586
CODEX_FLOW_BACKEND_DATA_DIR=/var/lib/codex-workspace-flow
CODEX_FLOW_BACKEND_SECRET=shared-hmac-secret
CODEX_FLOW_BACKEND_EXECUTOR=direct
```

Set `CODEX_FLOW_BACKEND_EXECUTOR=systemd-run` to wrap each step in a transient
`systemd-run --user --wait --collect` unit. The default `direct` executor is
suitable when the backend service itself is already managed by systemd.

## Dispatch

```bash
curl -X POST http://127.0.0.1:3586/events \
  -H 'content-type: application/json' \
  --data @event.json
```

When `CODEX_FLOW_BACKEND_SECRET` is configured, dispatches must include
`x-flow-signature-256` with an HMAC SHA-256 body signature.

## Inspect and replay

```bash
bun run flow:backend list-events --limit 20
bun run flow:backend show-event 'patch:source:entry:upstream.release'
bun run flow:backend list-runs --status failed --limit 20
bun run flow:backend show-run run_abc123
bun run flow:backend replay-event 'patch:source:entry:upstream.release' --wait
```

Normal dispatch is idempotent by `event.id`. Replay intentionally creates a new
run attempt.

## Back up state

The capability stores SQLite state under `CODEX_FLOW_BACKEND_DATA_DIR` and per
event JSON files under `CODEX_FLOW_BACKEND_DATA_DIR/events`. Back up the whole
data directory while the service is stopped, or use SQLite online backup plus a
copy of the `events/` directory.
