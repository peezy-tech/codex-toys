---
title: Install the Codex plugin
description: Install codex-flows skills and hooks from a Git-backed Codex plugin marketplace.
---

# Install the Codex plugin

The preferred way to install codex-flows agent guidance and passive lifecycle
hooks is the shared Peezy Tech Codex plugin marketplace. Source definitions
live in this repository; release syncs installable plugin bundles into
`peezy-tech/skills`.

The repository root also remains a product-local plugin marketplace for
development, with a full plugin plus granular install options:

```text
.codex-plugin/plugin.json
.agents/plugins/marketplace.json
plugins/codex-flows-author/
plugins/codex-flows-local-workspace/
plugins/codex-flows-remote-control/
skills/
hooks/hooks.json
hooks/hook-event.mjs
```

| Plugin | Installs |
|--------|----------|
| `codex-flows-author` | Turn automation authoring guidance. |
| `codex-flows-local-workspace` | Local agent operation guidance and plugin-bundled hooks. |
| `codex-flows-remote-control` | Local Codex App guidance for SSH agent preflight, remote automation, turns in remote workspaces, and proxy dashboards. |
| `codex-flows` | Product-local full install for development and compatibility. |

## Install from GitHub

In Codex App, open Plugins, choose Add marketplace, enter
`peezy-tech/skills` or `https://github.com/peezy-tech/skills`, then install the
plugin you need from the `peezy-tech` marketplace. Start a new thread so the
plugin skills and hooks are loaded.

The same install can be done from a Codex CLI that shares the same `CODEX_HOME`:

```bash
codex plugin marketplace add peezy-tech/skills --ref main
codex plugin add codex-flows-author@peezy-tech
codex plugin add codex-flows-remote-control@peezy-tech
codex plugin add codex-flows-local-workspace@peezy-tech
codex plugin add codex-flows@codex-flows
```

## Local Development

Before publishing or while iterating locally, add the checkout root instead:

```bash
codex plugin marketplace add /home/peezy/repos/codex-flows
codex plugin add codex-flows@codex-flows
codex plugin add codex-flows-local-workspace@codex-flows
```

After changing plugin metadata or skills, reinstall the plugin and start a new
thread to pick up the updated skill and hook list.

## Hook Surface

The local workspace and full plugins use Codex's native plugin hook discovery.
The hook config stays inside the plugin at `hooks/hooks.json`; it is not copied
into `~/.codex/hooks.json`.

Make sure plugin hooks are enabled in the Codex home that runs the workspace:

```toml
[features]
plugins = true
hooks = true
plugin_hooks = true
```

The bundled hook command is:

```bash
node "${PLUGIN_ROOT}/hooks/hook-event.mjs"
```

Codex expands `${PLUGIN_ROOT}` from the installed plugin bundle. The command is
self-contained and writes lifecycle events into the hook spool used by
workspace surfaces. Override the spool with `CODEX_FLOWS_HOOK_SPOOL_DIR`.

## Local Agent

Plugin install does not start a long-running process. Normal CLI and MCP calls
spawn the agent as needed:

```bash
codex-flows fetch
codex-flows workspace doctor
codex-flows workspace methods
codex-flows functions list --json
codex-flows automation list --json
codex-flows turn run "Check workspace status" --wait
```

Start the agent explicitly only when another process needs stdio JSON-RPC:

```bash
codex-flows agent serve --cwd /repo
```

## SSH Agent

For remote workspaces, keep the command local and run the agent over SSH stdio:

```bash
codex-flows --ssh <user@tailscale-host> --cwd /repo remote preflight
codex-flows --ssh <user@tailscale-host> --cwd /repo fetch
codex-flows --ssh <user@tailscale-host> --cwd /repo turn run "Check workspace status" --wait
codex-flows --ssh <user@tailscale-host> --cwd /repo automation run check-release --event event.json
```

Useful remote defaults:

```bash
CODEX_FLOWS_REMOTE_SSH_TARGET=<user@tailscale-host>
CODEX_FLOWS_REMOTE_CWD=/repo
CODEX_FLOWS_REMOTE_PATH_PREPEND=/home/user/.local/bin:/home/user/.bun/bin
CODEX_FLOWS_AGENT_COMMAND=codex-flows
CODEX_FLOWS_REMOTE_CODEX_COMMAND=codex
```

## Dashboard Proxy

For browser dashboards, opt into HTTP explicitly:

```bash
codex-flows-proxy serve --cwd /repo --static ./dashboard
codex-flows-proxy serve --ssh <user@tailscale-host> --cwd /repo --static ./dashboard
```

Plain HTML/JS can call:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/app/:method
POST /api/workspace/:method
```

The proxy schema is derived from the agent's available workspace methods.
