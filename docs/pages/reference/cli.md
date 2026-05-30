---
title: CLI reference
description: Commands for Codex-native toyboxes, turn automation, app-server calls, workspace methods, workspace autonomy, memory transplant, thread transplant, and pack repos.
---

# CLI reference

`codex-toys` is Codex-native workspace porcelain. Local commands spawn
`codex-toys toybox serve` over stdio. SSH commands start the same toybox on the
target host and speak JSON-RPC over SSH stdio. Core commands do not host
WebSocket or HTTP servers.

The optional `codex-toys-proxy` binary is the browser edge. It starts or
connects to a toybox internally and exposes a small generic HTTP API for
freeform HTML/JS dashboards.

```bash
codex-toys --help
codex-toys mcp serve
codex-toys toybox serve [--cwd <path>]
codex-toys-proxy serve --cwd <workspace> [--static <dir>]
codex-toys-proxy serve --ssh <target> --cwd <remote-workspace> [--static <dir>]
```

## Fetch

```bash
codex-toys fetch [--json] [--no-color]
codex-toys neofetch [--json] [--no-color]
codex-toys --ssh <target> --cwd <remote-workspace> fetch
```

`fetch` prints local package/runtime information and probes the current
codex-toys toybox. With `--ssh`, the probe runs against the remote workspace
toybox without opening a remote port or copying credentials.

`fetch --json` uses the toybox model directly. The probe result is returned under
`toyboxUrl` and `toybox`, where `toybox.transport` is `local` or `ssh`. SSH fetches
use the normal request timeout so remote toybox startup and app-server
pass-through are not mistaken for local quick-probe failures.

## Toybox

```bash
codex-toys toybox serve [--cwd <path>]
```

The toybox is the single local/remote runtime surface. It owns workspace method
dispatch, app-server pass-through, workspace functions, automations, and
delegation. `toybox.initialize` returns server information, method names, and
method metadata so clients and proxies can discover capabilities dynamically.

Use `--codex-command` and repeated `--codex-arg` values when the toybox should
start a specific Codex binary or pass explicit app-server flags.

## SSH

```bash
codex-toys --ssh <target> --cwd <remote-workspace> remote preflight [--json]
codex-toys --ssh <target> --cwd <remote-workspace> app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-toys --ssh <target> --cwd <remote-workspace> workspace delegation.list
codex-toys --ssh <target> --cwd <remote-workspace> functions list --json
codex-toys --ssh <target> --cwd <remote-workspace> automation run check-release --event event.json
codex-toys --ssh <target> --cwd <remote-workspace> turn run "Scan current folder" --wait
```

`remote preflight` checks SSH reachability, remote cwd, remote Node,
`codex-toys`, Codex, toybox startup, and app-server pass-through. All other
commands use `--ssh` directly; there is no separate remote controller command
family.

Useful SSH options and environment:

```bash
--ssh <user@host>
--remote-path-prepend /home/me/.local/bin:/home/me/.bun/bin
--toybox-command /home/me/.local/bin/codex-toys
--codex-command /home/me/.local/bin/codex
--codex-arg -s --codex-arg danger-full-access

CODEX_TOYS_REMOTE_SSH_TARGET=<user@host>
CODEX_TOYS_REMOTE_CWD=/repo
CODEX_TOYS_REMOTE_PATH_PREPEND=/home/me/.local/bin:/home/me/.bun/bin
CODEX_TOYS_TOYBOX_COMMAND=codex-toys
CODEX_TOYS_REMOTE_CODEX_COMMAND=codex
CODEX_TOYS_REMOTE_CODEX_ARGS=["-s","danger-full-access"]
```

## Proxy

```bash
codex-toys-proxy serve --cwd <workspace> [--static <dir>]
codex-toys-proxy serve --ssh <target> --cwd <remote-workspace> [--static <dir>]
```

