---
title: Install pack repos
description: Copy repo-local skills, plugins, and hooks from capability pack repositories.
---

# Install pack repos

Prefer Codex plugins for reusable skills and agent guidance. Plugins install
cleanly from GitHub-backed marketplaces and do not require codex-flows to own a
parallel distribution model.

Pack repos are the lower-level file-copy path for workspaces that intentionally
want repo-local copies, such as skills under `.agents/skills`, local plugins
under `plugins`, or direct hook config under `.codex/hooks`. For codex-flows
itself, prefer the plugin install because its hooks are bundled in the plugin
and discovered by Codex without a pack copy.

A workspace repo is the operational target. `codex-flows pack add` installs
selected capabilities into that repo's Codex-native locations. V1 is repo-local
only and does not mutate `~/.codex` or user-global plugin installs.

## Source layout

Pack repos work without a manifest by scanning conventional folders:

```text
skills/**/<skill>/SKILL.md
plugins/**/.codex-plugin/plugin.json
hooks/<hook-pack>/hooks.json
```

Only add `codex-pack.toml` when the repo needs display metadata or explicit
item names and paths:

```toml
[pack]
name = "engineering-capabilities"
version = "0.1.0"
description = "Reusable engineering skills, plugins, and hooks."

[[pack.items]]
name = "tdd"
kind = "skill"
path = "skills/engineering/tdd"

[[pack.items]]
name = "repo-policy"
kind = "plugin"
path = "plugins/repo-policy"

[[pack.items]]
name = "workspace-stop-hooks"
kind = "hook"
path = "hooks/workspace-stop"
```

## Inspect and install

Inspect a local directory, GitHub shorthand, or Git URL:

```bash
codex-flows pack inspect ./engineering-capabilities
codex-flows pack inspect mattpocock/skills --json
codex-flows pack inspect https://github.com/example/capabilities.git --ref main
```

Install is dry-run by default:

```bash
codex-flows pack add ./engineering-capabilities
codex-flows pack add owner/repo --include tdd --exclude repo-policy
```

Apply only after reviewing the plan:

```bash
codex-flows pack add ./engineering-capabilities --apply
```

Changed destinations are conflicts unless overwrite is explicit:

```bash
codex-flows pack add ./engineering-capabilities --apply --overwrite
```

Overwrite backs up replaced item directories under `.codex/pack-backups/<timestamp>/`.

## Destinations

| Kind | Source | Workspace destination |
|------|--------|-----------------------|
| Skill | `skills/**/<skill>/SKILL.md` | `.agents/skills/<skill>` |
| Plugin | `plugins/**/.codex-plugin/plugin.json` | `plugins/<plugin-name>` and `.agents/plugins/marketplace.json` |
| Hook | `hooks/**/hooks.json` | `.codex/hooks/<hook-pack>` and `.codex/hooks.json` |

The installer writes `.codex/pack-lock.json` with source, ref or commit when
known, selected capabilities, destination paths, and content hashes.

## Plugins and hooks

Plugin entries are local marketplace entries pointing at
`./plugins/<plugin-name>`. Existing marketplace entries are preserved unless
they point at the same installed local plugin path. If another marketplace entry
already uses the same plugin name, install reports a conflict unless `--overwrite`
is set.

Direct hook packs are workspace policy. Their bundle directory is copied under
`.codex/hooks/<hook-pack>`, and their hook groups are merged into
`.codex/hooks.json`.

Plugin-bundled hooks remain inside the plugin. Codex discovers default plugin
hooks from `hooks/hooks.json` when `[features].plugin_hooks = true`; the pack
installer reports that requirement when it sees plugin hooks, but it does not
enable the feature automatically.

## Inspect installed packs

```bash
codex-flows pack list
codex-flows pack doctor
codex-flows pack doctor --json
```

`pack list` reads `.codex/pack-lock.json`. `pack doctor` validates the lock,
destination paths and content hashes, `.agents/plugins/marketplace.json`, and
`.codex/hooks.json`.
