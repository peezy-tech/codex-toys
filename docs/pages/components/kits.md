---
title: Kits
description: Repo-local copies of skills, plugins, and workflow templates.
---

# Kits

Kits copy selected capabilities into a workbench. Prefer Codex plugins for
reusable guidance that should install from a marketplace. Use kits when a repo
intentionally wants local files, such as a checked-in skill or workflow template.

## Source Layout

Kits can be discovered from conventional folders:

```text
skills/**/<skill>/SKILL.md
plugins/**/.codex-plugin/plugin.json
workflows/<workflow>/workflow.json
```

Add `codex-kit.toml` when a kit needs display metadata or explicit item names:

```toml
[kit]
name = "engineering-capabilities"
version = "0.1.0"
description = "Reusable engineering skills, plugins, and workflows."

[[kit.items]]
name = "review"
kind = "skill"
path = "skills/review"

[[kit.items]]
name = "repo-policy"
kind = "plugin"
path = "plugins/repo-policy"

[[kit.items]]
name = "release-check"
kind = "workflow"
path = "workflows/release-check"
```

## Inspect And Install

```bash
codex-toys kit inspect ./capability-kit
codex-toys kit inspect owner/repo --json
codex-toys kit inspect https://github.com/example/capability-kit.git --ref main
```

Install is dry-run by default:

```bash
codex-toys kit add ./capability-kit
codex-toys kit add owner/repo --include review --exclude repo-policy
```

Apply only after reviewing the plan:

```bash
codex-toys kit add ./capability-kit --apply
```

Changed destinations are conflicts unless overwrite is explicit:

```bash
codex-toys kit add ./capability-kit --apply --overwrite
```

Overwrite backs up replaced item directories under
`.codex/kit-backups/<timestamp>/`.

## Destinations

| Kind | Source | Workbench destination |
|------|--------|-----------------------|
| Skill | `skills/**/<skill>/SKILL.md` | `.agents/skills/<skill>` |
| Plugin | `plugins/**/.codex-plugin/plugin.json` | `plugins/<plugin-name>` and `.agents/plugins/marketplace.json` |
| Workflow | `workflows/**/workflow.json` | `.codex/workflows/<workflow>` |

The installer writes `.codex/kit-lock.json` with source, selected capabilities,
destination paths, and content hashes.

## Setup Skill

A kit may include one reserved setup skill at `skills/setup/SKILL.md`. It is
installed as `.agents/skills/setup`. Its presence means the workbench still
needs initialization.

`codex-toys kit setup <source>` installs the full kit, then starts a Codex turn
with instructions to use `.agents/skills/setup`.

```bash
codex-toys kit setup ./capability-kit --wait
```

The setup protocol belongs to the setup skill and its shipped scripts, not to
codex-toys.

## Doctor

```bash
codex-toys kit list --json
codex-toys kit doctor --json
```

`kit doctor` validates the lock file, installed destination paths, content
hashes, and local plugin marketplace entries.
