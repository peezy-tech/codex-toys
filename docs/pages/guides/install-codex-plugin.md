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

Installing a plugin gives Codex the requested guidance without copying runtime
packages into a workspace. Plugin-installed scripts can be used as turn
automations through the `codex-flows automation run` CLI, so products can run
code first and then conditionally start a native Codex prompt. The local
workspace plugin also gives Codex a plugin-bundled hook config that records
lifecycle events for workspace surfaces.

| Plugin | Installs |
|--------|----------|
| `codex-flows-author` | Turn automation authoring guidance. |
| `codex-flows-local-workspace` | Local backend setup and plugin-bundled hooks. |
| `codex-flows-remote-control` | Local Codex App guidance for remote-control status, SSH/Tailscale tunnels, and starting turns on a remote backend. |
| `codex-flows` | Product-local full install for development and compatibility. |

## Install from GitHub

In Codex App, open Plugins, choose Add marketplace, enter
`peezy-tech/skills` or `https://github.com/peezy-tech/skills`, then
install the plugin you need from the `peezy-tech` marketplace. Start a new
thread so the plugin skills and hooks are loaded.

The same install can be done from a Codex CLI that shares the same `CODEX_HOME`:

```bash
codex plugin marketplace add peezy-tech/skills --ref main
codex plugin add codex-flows-author@peezy-tech
codex plugin add codex-flows-remote-control@peezy-tech
codex plugin add codex-flows-local-workspace@peezy-tech
```

## Local development

Before publishing or while iterating locally, add the checkout root instead:

```bash
codex plugin marketplace add /home/peezy/meta-workspace/codex-flows
codex plugin add codex-flows@codex-flows
codex plugin add codex-flows-local-workspace@codex-flows
```

After changing plugin metadata or skills, reinstall the plugin and start a new
thread to pick up the updated skill and hook list.

## Hook surface

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

Recent workspace fork builds enable `plugin_hooks` by default, but keeping it in
config makes the dependency explicit. After install, start a new thread or
restart the Codex runtime that backs the workspace, then trust the discovered
plugin hooks when Codex asks for review.

The bundled hook command is:

```bash
node "${PLUGIN_ROOT}/hooks/hook-event.mjs"
```

Codex expands `${PLUGIN_ROOT}` from the installed plugin bundle. The command is
self-contained and writes lifecycle events into the hook spool used by
workspace surfaces. Override the spool with `CODEX_FLOWS_HOOK_SPOOL_DIR`, or
with `CODEX_DISCORD_HOOK_SPOOL_DIR` for the existing Discord bridge and voice
gateway consumers.

## Local backend setup

Plugin install does not start a long-running process. After installing
`codex-flows-local-workspace`, let Codex or the CLI create the local backend
defaults and start the foreground process explicitly:

```bash
codex-flows workspace backend init local
codex-flows workspace backend status
codex-flows workspace backend start
```

`workspace backend init local` writes `.codex/workspace/backend.local.env`,
creates `.codex/workspace/local/hook-spool`, and ignores local runtime state.
`workspace doctor` reports backend reachability, Node version, plugin hook
discovery, hook spool state, and a suggested next command.

## Remote backend from a local Codex App

For a Windows Codex App controlling a VPS over Tailscale, install the hookless
`codex-flows-remote-control` plugin locally. It does not start a local backend
or install local hooks. Instead, it guides Codex to probe the local app-server
remote-control surface, open an SSH tunnel to the remote workspace backend, and
start a turn through that backend:

```bash
codex-flows remote status
codex-flows remote tunnel start --ssh <user@tailscale-host> --dry-run
codex-flows remote turn start --via workspace --prompt "Check workspace status"
```

On the VPS, run the backend from the target workspace with
`codex-flows workspace backend start`. The SSH tunnel can forward local
`ws://127.0.0.1:3586` to the remote backend's `127.0.0.1:3586`.

For one-shot automation, prefer the global SSH provider:

```bash
codex-flows --ssh <user@tailscale-host> --cwd /repo automation run check-release --event event.json
```

That command runs the automation script locally, then starts the resulting
native Codex turn against the remote workspace if the script returns
`{"action":"turn"}`.

## What the plugin does not install

The plugin installs guidance skills and bundled hook definitions. It does not
install npm packages, register persistent automations by itself, or start a
workspace backend process.

Use npm for runtime libraries and CLIs:

```bash
npm install @peezy.tech/codex-flows
```
