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
| `codex-flows-remote-control` | Local Codex App guidance for remote-control status, SSH remote-agent preflight, remote automation, and remote turns. |
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
workspace surfaces. Override the spool with `CODEX_FLOWS_HOOK_SPOOL_DIR`.

## Local backend setup

Plugin install does not start a long-running process. After installing
`codex-flows-local-workspace`, create either a user-level backend profile or a
repo-local env file.

For the normal always-on local backend, create a profile that points at the
user home directory and the user's Codex home, then install the user service:

```bash
codex-flows workspace backend init local --global --profile home
codex-flows workspace backend status --profile home
codex-flows workspace backend service install --profile home
```

For a project-local foreground backend, keep using the repo-local env flow:

```bash
codex-flows workspace backend init local
codex-flows workspace backend status
codex-flows workspace backend start
```

`workspace backend init local` writes `.codex/workspace/backend.local.env`,
creates `.codex/workspace/local/hook-spool`, and ignores local runtime state.
With `--global`, it writes
`$XDG_CONFIG_HOME/codex-flows/backends/<name>.toml` instead and leaves the repo
unchanged.
`workspace doctor` reports backend reachability, Node version, plugin hook
discovery, hook spool state, and a suggested next command.

## Remote backend from a local Codex App

For a Windows Codex App controlling a VPS over Tailscale, install the hookless
`codex-flows-remote-control` plugin locally. It does not start a local backend
or install local hooks. Instead, it guides Codex to probe the local app-server
remote-control surface and use the SSH remote-agent provider for remote
workspace commands:

```bash
codex-flows remote status
codex-flows --ssh <user@tailscale-host> --cwd /repo remote preflight
codex-flows --ssh <user@tailscale-host> --cwd /repo remote turn start --via workspace --prompt "Check workspace status" --wait
```

The local command starts `codex-flows remote-agent serve` on the VPS over SSH.
The agent starts Codex app-server on the remote host and speaks workspace
JSON-RPC over the SSH stdio stream. You do not pre-run a backend or open a
tunnel.

For one-shot automation, prefer the global SSH provider:

```bash
codex-flows --ssh <user@tailscale-host> --cwd /repo automation list --json
codex-flows --ssh <user@tailscale-host> --cwd /repo automation run check-release --event event.json
codex-flows --ssh <user@tailscale-host> --cwd /repo turn run "Check workspace status" --wait --sandbox danger-full-access --approval-policy never
```

Those commands run automation discovery, event loading, and script execution on
the remote host through the SSH remote-agent. In SSH mode `--event` is a remote
path, relative to `--cwd` unless it is absolute. Automation scripts can start
remote Codex turns and wait for them before returning their JSON result.

The SSH provider starts commands through a non-interactive shell, so the VPS
may not inherit login-shell PATH setup. Set `CODEX_FLOWS_REMOTE_PATH_PREPEND`
for remote Node, Bun, Cargo, and local bin directories, or set absolute
`CODEX_FLOWS_REMOTE_AGENT_COMMAND` and `CODEX_FLOWS_REMOTE_CODEX_COMMAND`
values. If Codex needs flags, use `CODEX_FLOWS_REMOTE_CODEX_ARGS` as a JSON
string array rather than wrapper scripts. The local machine needs
`codex-flows`; the remote target needs `node`, `codex-flows`, and `codex`.

## What the plugin does not install

The plugin installs guidance skills and bundled hook definitions. It does not
install npm packages, register persistent automations by itself, or start a
workspace backend process.

Use npm for runtime libraries and CLIs:

```bash
npm install @peezy.tech/codex-flows
```
