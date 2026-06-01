---
title: Install the Codex plugin
description: Install codex-toys skills from a Git-backed Codex plugin marketplace.
---

# Install the Codex plugin

The preferred way to install codex-toys toybox guidance is the shared Peezy
Tech Codex plugin marketplace. Source definitions live in this repository;
release syncs installable plugin bundles into `peezy-tech/skills`.

The repository root also remains a product-local plugin marketplace for
development. It exposes the same granular install choices as the shared
marketplace, plus a full plugin for compatibility and whole-product testing:

```text
.codex-plugin/plugin.json
.agents/plugins/marketplace.json
plugins/codex-toys-author/
plugins/codex-toys-local-workbench/
plugins/codex-toys-remote-control/
skills/
```

| Plugin | Installs |
|--------|----------|
| `codex-toys-author` | Turn automation authoring guidance. |
| `codex-toys-local-workbench` | Local toybox operation guidance. |
| `codex-toys-remote-control` | Local Codex App guidance for SSH toybox preflight, remote automation, turns in remote workbenches, and proxy dashboards. |
| `codex-toys` | Product-local full install for development and compatibility. |

## Install from GitHub

In Codex App, open Plugins, choose Add marketplace, enter
`peezy-tech/skills` or `https://github.com/peezy-tech/skills`, then install the
plugin you need from the `peezy-tech` marketplace. Start a new thread so the
plugin skills are loaded.

The same install can be done from a Codex CLI that shares the same `CODEX_HOME`:

```bash
codex plugin marketplace add peezy-tech/skills --ref main
codex plugin add codex-toys-author@peezy-tech
codex plugin add codex-toys-remote-control@peezy-tech
codex plugin add codex-toys-local-workbench@peezy-tech
```

## Local Development

Before publishing or while iterating locally, add the checkout root instead:

```bash
codex plugin marketplace add /home/peezy/repos/codex-toys
codex plugin add codex-toys-local-workbench@codex-toys
```

Install, upgrade, or uninstall the specific local plugin you need just as you
would from the shared marketplace. After changing marketplace metadata, plugin
manifests, or skills in this checkout, reinstall or upgrade the affected plugin
and start a new thread to pick up the updated skill list. Use the full
`codex-toys@codex-toys` plugin only when you intentionally need the compatibility
surface or all product-local skills at once.

```bash
codex plugin add codex-toys@codex-toys
```

## Local Agent

Plugin install does not start a long-running process. Normal CLI and MCP calls
spawn the toybox as needed:

```bash
codex-toys fetch
codex-toys workbench doctor
codex-toys workbench methods
codex-toys functions list --json
codex-toys automation list --json
codex-toys turn run "Check workbench status" --wait
```

Start the toybox explicitly only when another process needs stdio JSON-RPC:

```bash
codex-toys toybox serve --cwd /repo
```

## SSH Agent

For remote workbenches, keep the command local and run the toybox over SSH stdio:

```bash
codex-toys --ssh <user@tailscale-host> --cwd /repo remote preflight
codex-toys --ssh <user@tailscale-host> --cwd /repo fetch
codex-toys --ssh <user@tailscale-host> --cwd /repo turn run "Check workbench status" --wait
codex-toys --ssh <user@tailscale-host> --cwd /repo automation run check-release --event event.json
```

Useful remote defaults:

```bash
CODEX_TOYS_REMOTE_SSH_TARGET=<user@tailscale-host>
CODEX_TOYS_REMOTE_CWD=/repo
CODEX_TOYS_REMOTE_PATH_PREPEND=/home/user/.local/bin:/home/user/.bun/bin
CODEX_TOYS_TOYBOX_COMMAND=codex-toys
CODEX_TOYS_REMOTE_CODEX_COMMAND=codex
```

## Dashboard Proxy

For browser dashboards, opt into HTTP explicitly:

```bash
codex-toys-proxy serve --cwd /repo --static ./dashboard
codex-toys-proxy serve --ssh <user@tailscale-host> --cwd /repo --static ./dashboard
```

Plain HTML/JS can call:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/app/:method
POST /api/workbench/:method
```

The proxy schema is derived from the toybox's available workbench methods.
