---
title: Install kit repos
description: Copy repo-local skills, plugins, and automations from capability kit repositories.
---

# Install kit repos

Prefer Codex plugins for reusable skills and toybox guidance. Plugins install
cleanly from GitHub-backed marketplaces and do not require codex-toys to own a
parallel distribution model.

Kit repos are the lower-level file-copy path for workbenches that intentionally
want repo-local copies, such as skills under `.agents/skills`, local plugins
under `plugins`, or automation templates under `.codex/automations`.

A workbench repo is the operational target. `codex-toys kit add` installs
selected capabilities into that repo's Codex-facing locations. V1 is repo-local
only and does not mutate `~/.codex` or user-global plugin installs.

## Source layout

Kit repos work without a manifest by scanning conventional folders:

```text
skills/**/<skill>/SKILL.md
plugins/**/.codex-plugin/plugin.json
automations/<automation>/automation.json
```

Only add `codex-kit.toml` when the repo needs display metadata or explicit
item names and paths:

```toml
[kit]
name = "engineering-capabilities"
version = "0.1.0"
description = "Reusable engineering skills, plugins, and automations."

[[kit.items]]
name = "tdd"
kind = "skill"
path = "skills/engineering/tdd"

[[kit.items]]
name = "repo-policy"
kind = "plugin"
path = "plugins/repo-policy"

[[kit.items]]
name = "release-candidate"
kind = "automation"
path = "automations/release-candidate"
```

## Inspect and install

Inspect a local directory, GitHub shorthand, or Git URL:

```bash
codex-toys kit inspect ./engineering-capabilities
codex-toys kit inspect mattpocock/skills --json
codex-toys kit inspect https://github.com/example/capabilities.git --ref main
```

Install is dry-run by default:

```bash
codex-toys kit add ./engineering-capabilities
codex-toys kit add owner/repo --include tdd --exclude repo-policy
```

Apply only after reviewing the plan:

```bash
codex-toys kit add ./engineering-capabilities --apply
```

Changed destinations are conflicts unless overwrite is explicit:

```bash
codex-toys kit add ./engineering-capabilities --apply --overwrite
```

Overwrite backs up replaced item directories under `.codex/kit-backups/<timestamp>/`.

## Setup Skill Convention

A kit may include one reserved setup skill at `skills/setup/SKILL.md`. It is
installed as a normal workspace skill at `.agents/skills/setup`, and its
presence means the workbench is not fully initialized yet.

This convention is intentionally portable. A user can clone or copy a workbench,
open plain Codex in that directory, and Codex should see the setup skill and run
it before ordinary repository work. The setup skill should invoke shipped
scripts from its own bundle for setup, validation, retirement, and teardown. It
should not ask Codex to generate validators on the fly.

The usual lifecycle is:

```bash
node .agents/skills/setup/scripts/setup.mjs setup
node .agents/skills/setup/scripts/setup.mjs validate --json
node .agents/skills/setup/scripts/setup.mjs retire
```

After validation passes, retirement removes or renames `SKILL.md` so future
Codex turns no longer treat the workspace as pending setup. The shipped runtime
files may remain in the setup skill directory when the setup script needs them
for teardown or later validation.

`codex-toys kit setup <source>` is a convenience wrapper. It installs the full
kit, then starts a Codex turn in the target workbench with an explicit prompt to
use `.agents/skills/setup`. `codex-toys` does not own the setup protocol; the
workspace skill and its shipped scripts do.

## Destinations

| Kind | Source | Workbench destination |
|------|--------|-----------------------|
| Skill | `skills/**/<skill>/SKILL.md` | `.agents/skills/<skill>` |
| Plugin | `plugins/**/.codex-plugin/plugin.json` | `plugins/<plugin-name>` and `.agents/plugins/marketplace.json` |
| Automation | `automations/**/automation.json` | `.codex/automations/<automation>` |

The installer writes `.codex/kit-lock.json` with source, ref or commit when
known, selected capabilities, destination paths, and content hashes.

## Plugins

Plugin entries are local marketplace entries pointing at
`./plugins/<plugin-name>`. Existing marketplace entries are preserved unless
they point at the same installed local plugin path. If another marketplace entry
already uses the same plugin name, install reports a conflict unless `--overwrite`
is set.

## Automations

Automation kits are templates for codex-toys workbenches. Their bundle
directory is copied under `.codex/automations/<automation>`, and execution stays
with codex-toys commands, workbench policy, or forge runners. The kit
installer does not schedule, retry, replay, or run automations while installing
them.

## Inspect installed kits

```bash
codex-toys kit list
codex-toys kit doctor
codex-toys kit doctor --json
```

`kit list` reads `.codex/kit-lock.json`. `kit doctor` validates the lock,
destination paths and content hashes, and `.agents/plugins/marketplace.json`.
