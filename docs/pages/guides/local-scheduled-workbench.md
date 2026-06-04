---
title: Local Scheduled Workbench
description: Run a workbench schedule on the local machine with systemd user timers.
---

# Local Scheduled Workbench

A local scheduled workbench runs `workbench tick --mode local` from the user's
machine. It uses the active local Codex home for turns and writes local
workbench state under the repository `.codex` directory.

Use this guide when scheduled work should run on a trusted local host instead of
GitHub Actions.

## 1. Configure Workbench Tasks

Create `.codex/workbench.toml`:

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
id = "hourly-status"
enabled = true
kind = "command"
command = ["node", "--version"]
schedule = "0 * * * *"
```

Schedules use five-field cron syntax in UTC. `workbench tick` creates due
scheduled intents, runs due deferred work, and evaluates reactive rules.

## 2. Test the Tick Manually

From the workbench root:

```bash
codex-toys workbench doctor --mode local --json
codex-toys workbench tick --mode local
codex-toys workbench deferred list --mode local --json
```

Local mode writes generated state such as:

```text
.codex/workbench/local/
.codex/feed/local/
```

Local mode uses the active user/global Codex home for Codex auth, skills, and
memory. It does not switch to the repo-local `.codex` home the way Actions mode
does.

## 3. Install a User Timer

Create `~/.config/systemd/user/codex-toys-example.service`:

```ini
[Unit]
Description=Run codex-toys workbench tick for example

[Service]
Type=oneshot
WorkingDirectory=/path/to/repo
ExecStart=/usr/bin/env codex-toys workbench tick --mode local --workbench-root /path/to/repo
```

Create `~/.config/systemd/user/codex-toys-example.timer`:

```ini
[Unit]
Description=Schedule codex-toys workbench tick for example

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

Enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now codex-toys-example.timer
systemctl --user list-timers codex-toys-example.timer
```

If the machine uses a shell-managed Node install, put the absolute Codex and
codex-toys paths in `ExecStart` or set PATH with an `Environment=` line.

## 4. Verify Runner Visibility

Run:

```bash
codex-toys workbench doctor --mode local --json
```

`doctor` can report whether it sees a matching local systemd user timer for the
current workbench root. If no runner is visible, due scheduled work still needs
a manual tick or another scheduler.

## 5. Keep Local State Local

Do not commit local runtime state by default:

```text
.codex/workbench/local/
.codex/feed/local/
```

Commit repo-owned config, workflows, skills, and functions. Leave host-owned
state, local sessions, command output, and local queue attempts out of git
unless the repository deliberately treats that history as source data.
