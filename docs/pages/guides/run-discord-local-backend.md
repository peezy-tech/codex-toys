---
title: Run Discord over a local backend
description: Start the Discord bridge with the embedded local Codex workspace backend.
---

# Run Discord over a local backend

Use the embedded local workspace backend when Discord should be the operator
surface for a Codex workspace on the same host. This mode does not require a
browser-facing HTTP surface; the bridge constructs the backend in-process.

## 1. Configure Discord access

Set the bot token and allowlists:

```bash
export CODEX_DISCORD_BOT_TOKEN="..."
export CODEX_DISCORD_ALLOWED_USER_IDS="123456789"
export CODEX_DISCORD_ALLOWED_CHANNEL_IDS="987654321"
```

To enable workspace mode, set a home channel:

```bash
export CODEX_DISCORD_HOME_CHANNEL_ID="987654321"
```

## 2. Choose the app-server mode

Start with a local stdio app-server:

```bash
codex-discord-bridge --local-app-server
```

Or connect to an app-server that is already running:

```bash
codex-discord-bridge \
  --app-server-url ws://127.0.0.1:3585 \
  --approval-policy never \
  --sandbox danger-full-access
```

Both modes use the same in-process `LocalCodexWorkspaceBackend`.

## 3. Add optional workbench channels

Workbench channels let the workspace backend keep workspace dashboards and task
threads:

```bash
export CODEX_DISCORD_WORKSPACE_FORUM_CHANNEL_ID="111111111"
export CODEX_DISCORD_TASK_THREADS_CHANNEL_ID="222222222"
```

Set both values together. A partial workbench configuration is invalid.

## 4. Enable hook-spool returns

Install hooks for the runtime backing the workspace backend:

```bash
codex-discord-bridge hook install
```

The hook command writes lifecycle events into the spool directory. The local
backend drains those files, updates observed thread state, returns delegated
results, and wakes the main operator thread when policy says to.

## 5. Add optional flow inspection

If a workspace flow HTTP surface is running, point the bridge at it:

```bash
export CODEX_FLOW_BACKEND_URL="http://127.0.0.1:3586"
```

This enables read-only `codex_workspace.list_flow_runs` and
`codex_workspace.list_flow_events`. Embedded workspace backends can also call a
local flow capability directly without HTTP.
