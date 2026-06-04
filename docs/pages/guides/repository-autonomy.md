---
title: Repository Autonomy
description: Set up a workbench repo to run Codex work on a GitHub Actions schedule.
---

# Repository Autonomy

Repository autonomy means the repo carries enough Codex workbench state to run
scheduled work without a human opening Codex locally. The GitHub Actions runner
uses Actions mode, so the runtime Codex home is the repo-local `.codex`
directory instead of the operator's global Codex home.

Use this guide when a repository should poll feeds, enqueue or run scheduled
workbench tasks, execute workflows, and commit durable Codex state back to the
same repo.

## 1. Scaffold Actions Mode

From the repo root:

```bash
codex-toys workbench init actions --github
```

The scaffold writes:

```text
.codex/workbench.toml
.codex/config.toml
.github/workflows/codex-toys-actions.yml
.gitignore
```

The generated GitHub Actions workflow runs hourly by default and can also be
started manually with `workflow_dispatch`.

## 2. Add Workbench Tasks

Define scheduled tasks in `.codex/workbench.toml`:

```toml
[workbench]
name = "example"

[[workbench.tasks]]
id = "daily-review"
enabled = true
kind = "workflow"
workflow = "daily-review"
schedule = "0 14 * * *"

[[workbench.tasks]]
id = "dependency-check"
enabled = true
kind = "command"
command = ["npm", "outdated", "--json"]
schedule = "0 9 * * 1"
```

Task schedules use five-field cron syntax in UTC. `workbench tick --mode actions`
creates due scheduled intents, runs due deferred work, evaluates reactive rules,
and records state under `.codex/workbench/actions`.

Use `kind = "workflow"` when the task should run a workflow primitive from
`.codex/workflows/*` or `workflows/*`. Use `kind = "skill"` when the repo has a
repo-local skill under `.codex/skills/<skill>/SKILL.md`. Use `kind = "command"`
for explicit shell commands.

## 3. Provide Codex Auth

The generated workflow runs:

```bash
vp dlx codex-toys actions prepare-auth
```

`prepare-auth` writes `.codex/auth.json` from the first available secret:

```text
CODEX_AUTH_JSON_B64
CODEX_AUTH_JSON
OPENAI_API_KEY
```

Prefer `CODEX_AUTH_JSON_B64` when copying an existing Codex auth file into a
GitHub secret. `CODEX_AUTH_JSON` accepts raw JSON. `OPENAI_API_KEY` writes an
API-key auth file.

Do not commit `.codex/auth.json`. The scaffold adds runtime-only Codex auth and
cache paths to `.gitignore`, and the generated workflow runs cleanup after each
tick.

## 4. Commit Durable State

Commit the scaffold and any repo-owned tasks, workflows, skills, memories, and
feed config:

```bash
git add .codex/workbench.toml .codex/config.toml .github/workflows/codex-toys-actions.yml .gitignore
git commit -m "Set up Codex workbench schedule"
```

The generated runner commits durable Actions-mode state after each run when
there are changes:

```text
.codex/memories/
.codex/feed/actions/
.codex/workbench/actions/
.codex/sessions/
```

Raw session files can include prompts, model output, tool calls, command output,
file paths, and other sensitive text. Keep `.codex/sessions` committed only for
repos where that history belongs in git.

## 5. Verify a Run

Run the same mode locally before relying on the schedule:

```bash
codex-toys workbench doctor --mode actions --json
codex-toys workbench tick --mode actions
codex-toys workbench deferred list --mode actions --json
```

Then trigger the GitHub Actions workflow manually or wait for the schedule. A
healthy run should prepare auth, run
`vp dlx codex-toys workbench tick --mode actions`, clean runtime-only files, and
push durable state if anything changed.

## Repository-Owned Decisions

The scaffold provides a runner, not product policy. The repo still owns:

- which tasks are enabled
- workflow scripts and prompt policy
- feed sources and dispatch rules
- whether `.codex/sessions` should be committed
- branch protection and workflow write permissions
- review policy for commits produced by the runner
