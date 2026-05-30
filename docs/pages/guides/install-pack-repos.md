---
title: Install pack repos
description: Copy repo-local skills, plugins, and automations from capability pack repositories.
---

# Install pack repos

Prefer Codex plugins for reusable skills and toybox guidance. Plugins install
cleanly from GitHub-backed marketplaces and do not require codex-toys to own a
parallel distribution model.

Pack repos are the lower-level file-copy path for workspaces that intentionally
want repo-local copies, such as skills under `.agents/skills`, local plugins
under `plugins`, or automation templates under `.codex/automations`.

A workspace repo is the operational target. `codex-toys pack add` installs
selected capabilities into that repo's Codex-native locations. V1 is repo-local
only and does not mutate `~/.codex` or user-global plugin installs.

## Source layout

Pack repos work without a manifest by scanning conventional folders:

```text
skills/**/<skill>/SKILL.md
plugins/**/.codex-plugin/plugin.json
automations/<automation>/automation.json
```

Only add `codex-pack.toml` when the repo needs display metadata or explicit
item names and paths:

```toml
[pack]
name = "engineering-capabilities"
version = "0.1.0"
description = "Reusable engineering skills, plugins, and automations."

[[pack.items]]
name = "tdd"
kind = "skill"
path = "skills/engineering/tdd"

[[pack.items]]
name = "repo-policy"
kind = "plugin"
path = "plugins/repo-policy"

[[pack.items]]
name = "release-candidate"
kind = "automation"
path = "automations/release-candidate"
```

## Inspect and install

Inspect a local directory, GitHub shorthand, or Git URL:

```bash
codex-toys pack inspect ./engineering-capabilities
codex-toys pack inspect mattpocock/skills --json
codex-toys pack inspect https://github.com/example/capabilities.git --ref main
```

Install is dry-run by default:

```bash
codex-toys pack add ./engineering-capabilities
codex-toys pack add owner/repo --include tdd --exclude repo-policy
```

Apply only after reviewing the plan:

```bash
codex-toys pack add ./engineering-capabilities --apply
```

Changed destinations are conflicts unless overwrite is explicit:

```bash
codex-toys pack add ./engineering-capabilities --apply --overwrite
```

Overwrite backs up replaced item directories under `.codex/pack-backups/<timestamp>/`.

## Destinations

| Kind | Source | Workspace destination |
|------|--------|-----------------------|
| Skill | `skills/**/<skill>/SKILL.md` | `.agents/skills/<skill>` |
| Plugin | `plugins/**/.codex-plugin/plugin.json` | `plugins/<plugin-name>` and `.agents/plugins/marketplace.json` |
| Automation | `automations/**/automation.json` | `.codex/automations/<automation>` |

The installer writes `.codex/pack-lock.json` with source, ref or commit when
known, selected capabilities, destination paths, and content hashes.

## Plugins

Plugin entries are local marketplace entries pointing at
`./plugins/<plugin-name>`. Existing marketplace entries are preserved unless
they point at the same installed local plugin path. If another marketplace entry
already uses the same plugin name, install reports a conflict unless `--overwrite`
is set.

## Automations

Automation packs are templates for codex-toys workspaces. Their bundle
directory is copied under `.codex/automations/<automation>`, and execution stays
with codex-toys commands, workspace policy, or forge runners. The pack
installer does not schedule, retry, replay, or run automations while installing
them.

## Inspect installed packs

```bash
codex-toys pack list
codex-toys pack doctor
codex-toys pack doctor --json
```

`pack list` reads `.codex/pack-lock.json`. `pack doctor` validates the lock,
destination paths and content hashes, and `.agents/plugins/marketplace.json`.
