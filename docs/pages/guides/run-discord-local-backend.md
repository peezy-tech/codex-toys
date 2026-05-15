---
title: Run Discord over a local backend
description: Start the Discord bridge with the in-process local Codex gateway backend.
---

# Run Discord over a local backend

Use the local gateway backend when Discord should be the operator surface for a
Codex workspace on the same host.

## 1. Configure Discord access

Set the bot token and allowlists:

```bash
export CODEX_DISCORD_BOT_TOKEN="..."
export CODEX_DISCORD_ALLOWED_USER_IDS="123456789"
export CODEX_DISCORD_ALLOWED_CHANNEL_IDS="987654321"
```

To enable gateway mode, set a home channel:

```bash
export CODEX_DISCORD_HOME_CHANNEL_ID="987654321"
```

## 2. Choose the app-server mode

Start with a local stdio app-server:

```bash
bun ./apps/discord-bridge/src/index.ts --local-app-server
```

Or connect to an app-server that is already running:

```bash
bun ./apps/discord-bridge/src/index.ts \
  --app-server-url ws://127.0.0.1:3585 \
  --approval-policy never \
  --sandbox danger-full-access
```

Both modes use the same in-process `LocalCodexGatewayBackend`.

## 3. Add optional workbench channels

Workbench channels let the gateway keep workspace dashboards and task threads:

```bash
export CODEX_DISCORD_WORKSPACE_FORUM_CHANNEL_ID="111111111"
export CODEX_DISCORD_TASK_THREADS_CHANNEL_ID="222222222"
```

Set both values together. A partial workbench configuration is invalid.

## 4. Enable hook-spool returns

Install hooks for the runtime backing the gateway:

```bash
codex-discord-bridge hook install
```

The hook command writes lifecycle events into the spool directory. The local
backend drains those files, updates observed thread state, returns delegated
results, and wakes the main operator thread when policy says to.

## 5. Add optional flow inspection

If a codex-flow backend is running, point the gateway at it:

```bash
export CODEX_FLOW_BACKEND_URL="http://127.0.0.1:8787"
```

This enables read-only `codex_gateway.list_flow_runs` and
`codex_gateway.list_flow_events`. It does not make the gateway backend a flow
executor.
