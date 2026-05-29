---
title: CLI reference
description: Commands for Codex-native agents, turn automation, app-server calls, workspace methods, workspace autonomy, memory transplant, thread transplant, and pack repos.
---

# CLI reference

`codex-flows` is Codex-native workspace porcelain. Local commands spawn
`codex-flows agent serve` over stdio. SSH commands start the same agent on the
target host and speak JSON-RPC over SSH stdio. Core commands do not host
WebSocket or HTTP servers.

The optional `codex-flows-proxy` binary is the browser edge. It starts or
connects to an agent internally and exposes a small generic HTTP API for
freeform HTML/JS dashboards.

```bash
codex-flows --help
codex-flows mcp serve
codex-flows agent serve [--cwd <path>]
codex-flows-proxy serve --cwd <workspace> [--static <dir>]
codex-flows-proxy serve --ssh <target> --cwd <remote-workspace> [--static <dir>]
```

## Fetch

```bash
codex-flows fetch [--json] [--no-color]
codex-flows neofetch [--json] [--no-color]
codex-flows --ssh <target> --cwd <remote-workspace> fetch
```

`fetch` prints local package/runtime information and probes the current
codex-flows agent. With `--ssh`, the probe runs against the remote workspace
agent without opening a remote port or copying credentials.

## Agent

```bash
codex-flows agent serve [--cwd <path>]
```

The agent is the single local/remote runtime surface. It owns workspace method
dispatch, app-server pass-through, workspace functions, automations, and
delegation. `workspace.initialize` returns server information, method names, and
method metadata so clients and proxies can discover capabilities dynamically.

Use `--codex-command` and repeated `--codex-arg` values when the agent should
start a specific Codex binary or pass explicit app-server flags.

## SSH

```bash
codex-flows --ssh <target> --cwd <remote-workspace> remote preflight [--json]
codex-flows --ssh <target> --cwd <remote-workspace> app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-flows --ssh <target> --cwd <remote-workspace> workspace delegation.list
codex-flows --ssh <target> --cwd <remote-workspace> functions list --json
codex-flows --ssh <target> --cwd <remote-workspace> automation run check-release --event event.json
codex-flows --ssh <target> --cwd <remote-workspace> turn run "Scan current folder" --wait
```

`remote preflight` checks SSH reachability, remote cwd, remote Node,
`codex-flows`, Codex, agent startup, and app-server pass-through. All other
commands use `--ssh` directly; there is no separate remote controller command
family.

Useful SSH options and environment:

```bash
--ssh <user@host>
--remote-path-prepend /home/me/.local/bin:/home/me/.bun/bin
--agent-command /home/me/.local/bin/codex-flows
--codex-command /home/me/.local/bin/codex
--codex-arg -s --codex-arg danger-full-access

CODEX_FLOWS_REMOTE_SSH_TARGET=<user@host>
CODEX_FLOWS_REMOTE_CWD=/repo
CODEX_FLOWS_REMOTE_PATH_PREPEND=/home/me/.local/bin:/home/me/.bun/bin
CODEX_FLOWS_AGENT_COMMAND=codex-flows
CODEX_FLOWS_REMOTE_CODEX_COMMAND=codex
CODEX_FLOWS_REMOTE_CODEX_ARGS=["-s","danger-full-access"]
```

## Proxy

```bash
codex-flows-proxy serve --cwd <workspace> [--static <dir>]
codex-flows-proxy serve --ssh <target> --cwd <remote-workspace> [--static <dir>]
```

