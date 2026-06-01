---
title: CLI reference
description: Commands for Codex workbench toyboxes, turn automation, app-server calls, workbench methods, workbench autonomy, memory transplant, thread transplant, and kit repos.
---

# CLI reference

`codex-toys` is Codex workbench porcelain. Local commands spawn
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
codex-toys-proxy serve --cwd <workbench> [--static <dir>]
codex-toys-proxy serve --ssh <target> --cwd <remote-workbench> [--static <dir>]
```

## Fetch

```bash
codex-toys fetch [--json] [--no-color]
codex-toys neofetch [--json] [--no-color]
codex-toys --ssh <target> --cwd <remote-workbench> fetch
```

`fetch` prints local package/runtime information and probes the current
codex-toys toybox. With `--ssh`, the probe runs against the remote workbench
toybox without opening a remote port or copying credentials.

`fetch --json` uses the toybox model directly. The probe result is returned under
`toyboxUrl` and `toybox`, where `toybox.transport` is `local` or `ssh`. SSH fetches
use the normal request timeout so remote toybox startup and app-server
pass-through are not mistaken for local quick-probe failures.

## Toybox

```bash
codex-toys toybox serve [--cwd <path>]
```

The toybox is the single local/remote runtime surface. It owns workbench method
dispatch, app-server pass-through, workbench functions, automations, and
delegation. `toybox.initialize` returns server information, method names, and
method metadata so clients and proxies can discover capabilities dynamically.

Use `--codex-command` and repeated `--codex-arg` values when the toybox should
start a specific Codex binary or pass explicit app-server flags.

## SSH

```bash
codex-toys --ssh <target> --cwd <remote-workbench> remote preflight [--json]
codex-toys host overview --json
codex-toys --ssh <target> --cwd <remote-workbench> remote host-overview --json
codex-toys --ssh <target> --cwd <remote-workbench> app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-toys --ssh <target> --cwd <remote-workbench> workbench delegation.list
codex-toys --ssh <target> --cwd <remote-workbench> functions list --json
codex-toys --ssh <target> --cwd <remote-workbench> automation run check-release --event event.json
codex-toys --ssh <target> --cwd <remote-workbench> turn run "Scan current folder" --wait
```

`remote preflight` checks SSH reachability, remote cwd, remote Node,
`codex-toys`, Codex, toybox startup, and app-server pass-through. All other
commands use `--ssh` directly; there is no separate remote controller command
family.

`host overview --json` calls the toybox-owned `host.overview` method and returns
a bounded dashboard-friendly snapshot of host disk, memory, Docker, failed
systemd units, Tailscale health, and package versions. `remote host-overview
--json` is the SSH alias for the same method on the remote host.

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
codex-toys-proxy serve --cwd <workbench> [--static <dir>]
codex-toys-proxy serve --ssh <target> --cwd <remote-workbench> [--static <dir>]
```

