---
title: Plugins
description: Install codex-toys Codex-facing guidance from a Git-backed marketplace.
---

# Plugins

The npm package installs the CLI and runtime APIs. Codex plugins install
Codex-facing guidance such as workflow authoring, local runtime operation, and
remote workspace operation.

## Shared Marketplace

```bash
codex plugin marketplace add peezy-tech/skills --ref main
codex plugin add codex-toys-author@peezy-tech
codex plugin add codex-toys-local-workspace@peezy-tech
codex plugin add codex-toys-remote-control@peezy-tech
```

Start a new Codex thread after installing or upgrading plugins so the skill list
is reloaded.

## Plugin Choices

| Plugin | Use it for |
|--------|------------|
| `codex-toys-author` | Writing or reviewing workflow scripts. |
| `codex-toys-local-workspace` | Operating local runtimes and HTTP dashboards. |
| `codex-toys-remote-control` | Operating SSH-backed workspaces from a local Codex App. |

The root `codex-toys` plugin is for product-local development against this repo.
Prefer the granular plugins for normal use.

## Local Development

When iterating on this checkout, add the checkout root as a local marketplace:

```bash
codex plugin marketplace add <codex-toys-checkout>
codex plugin add codex-toys-author@codex-toys
codex plugin add codex-toys-local-workspace@codex-toys
codex plugin add codex-toys-remote-control@codex-toys
```

After changing marketplace metadata, plugin manifests, or skills, reinstall or
upgrade the affected plugin and start a new thread.

## Runtime Boundary

Plugin install does not start a service. The CLI, MCP server, workflow runs,
functions, and optional HTTP edge all use the normal runtime paths.