The proxy is an optional HTTP edge for dashboards. It exposes only generic
routes:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/app/:method
POST /api/workspace/:method
```

`/api/schema` is derived from `workspace.initialize`; route behavior forwards to
agent methods instead of duplicating feature-specific endpoint logic.

## Turn Run

```bash
codex-flows turn run <prompt> [--wait] [--thread-id <id>]
codex-flows --ssh <target> --cwd <remote-workspace> turn run <prompt> --wait
```

`turn run` is the prompt primitive for local and SSH-backed workspaces. It
starts or reuses a Codex thread, starts a turn, and optionally waits for the
final assistant message.

## Turn Automation

```bash
codex-flows automation list [--json]
codex-flows automation run <name> [--event <event.json>] [--prompt <text>] [--via workspace|app]
codex-flows --ssh <target> --cwd <remote-workspace> automation list [--json]
codex-flows --ssh <target> --cwd <remote-workspace> automation run <name> [--event <event.json>]
```

Automation scripts run code before deciding whether to start a native Codex
turn. Scripts can use `context.turn.*`, `context.workspace.call`, and, when
running through the agent, `context.delegate.*`.

## App-Server Calls

```bash
codex-flows app <method> [params-json]
codex-flows app <method> --params-json <json>
codex-flows app <method> --params-file <file>
codex-flows app call <method> [params-json]
echo '<params-json>' | codex-flows app <method>
codex-flows app actions
```

App calls are generic app-server pass-through via the agent. SSH app calls start
the remote agent and then call `appServer.call { method, params }`.

## Workspace Functions

```bash
codex-flows functions list [--json]
codex-flows functions describe <name> [--json]
codex-flows functions call <name> [--params-json <json>] [--json]
codex-flows --ssh <target> --cwd <remote-workspace> functions list [--json]
```

Functions are JSON-in/JSON-out helpers loaded from `.codex/functions.ts`,
`.codex/functions.js`, or `.codex/functions.mjs` in the target workspace.

## Workspace Methods

```bash
codex-flows workspace <method> [params-json]
codex-flows workspace <method> --params-json <json>
codex-flows workspace <method> --params-file <file>
codex-flows workspace call <method> [params-json]
codex-flows workspace app <method> [params-json]
codex-flows workspace methods
```

Workspace calls go through the agent. `workspace app <method>` is a convenience
alias for generic app-server pass-through.

## Workspace Delegation

```bash
codex-flows workspace delegate list [--json]
codex-flows workspace delegate start --cwd @/workspaces/name --prompt <text> [--wait]
codex-flows --ssh devbox --cwd /home/peezy workspace delegate start --target-cwd @/repos/patch.moi --prompt "Review the branch"
```

Delegation starts normal Codex threads in another cwd and records stable
delegation metadata under `.codex/workspace/local/delegations.json`. `@/path`
resolves relative to the agent workspace root; absolute cwd values require an
explicit opt-in.

## Workspace Autonomy

```bash
codex-flows workspace doctor [--mode auto|local|actions] [--json]
codex-flows workspace tick [--mode auto|local|actions]
codex-flows workspace run <task-id> [--mode auto|local|actions]
codex-flows workspace init actions [--forgejo|--github]
codex-flows actions prepare-auth
codex-flows actions cleanup
```

Workspace autonomy reads `.codex/workspace.toml`, writes local runtime state
under `.codex/workspace/local`, and writes CI runtime state under
`.codex/workspace/actions`.

## Memories

```bash
codex-flows memories transplant global-to-workspace [--apply]
codex-flows memories transplant workspace-to-global [--apply]
codex-flows memories transplant global-to-workspace --merge codex [--apply]
```

Memory transplant is dry-run by default and copies only durable Codex memory
markdown artifacts.

## Threads

```bash
codex-flows threads locate <thread-id> [--codex-home <home>]
codex-flows threads inspect <thread-id-or-rollout.jsonl> [--codex-home <home>]
codex-flows threads install-rollout <rollout.jsonl> [--codex-home <home>] [--replace]
codex-flows threads transplant <thread-id> --from-codex-home <src> --to-codex-home <dst> [--replace]
```

Thread helpers locate, inspect, install, and transplant raw Codex rollout JSONL
files without inventing a separate bundle format.

## Packs

```bash
codex-flows pack inspect <source> [--json]
codex-flows pack add <source> [--apply] [--include <name>] [--exclude <name>]
codex-flows pack doctor [--json]
codex-flows pack list [--json]
```

Pack commands copy selected skills, plugins, and hooks into a workspace and
record provenance in `.codex/pack-lock.json`.