The proxy is an optional HTTP edge for dashboards. It exposes only generic
routes:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/host/overview
POST /api/app/:method
POST /api/workbench/:method
POST /api/workbench/overview
```

`/api/schema` is derived from `toybox.initialize`; route behavior forwards to
toybox methods instead of duplicating feature-specific endpoint logic.
`/api/workbench/overview` is a convenience alias for the `workbench.overview`
toybox method, and `POST /api/host/overview` is equivalent to `POST /api/rpc`
with method `host.overview`.

Direct browser calls to the proxy API intentionally receive CORS headers only
for loopback origins such as `localhost`, `127.0.0.1`, `::1`, and
`*.localhost`. Requests carrying a non-loopback browser `Origin` are rejected.
Prefer the Vite plugin or `--static` same-origin serving for local dashboards
when possible.

## Turn Run

```bash
codex-toys turn run <prompt> [--wait] [--thread-id <id>]
codex-toys --ssh <target> --cwd <remote-workbench> turn run <prompt> --wait
```

`turn run` is the prompt primitive for local and SSH-backed workbenches. It
starts or reuses a Codex thread, starts a turn, and optionally waits for the
final assistant message.

SSH-backed `turn run` requires `--wait`. The SSH toybox is tied to the command
lifecycle, so unsupervised fire-and-forget turns are rejected instead of
returning a thread id for work that may be killed when the SSH session closes.
Use `workbench delegate start` for supervised background work.

## Turn Automation

```bash
codex-toys automation list [--json]
codex-toys automation run <name> [--event <event.json>] [--prompt <text>] [--via workbench|app]
codex-toys --ssh <target> --cwd <remote-workbench> automation list [--json]
codex-toys --ssh <target> --cwd <remote-workbench> automation run <name> [--event <event.json>]
```

Automation scripts run code before deciding whether to start a native Codex
turn. Scripts can use `context.turn.*`, `context.workbench.call`, and, when
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

## Workbench Functions

```bash
codex-toys functions list [--json]
codex-toys functions describe <name> [--json]
codex-toys functions call <name> [--params-json <json>] [--json]
codex-toys --ssh <target> --cwd <remote-workbench> functions list [--json]
```

Functions are JSON-in/JSON-out helpers loaded from `.codex/functions.ts`,
`.codex/functions.js`, or `.codex/functions.mjs` in the target workbench.

## Workbench Methods

```bash
codex-toys workbench <method> [params-json]
codex-toys workbench <method> --params-json <json>
codex-toys workbench <method> --params-file <file>
codex-toys workbench call <method> [params-json]
codex-toys workbench app <method> [params-json]
codex-toys workbench methods
codex-toys workbench overview [--json]
```

Workbench calls go through the toybox. `workbench app <method>` is a convenience
alias for generic app-server pass-through.

`workbench overview --json` returns a bounded dashboard-friendly snapshot for
the current workbench cwd: fetch and workbench doctor summary, deferred queue
counts and compact intents, latest deferred output status, automations,
functions, recent cwd threads, git state, and health checks for Node,
codex-toys, Codex, toybox, app-server, and workbench config. The JSON shape is
also available through `POST /api/workbench/overview` with `{}`.

## Workbench Delegation

```bash
codex-toys workbench delegate list [--json]
codex-toys workbench delegate start --cwd @/workbenches/name --prompt <text> [--wait]
codex-toys --ssh devbox --cwd /home/peezy workbench delegate start --target-cwd @/repos/patch.moi --prompt "Review the branch"
```

Delegation starts normal Codex threads in another cwd and records stable
delegation metadata under `.codex/workbench/local/delegations.json`. `@/path`
resolves relative to the toybox workbench root; absolute cwd values require an
explicit opt-in.

## Workbench Autonomy

```bash
codex-toys workbench doctor [--mode auto|local|actions] [--json]
codex-toys workbench tick [--mode auto|local|actions]
codex-toys workbench run <task-id> [--mode auto|local|actions]
codex-toys workbench prompt enqueue <prompt> [--run-at <iso>] [--queue <name>]
codex-toys workbench prompt enqueue <prompt> --after <intent-id> [--after-status completed|terminal]
codex-toys workbench prompt list [--queue <name>] [--status pending|running|completed|failed|canceled] [--json]
codex-toys workbench prompt read <intent-id> [--include-output] [--json]
codex-toys workbench prompt pull <intent-id> [--json]
codex-toys workbench prompt collect [--cursor <name>] [--queue <name>] [--json]
codex-toys workbench prompt cancel <intent-id>
codex-toys workbench prompt retry <intent-id> [--run-at <iso>]
codex-toys workbench prompt run-due [--queue <name>] [--limit <n>]
codex-toys workbench handoff enqueue <prompt> [--run-at <iso>] [--queue <name>]
codex-toys workbench handoff enqueue <prompt> [--target-host <host>] [--capability <name>]
codex-toys workbench handoff list [--queue <name>] [--target-host <host>] [--json]
codex-toys workbench handoff read <intent-id> [--include-output] [--json]
codex-toys workbench handoff pull <intent-id> [--json]
codex-toys workbench handoff collect [--cursor <name>] [--queue <name>] [--json]
codex-toys workbench handoff cancel <intent-id>
codex-toys workbench handoff retry <intent-id> [--run-at <iso>]
codex-toys workbench handoff drain [--host-id <host>] [--capability <name>] [--materialize]
codex-toys workbench deferred create --params-json <json>
codex-toys workbench deferred list [--mode auto|local|actions] [--json]
codex-toys workbench deferred read <intent-id> [--include-output] [--json]
codex-toys workbench deferred pull <intent-id> [--json]
codex-toys workbench deferred collect [--cursor <name>] [--json]
codex-toys workbench deferred cancel <intent-id>
codex-toys workbench deferred retry <intent-id> [--run-at <iso>]
codex-toys workbench deferred run-due [--mode auto|local|actions]
codex-toys workbench deferred prune --older-than-days <days> [--dry-run]
codex-toys workbench init actions [--forgejo|--github]
codex-toys actions prepare-auth
codex-toys actions cleanup
```

Workbench autonomy reads `.codex/workbench.toml`, writes local runtime state
under `.codex/workbench/local`, and writes CI runtime state under
`.codex/workbench/actions`. Actions-mode runners also preserve
`.codex/sessions` rollout JSONL as durable thread handoff data.

Deferred runs are durable future run intents in those same mode-specific state
roots. A deferred target can wrap a direct Codex turn, a named turn automation,
or a configured workbench task. `workbench tick` creates scheduled task intents
and runs due deferred work; `workbench deferred run-due` runs only due deferred
intents. With `--ssh`, deferred methods operate on the remote workbench's local
queue through the SSH toybox.

`workbench prompt` is the Deferred Prompt Queue surface for one-off Codex
prompts. It stores queued prompts as deferred turn intents marked with
`source.kind = "prompt-queue"`, so they share deferred claiming, attempts,
outputs, retries, SSH behavior, and result collection. `--after <intent-id>`
adds a dependency on another deferred intent; `--after-status` defaults to
`completed`, and `terminal` accepts completed, failed, or canceled parents.
`workbench prompt run-due` drains only queued prompts, while `workbench tick`
runs queued prompts along with all other due deferred work.

`workbench handoff` is the Local Handoff Queue surface for prompts that require
a local controller, local browser, plugin install, dashboard smoke, or another
host-specific capability. Handoffs are deferred turn intents marked with
`source.kind = "local-handoff"`, but `workbench tick` and generic
`workbench deferred run-due` skip them. `workbench handoff drain` is the local
controller path: it advertises a `--host-id` and repeated `--capability` values,
then either runs matching handoffs immediately or, with `--materialize`, creates
a prompt-queue intent such as `--prompt-queue local-followups`.

`workbench doctor` includes local systemd user runner visibility when it is run
on Linux. A matching runner is a timer whose service invokes `codex-toys
workbench tick --workbench-root <current-workbench>`. If pending deferred work
or scheduled tasks exist without a matching active runner, doctor reports a
runner warning so the operator can add a timer, CI schedule, or manual tick.

`workbench deferred read --include-output` embeds completed attempt output JSON
in the response. `workbench deferred pull` is a shorthand for that form, which
is useful when a local operator wants to inspect a remote deferred run result
without separately reading remote filesystem paths.

`workbench deferred collect` returns terminal deferred runs that have not been
seen by the named cursor yet, including saved attempt outputs. The cursor is
stored with the queue being collected; over SSH, that means the remote
workbench queue advances its own cursor.

`workbench deferred retry` creates a new pending intent from a terminal
`completed`, `failed`, or `canceled` intent and leaves the original intent,
attempt records, and outputs untouched. By default the retry is due immediately;
use `--run-at <iso>` to requeue it for a future time.

`workbench deferred prune` removes only terminal deferred history (`completed`,
`failed`, or `canceled`) older than the requested retention window. Pending and
running intents are never pruned.

`workbench init actions` scaffolds a scheduled runner workflow. The generated
workflow prepares auth, runs `workbench tick --mode actions`, cleans up
runtime-only files, and commits changed `.codex/memories`,
`.codex/workbench/actions`, and `.codex/sessions`.

## Memories

```bash
codex-toys memories transplant global-to-workbench [--apply]
codex-toys memories transplant workbench-to-global [--apply]
codex-toys memories transplant global-to-workbench --merge codex [--apply]
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

## Kits

```bash
codex-toys kit inspect <source> [--json]
codex-toys kit add <source> [--apply] [--include <name>] [--exclude <name>]
codex-toys kit doctor [--json]
codex-toys kit list [--json]
```

Kit commands copy selected skills, plugins, and automations into a workbench and
record provenance in `.codex/kit-lock.json`.