The proxy is an optional HTTP edge for dashboards. It exposes only generic
routes:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/app/:method
POST /api/workspace/:method
POST /api/workspace/overview
```

`/api/schema` is derived from `toybox.initialize`; route behavior forwards to
toybox methods instead of duplicating feature-specific endpoint logic.
`/api/workspace/overview` is a convenience alias for the `workspace.overview`
toybox method.

Direct browser calls to the proxy API intentionally receive CORS headers only
for loopback origins such as `localhost`, `127.0.0.1`, `::1`, and
`*.localhost`. Requests carrying a non-loopback browser `Origin` are rejected.
Prefer the Vite plugin or `--static` same-origin serving for local dashboards
when possible.

## Turn Run

```bash
codex-toys turn run <prompt> [--wait] [--thread-id <id>]
codex-toys --ssh <target> --cwd <remote-workspace> turn run <prompt> --wait
```

`turn run` is the prompt primitive for local and SSH-backed workspaces. It
starts or reuses a Codex thread, starts a turn, and optionally waits for the
final assistant message.

SSH-backed `turn run` requires `--wait`. The SSH toybox is tied to the command
lifecycle, so unsupervised fire-and-forget turns are rejected instead of
returning a thread id for work that may be killed when the SSH session closes.
Use `workspace delegate start` for supervised background work.

## Turn Automation

```bash
codex-toys automation list [--json]
codex-toys automation run <name> [--event <event.json>] [--prompt <text>] [--via workspace|app]
codex-toys --ssh <target> --cwd <remote-workspace> automation list [--json]
codex-toys --ssh <target> --cwd <remote-workspace> automation run <name> [--event <event.json>]
```

Automation scripts run code before deciding whether to start a native Codex
turn. Scripts can use `context.turn.*`, `context.workspace.call`, and, when
running through the toybox, `context.delegate.*`.

## App-Server Calls

```bash
codex-toys app <method> [params-json]
codex-toys app <method> --params-json <json>
codex-toys app <method> --params-file <file>
codex-toys app call <method> [params-json]
echo '<params-json>' | codex-toys app <method>
codex-toys app actions
```

App calls are generic app-server pass-through via the toybox. SSH app calls start
the remote toybox and then call `app.call { method, params }`.

## Workspace Functions

```bash
codex-toys functions list [--json]
codex-toys functions describe <name> [--json]
codex-toys functions call <name> [--params-json <json>] [--json]
codex-toys --ssh <target> --cwd <remote-workspace> functions list [--json]
```

Functions are JSON-in/JSON-out helpers loaded from `.codex/functions.ts`,
`.codex/functions.js`, or `.codex/functions.mjs` in the target workspace.

## Workspace Methods

```bash
codex-toys workspace <method> [params-json]
codex-toys workspace <method> --params-json <json>
codex-toys workspace <method> --params-file <file>
codex-toys workspace call <method> [params-json]
codex-toys workspace app <method> [params-json]
codex-toys workspace methods
codex-toys workspace overview [--json]
```

Workspace calls go through the toybox. `workspace app <method>` is a convenience
alias for generic app-server pass-through.

`workspace overview --json` returns a bounded dashboard-friendly snapshot for
the current workspace cwd: fetch and workspace doctor summary, deferred queue
counts and compact intents, latest deferred output status, automations,
functions, recent cwd threads, git state, and health checks for Node,
codex-toys, Codex, toybox, app-server, and workspace config. The JSON shape is
also available through `POST /api/workspace/overview` with `{}`.

## Workspace Delegation

```bash
codex-toys workspace delegate list [--json]
codex-toys workspace delegate start --cwd @/workspaces/name --prompt <text> [--wait]
codex-toys --ssh devbox --cwd /home/peezy workspace delegate start --target-cwd @/repos/patch.moi --prompt "Review the branch"
```

Delegation starts normal Codex threads in another cwd and records stable
delegation metadata under `.codex/workspace/local/delegations.json`. `@/path`
resolves relative to the toybox workspace root; absolute cwd values require an
explicit opt-in.

## Workspace Autonomy

```bash
codex-toys workspace doctor [--mode auto|local|actions] [--json]
codex-toys workspace tick [--mode auto|local|actions]
codex-toys workspace run <task-id> [--mode auto|local|actions]
codex-toys workspace deferred create --params-json <json>
codex-toys workspace deferred list [--mode auto|local|actions] [--json]
codex-toys workspace deferred read <intent-id> [--include-output] [--json]
codex-toys workspace deferred pull <intent-id> [--json]
codex-toys workspace deferred collect [--cursor <name>] [--json]
codex-toys workspace deferred cancel <intent-id>
codex-toys workspace deferred run-due [--mode auto|local|actions]
codex-toys workspace deferred prune --older-than-days <days> [--dry-run]
codex-toys workspace init actions [--forgejo|--github]
codex-toys actions prepare-auth
codex-toys actions cleanup
```

Workspace autonomy reads `.codex/workspace.toml`, writes local runtime state
under `.codex/workspace/local`, and writes CI runtime state under
`.codex/workspace/actions`. Actions-mode runners also preserve
`.codex/sessions` rollout JSONL as durable thread handoff data.

Deferred runs are durable future run intents in those same mode-specific state
roots. A deferred target can wrap a direct Codex turn, a named turn automation,
or a configured workspace task. `workspace tick` creates scheduled task intents
and runs due deferred work; `workspace deferred run-due` runs only due deferred
intents. With `--ssh`, deferred methods operate on the remote workspace's local
queue through the SSH toybox.

`workspace doctor` includes local systemd user runner visibility when it is run
on Linux. A matching runner is a timer whose service invokes `codex-toys
workspace tick --workspace-root <current-workspace>`. If pending deferred work
or scheduled tasks exist without a matching active runner, doctor reports a
runner warning so the operator can add a timer, CI schedule, or manual tick.

`workspace deferred read --include-output` embeds completed attempt output JSON
in the response. `workspace deferred pull` is a shorthand for that form, which
is useful when a local operator wants to inspect a remote deferred run result
without separately reading remote filesystem paths.

`workspace deferred collect` returns terminal deferred runs that have not been
seen by the named cursor yet, including saved attempt outputs. The cursor is
stored with the queue being collected; over SSH, that means the remote
workspace queue advances its own cursor.

`workspace deferred prune` removes only terminal deferred history (`completed`,
`failed`, or `canceled`) older than the requested retention window. Pending and
running intents are never pruned.

`workspace init actions` scaffolds a scheduled runner workflow. The generated
workflow prepares auth, runs `workspace tick --mode actions`, cleans up
runtime-only files, and commits changed `.codex/memories`,
`.codex/workspace/actions`, and `.codex/sessions`.

## Memories

```bash
codex-toys memories transplant global-to-workspace [--apply]
codex-toys memories transplant workspace-to-global [--apply]
codex-toys memories transplant global-to-workspace --merge codex [--apply]
```

Memory transplant is dry-run by default and copies only durable Codex memory
markdown artifacts.

## Threads

```bash
codex-toys threads locate <thread-id> [--codex-home <home>]
codex-toys threads inspect <thread-id-or-rollout.jsonl> [--codex-home <home>]
codex-toys threads install-rollout <rollout.jsonl> [--codex-home <home>] [--replace]
codex-toys threads transplant <thread-id> --from-codex-home <src> --to-codex-home <dst> [--replace]
```

Thread helpers locate, inspect, install, and transplant raw Codex rollout JSONL
files without inventing a separate bundle format.

## Packs

```bash
codex-toys pack inspect <source> [--json]
codex-toys pack add <source> [--apply] [--include <name>] [--exclude <name>]
codex-toys pack doctor [--json]
codex-toys pack list [--json]
```

Pack commands copy selected skills, plugins, and hooks into a workspace and
record provenance in `.codex/pack-lock.json`.
