---
title: Install the Codex plugin
description: Install codex-flows skills and hooks from a Git-backed Codex plugin marketplace.
---

# Install the Codex plugin

The preferred way to install codex-flows agent guidance and passive lifecycle
hooks is the Codex plugin marketplace flow. The repository root is a plugin
marketplace:

```text
.codex-plugin/plugin.json
.agents/plugins/marketplace.json
skills/
hooks/hooks.json
hooks/hook-event.mjs
```

Installing the plugin gives Codex the flow authoring, backend operation, and
delegation skills without copying flow packages into a workspace. It also gives
Codex a plugin-bundled hook config that records lifecycle events for workspace
surfaces.

## Install from GitHub

In Codex App, open Plugins, choose Add marketplace, enter
`peezy-tech/codex-flows` or `https://github.com/peezy-tech/codex-flows`, then
install `codex-flows` from the `codex-flows` marketplace. Start a new thread so
the plugin skills and hooks are loaded.

The same install can be done from a Codex CLI that shares the same `CODEX_HOME`:

```bash
codex plugin marketplace add peezy-tech/codex-flows --ref main
codex plugin add codex-flows@codex-flows
```

## Local development

Before publishing or while iterating locally, add the checkout root instead:

```bash
codex plugin marketplace add /home/peezy/meta-workspace/codex-flows
codex plugin add codex-flows@codex-flows
```

After changing plugin metadata or skills, reinstall the plugin and start a new
thread to pick up the updated skill and hook list.

## Hook surface

The plugin uses Codex's native plugin hook discovery. The hook config stays
inside the plugin at `hooks/hooks.json`; it is not copied into `~/.codex/hooks.json`.

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

## What the plugin does not install

The plugin installs guidance skills and bundled hook definitions. It does not
install npm packages, copy `flows/*` into `.codex/flows`, or start a workspace
backend process.

Use npm for runtime libraries and CLIs:

```bash
npm install @peezy.tech/codex-flows
```

Use `.codex/flows/*` only when a workspace intentionally pins an operational
copy of a flow bundle.
