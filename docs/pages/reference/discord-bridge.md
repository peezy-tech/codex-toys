---
title: Discord bridge
description: Long-lived Discord sidecar for Codex app-server threads, workspace mode, and flow inspection.
---

# Discord bridge

`codex-discord-bridge` is a private workspace app that exposes Discord as a
transport over a Codex workspace backend. It is a user interface and operator
sidecar, not part of the generic flow runtime.

Use it when a team wants to:

- start or resume Codex work from Discord
- keep one workspace home channel as the operator surface
- delegate work into separate Codex threads
- expose selected Codex thread state through Discord commands
- inspect workspace flow backend events and runs

## Run it

The bridge can connect to an existing app-server WebSocket or start a local
stdio app-server:

```bash
bun ./apps/discord-bridge/src/index.ts \
  --app-server-url ws://127.0.0.1:3585 \
  --approval-policy never \
  --sandbox danger-full-access \
  --progress-mode commentary
```

```bash
bun ./apps/discord-bridge/src/index.ts --local-app-server
```

Required configuration:

| Variable | Purpose |
|----------|---------|
| `CODEX_DISCORD_BOT_TOKEN` | Discord bot token. |
| `CODEX_DISCORD_ALLOWED_USER_IDS` | Comma-separated Discord user allowlist. |

Common optional configuration:

| Variable | Purpose |
|----------|---------|
| `CODEX_DISCORD_ALLOWED_CHANNEL_IDS` | Parent channels where the bridge may respond. |
| `CODEX_DISCORD_DIR` | Root directory for Codex thread workspaces. |
| `CODEX_DISCORD_HOME_CHANNEL_ID` | Enables workspace mode for a Discord home channel. |
| `CODEX_DISCORD_MAIN_THREAD_ID` | Existing Codex operator thread to resume for workspace mode. |
| `CODEX_DISCORD_WORKSPACE_FORUM_CHANNEL_ID` | Optional workbench forum channel. |
| `CODEX_DISCORD_TASK_THREADS_CHANNEL_ID` | Optional workbench task-thread channel. |
| `CODEX_FLOW_BACKEND_URL` | Optional workspace flow HTTP surface for run/event inspection. |
| `CODEX_DISCORD_HOOK_SPOOL_DIR` | Directory for Codex hook lifecycle events. |

## Workspace Mode

Workspace mode keeps one Discord home channel as the compact operator surface and
one Codex main thread as the model-visible operator memory. Normal messages in
the home channel go to that main thread. The main thread receives privileged
`codex_workspace` tools that can start, resume, read, and message delegated Codex
sessions.

The workspace tools can also list flow events and runs when
`CODEX_FLOW_BACKEND_URL` points at a compatible workspace flow HTTP surface.

## Backend contract

The Discord process has two sides:

- the Discord transport starts the bot, receives commands and messages, maps
  Discord channels and threads, registers slash commands, and sends Discord
  output
- the workspace backend handles inbound events, owns Codex app-server lifecycle,
  starts and resumes Codex threads, manages goals, delegations, workbench state,
  persisted bridge state, and hook-spool wake behavior

The built-in backend is local. It preserves the current behavior while giving
the bridge an explicit `CodexWorkspaceBackend` contract that another backend can
implement later. The local backend only receives the outbound Discord
presentation surface; transport startup, shutdown, inbound dispatch, and command
registration stay in the Discord wrapper.

## Workbench channels

When both workbench channels are configured, the bridge keeps Discord workspace
posts and task threads beside the home channel:

- workspace forum posts summarize known Codex threads for a workspace
- `/threads` opens a private picker for active or recent Codex threads
- selected threads open or reuse a Discord task thread
- `/goals` can inspect or update thread goals from workspace or task threads

Both workbench channels must be configured together. Setting only one is
invalid.

## Multi-surface routing

Single-surface `.env` configuration is the default. For multi-guild routing,
put one surface entry in a workspace-owned `.codex/workspace.toml`:

```toml
[[discord.workspace.surfaces]]
key = "crypto"
home_channel_id = "1503107617512919220"
workspace_forum_channel_id = "1503107617512919221"
task_threads_channel_id = "1503107617512919222"
```

Each surface owns its home channel, workspace forum channel, and task-thread
channel. Workspace files do not list workspace paths; the file's containing
workspace is the route.

## Codex hooks

Install Codex hooks once for the runtime backing the workspace backend:

```bash
codex-discord-bridge hook install
```

For package-on-demand installs:

```bash
codex-discord-bridge hook install --bunx
codex-discord-bridge hook install --bunx-package @peezy.tech/codex-flows
```

The hook command is intentionally dumb. It writes lifecycle-event files to the
spool directory and lets Codex continue. The running bridge drains those files
to update observed thread state, return delegated results, and wake the main
operator thread when configured.

## Boundary

The Discord bridge may present flow backend events and runs, but it does not
own the generic flow ABI. The workspace backend can read from
`@peezy.tech/flow-runtime` backend clients or the built-in workspace flow
capability for inspection, but flow packages still communicate through
`FlowEvent`, `flow.toml`, and `FLOW_RESULT`; app-specific completion still
belongs in the app that dispatched or consumed the event.
