---
title: Capability Kit Setup
description: Create and install a kit of repo-local skills, plugins, and workflows.
---

# Capability Kit Setup

A capability kit is a portable source tree that can copy selected skills,
plugins, and workflows into a workbench. Use kits when the destination repo
should own checked-in local files instead of only depending on a Codex plugin
marketplace install.

## 1. Create a Kit Source

Example layout:

```text
capability-kit/
  codex-kit.toml
  skills/
    review/
      SKILL.md
  plugins/
    repo-policy/
      .codex-plugin/
        plugin.json
  workflows/
    release-check/
      workflow.json
      check.ts
```

`codex-kit.toml` gives the kit explicit metadata:

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

## 2. Inspect Before Installing

From the destination workbench:

```bash
codex-toys kit inspect ./capability-kit --json
codex-toys kit add ./capability-kit
```

`kit add` is a dry run by default. Review the planned destination paths before
applying changes.

Install selected items:

```bash
codex-toys kit add ./capability-kit --include review --include release-check --apply
```

Install everything:

```bash
codex-toys kit add ./capability-kit --apply
```

If an installed destination changed, overwrite must be explicit:

```bash
codex-toys kit add ./capability-kit --apply --overwrite
```

Overwrite backs up replaced item directories under
`.codex/kit-backups/<timestamp>/`.

## 3. Know the Destinations

| Kind | Workbench destination |
|------|-----------------------|
| Skill | `.agents/skills/<skill>` |
| Plugin | `plugins/<plugin-name>` and `.agents/plugins/marketplace.json` |
| Workflow | `.codex/workflows/<workflow>` |

The installer writes `.codex/kit-lock.json` with selected capabilities,
destination paths, and content hashes.

## 4. Use a Setup Skill

A kit can include one reserved setup skill:

```text
skills/setup/SKILL.md
```

Run:

```bash
codex-toys kit setup ./capability-kit --wait
```

This installs the kit, then starts a Codex turn with instructions to use the
setup skill. The setup protocol belongs to the setup skill and its scripts, not
to codex-toys.

## 5. Validate the Install

```bash
codex-toys kit list --json
codex-toys kit doctor --json
codex-toys workflow list --json
```

Commit repo-owned installed files and `.codex/kit-lock.json` when the workbench
should keep the capabilities in git. Do not commit backup directories unless the
repo deliberately wants that history.

## Boundary

Kits are for checked-in local copies. Use Codex plugins for reusable guidance
that should install from a marketplace. Use package imports for runtime code
that should stay versioned as software dependencies.
