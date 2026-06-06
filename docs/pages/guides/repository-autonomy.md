---
title: Repository Autonomy
description: Set up a workbench repo to run Codex work on a GitHub Actions schedule.
---

# Repository Autonomy

Repository autonomy means the repo carries enough Codex workbench state to run
Codex work without a human opening Codex locally. The GitHub Actions runner
uses Actions mode, so the runtime Codex home is the repo-local `.codex`
directory instead of the operator's global Codex home.

Use this guide when a repository should let GitHub Actions own recurrence,
execute explicit codex-toys commands, and commit durable Codex state back to the
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
started manually with `workflow_dispatch`. It uses the published
`ghcr.io/peezy-tech/codex-toys-actions:latest` runner image by default so each
scheduled run does not reinstall Node, VitePlus, native Codex CLI, and
codex-toys.

Use a custom image when a repository needs extra system packages or tools:

```bash
codex-toys workbench init actions --github --image ghcr.io/example/codex-runner:2026-06
```

Use `--no-image` to generate the older setup-node workflow that installs
codex-toys during each run.

## 2. Add Workbench Tasks

Define explicit tasks in `.codex/workbench.toml`:

```toml
[workbench]
name = "example"

[[workbench.tasks]]
id = "daily-review"
enabled = true
kind = "workflow"
workflow = "daily-review"
history = "full"

[[workbench.tasks]]
id = "dependency-check"
enabled = true
kind = "command"
command = ["npm", "outdated", "--json"]
history = "latest"
```

Actions `on.schedule` owns time. Workbench task config does not accept task
schedules. The generated workflow drains the durable dispatch queue with
`workbench dispatch run-due --mode actions`; add explicit workflow steps for
tasks that should run directly on that Actions schedule.

Use `kind = "workflow"` when the task should run a workflow primitive from
`.codex/workflows/*` or `workflows/*`. Use `kind = "skill"` when the repo has a
repo-local skill under `.codex/skills/<skill>/SKILL.md`. Use `kind = "command"`
for explicit shell commands.

For example, a daily Actions workflow can run a configured task directly:

```yaml
- run: codex-toys workbench run daily-review --mode actions
```

## 3. Provide Codex Auth

The generated workflow runs:

```bash
codex-toys actions prepare-auth
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
run.

## 4. Commit Durable State

Commit the scaffold and any repo-owned tasks, workflows, skills, memories, and
feed config:

```bash
git add .codex/workbench.toml .codex/config.toml .github/workflows/codex-toys-actions.yml .gitignore
git commit -m "Set up Codex workbench runner"
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
codex-toys workbench dispatch run-due --mode actions
codex-toys workbench run dependency-check --mode actions
codex-toys workbench dispatch list --mode actions --json
```

Then trigger the GitHub Actions workflow manually or wait for the schedule. A
healthy run should prepare auth, run
`codex-toys workbench dispatch run-due --mode actions`, clean runtime-only files, and
push durable state if anything changed.

## Repository-Owned Decisions

The scaffold provides a runner, not product policy. The repo still owns:

- which tasks are enabled
- workflow scripts and prompt policy
- feed sources and dispatch rules
- whether `.codex/sessions` should be committed
- branch protection and workflow write permissions
- whether to use the published runner image directly or build a custom image
  from it
- review policy for commits produced by the runner
