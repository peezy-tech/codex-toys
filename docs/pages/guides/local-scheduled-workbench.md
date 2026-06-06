---
title: Local Scheduled Workbench
description: Run explicit workbench commands on the local machine with systemd user timers.
---

# Local Scheduled Workbench

A local scheduled workbench uses systemd user timers as the clock and
codex-toys as the command target. The timer calls explicit commands such as
`workbench run <task-id>`, `workbench dispatch run-due`, or `feed dispatch`.
Local mode uses the active local Codex home for turns and writes local
workbench state under the repository `.codex` directory.

Use this guide when scheduled work should run on a trusted local host instead of
GitHub Actions.

## 1. Configure Explicit Tasks

Create `.codex/workbench.toml`:

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
id = "hourly-status"
enabled = true
kind = "command"
command = ["node", "--version"]
history = "latest"
```

`history = "latest"` is useful for polling or health checks where only the
current status matters. `history = "full"` keeps per-run status and output.
Workbench task config does not accept task schedules; systemd owns recurrence.

## 2. Test Explicit Commands

From the workbench root:

```bash
codex-toys workbench doctor --mode local --json
codex-toys workbench run daily-review --mode local
codex-toys workbench run hourly-status --mode local
codex-toys workbench dispatch run-due --mode local
codex-toys workbench dispatch list --mode local --json
```

Local mode writes generated state such as:

```text
.codex/workbench/local/
.codex/feed/local/
```

Local mode uses the active user/global Codex home for Codex auth, skills, and
memory. It does not switch to the repo-local `.codex` home the way Actions mode
does.

## 3. Install a Task Timer

Create `~/.config/systemd/user/codex-toys-daily-review.service`:

```ini
[Unit]
Description=Run codex-toys daily review for example

[Service]
Type=oneshot
WorkingDirectory=/path/to/repo
ExecStart=/usr/bin/env codex-toys workbench run daily-review --mode local --workbench-root /path/to/repo
```

Create `~/.config/systemd/user/codex-toys-daily-review.timer`:

```ini
[Unit]
Description=Schedule codex-toys daily review for example

[Timer]
OnCalendar=*-*-* 14:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

Enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now codex-toys-daily-review.timer
systemctl --user list-timers codex-toys-daily-review.timer
```

If the machine uses a shell-managed Node install, put the absolute Codex and
codex-toys paths in `ExecStart` or set PATH with an `Environment=` line.

## 4. Add Queue Drains

Durable queues are still explicit. A polling timer can drain dispatch work:

```ini
[Unit]
Description=Drain codex-toys dispatch queue for example

[Service]
Type=oneshot
WorkingDirectory=/path/to/repo
ExecStart=/usr/bin/env codex-toys workbench dispatch run-due --mode local --workbench-root /path/to/repo
```

Pair it with a timer:

```ini
[Timer]
OnCalendar=*-*-* *:0/5:00 UTC
Persistent=true
```

Feed dispatch can be scheduled the same way:

```bash
codex-toys feed dispatch --source project-releases --cursor release-feed --target workbench-task:daily-review --limit 5
```

Use `systemctl --user status <unit>` and
`systemctl --user list-timers <timer>` for scheduler visibility. The
`workbench doctor` command reports workbench state, not systemd ownership.

## 5. Keep Local State Local

Do not commit local runtime state by default:

```text
.codex/workbench/local/
.codex/feed/local/
```

Commit repo-owned config, workflows, skills, and functions. Leave host-owned
state, local sessions, command output, and local queue attempts out of git
unless the repository deliberately treats that history as source data.
