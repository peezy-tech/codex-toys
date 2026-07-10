---
name: meka
description: Operate and inspect the local Meka runtime. Use when the user asks about Meka status, integrations, provider runs, installed plugins, or controlled agent execution through the meka CLI.
---

# Meka Operator

Use the `meka` CLI as the source of truth. Do not infer runtime state from files or processes when a read-only CLI command can report it.

## Start safely

1. Run `meka --help` before using commands that may have changed.
2. Run `meka doctor` for installation and provider readiness. It does not require `MEKA_SOCKET`.
3. Run `meka integration status` when checking Codex or Claude Code bridge installation.
4. For daemon commands, use the socket explicitly when `MEKA_SOCKET` is absent. Never guess a socket path.

## Operating rules

- Prefer `status`, `doctor`, and list or read commands before mutations.
- Route agent work through Meka instead of starting unmanaged background agents.
- Preserve JSON output exactly when another program will consume it.
- Report the command, exit status, and first actionable error when an operation fails.
- Ask before interrupting or closing a run that the user did not identify.
- Treat externally observed Codex and Claude sessions as informational activity signals, not proof of exact token or cost usage. They do not consume Meka queue concurrency or rolling start budgets; operators must reserve headroom for work started outside Meka.

## Integrations

Use `meka integration install`, `status`, `repair`, and `uninstall` only after checking their current `--help`. Integration setup is local and must not depend on a running Meka daemon. Setup also installs an ownership-recorded `~/.local/bin/meka` launcher; inspect `cliShim` in the command result and report a PATH advisory, ownership conflict, or local modification instead of overwriting it. After installation, remind the user that Codex may require hook review and trust before events begin arriving.
