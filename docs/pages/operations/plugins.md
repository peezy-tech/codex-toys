---
title: Plugins
description: Install codex-toys Codex-facing guidance from a Git-backed marketplace.
---

# Plugins

The npm package installs the CLI and runtime APIs. Codex plugins install
Codex-facing guidance such as workflow authoring, local toybox operation, and
remote workbench operation.

## Shared Marketplace

```bash
codex plugin marketplace add peezy-tech/skills --ref main
codex plugin add codex-toys-author@peezy-tech
codex plugin add codex-toys-local-workbench@peezy-tech
codex plugin add codex-toys-remote-control@peezy-tech
```

Start a new Codex thread after installing or upgrading plugins so the skill list
is reloaded.

## Plugin Choices

| Plugin | Use it for |
|--------|------------|
| `codex-toys-author` | Writing or reviewing workflow scripts. |
| `codex-toys-local-workbench` | Operating local toyboxes and proxy dashboards. |
| `codex-toys-remote-control` | Operating SSH-backed workbenches from a local Codex App. |

The root `codex-toys` plugin is for product-local development against this repo.
Prefer the granular plugins for normal use.

## Local Development

When iterating on this checkout, add the checkout root as a local marketplace:

```bash
codex plugin marketplace add <codex-toys-checkout>
codex plugin add codex-toys-author@codex-toys
codex plugin add codex-toys-local-workbench@codex-toys
codex plugin add codex-toys-remote-control@codex-toys
```

After changing marketplace metadata, plugin manifests, or skills, reinstall or
upgrade the affected plugin and start a new thread.

## Runtime Boundary

Plugin install does not start a service. The CLI, MCP server, workflow runs,
functions, delegation, and proxy all use the normal toybox/proxy runtime paths.
