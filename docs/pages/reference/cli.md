---
title: CLI reference
description: Commands for app-server calls, workspace backend calls, flow inspection, workspace autonomy, memory transplant, thread transplant, and pack repos.
---

# CLI reference

`codex-flows` controls Codex app-server and workspace backend surfaces. The
same package also publishes focused bins for app-server calls, local flow runs,
and the local workspace backend.

```bash
codex-flows --help
```

## Fetch

```bash
codex-flows fetch [--json] [--no-color]
codex-flows neofetch [--json] [--no-color]
```

`fetch` first probes the configured workspace backend, falls back to the
configured app-server, and then prints local package, runtime, endpoint,
workspace, and Codex environment information. With a reachable backend it also
includes capabilities, recent thread counts, delegation counts, and flow
run/event counts.

## App-Server Calls

```bash
codex-flows app <method> [params-json]
codex-flows app call <method> [params-json]
echo '<params-json>' | codex-flows app <method>
codex-flows app actions
```

The direct app-server path defaults to `CODEX_WORKSPACE_APP_SERVER_WS_URL` or
`ws://127.0.0.1:3585`. Use `--app-url`, `--app-server-url`, `--url`, or
`--ws-url` to override it. Use `stdio://` to spawn a local app-server.

## Workspace Backend Calls

```bash
codex-flows workspace <method> [params-json]
codex-flows workspace call <method> [params-json]
codex-flows workspace app <method> [params-json]
codex-flows workspace methods
```

`workspace <method>` calls a workspace backend method. `workspace app <method>`
asks the workspace backend to proxy a native app-server method.

The workspace path defaults to `CODEX_WORKSPACE_BACKEND_WS_URL` or
`ws://127.0.0.1:3586`. Use `--workspace-url`, `--workspace-backend-url`,
`--url`, or `--ws-url` to override it.

## Workspace Autonomy

```bash
codex-flows workspace doctor [--mode auto|local|actions] [--json]
codex-flows workspace tick [--mode auto|local|actions]
codex-flows workspace run <task-id> [--mode auto|local|actions]
codex-flows workspace init actions [--forgejo|--github] [--with-smoke] [--with-agent-turn]
```

- `doctor` reports mode, repo root, `.codex/workspace.toml`, runtime
  `CODEX_HOME`, state roots, task counts, due tasks, failing tasks, latest run,
  memory roots, memory summary presence, invariant errors, and backend
  reachability. In Actions mode it flags any runner that would use a Codex home
  outside the repository `.codex` directory.
- `tick` runs due scheduled tasks and reactive rules.
- `run <task-id>` runs one task immediately.
- `init actions` scaffolds `.codex/workspace.toml`, `.codex/config.toml`,
  workflow files, optional smoke and agent-turn flows, and `.gitignore`
  entries for runtime-only Codex files.

See [Workspace autonomy](../guides/workspace-autonomy) for config, modes, and
CI behavior.

## Actions Helpers

```bash
codex-flows actions prepare-auth
codex-flows actions cleanup
codex-flows actions dispatch --event <event.json>
codex-flows actions assert-run --flow <name> --step <name> [--artifact-text <text>]
```

These commands are for CI and local Actions-mode simulation. They always resolve
the runtime Codex home to `<repo>/.codex`, even if the caller has another
`CODEX_HOME` in the environment.

- `prepare-auth` writes `.codex/auth.json` with mode `0600` from
  `CODEX_AUTH_JSON_B64`, `CODEX_AUTH_JSON`, or `OPENAI_API_KEY`.
- `cleanup` removes runtime-only auth, install ids, sessions, shell snapshots,
  temp dirs, SQLite databases, `.codex/memories/.git`, and
  `phase2_workspace_diff.md` while preserving `.codex/memories/*.md`,
  `.codex/memories/rollout_summaries/*.md`, and `.codex/workspace/actions`.
- `dispatch` persists the event under `.codex/workspace/actions/events` and
  dispatches it through a file-backed local flow client rooted at
  `.codex/workspace/actions/flow-client`.
- `assert-run` checks the latest file-backed Actions run for a flow and step,
  optionally requiring text in the stored run record.

## Memory Transplant

```bash
codex-flows memories transplant global-to-workspace [--apply]
codex-flows memories transplant workspace-to-global [--apply]
```

Additional options:

```bash
--workspace-root <path>
--global-codex-home <path>
--workspace-codex-home <path>
--overwrite
--merge codex
--no-backup
--json
```

The command is dry-run by default. It copies only durable memory artifacts under
`memories/`: `MEMORY.md`, `memory_summary.md`, `raw_memories.md`, and
`rollout_summaries/*.md`. See [Memory transplant](../guides/memory-transplant).

## Thread Transplant

```bash
codex-flows threads locate <thread-id> [--codex-home <home>]
codex-flows threads inspect <thread-id-or-rollout.jsonl> [--codex-home <home>]
codex-flows threads install-rollout <rollout.jsonl> [--codex-home <home>] [--replace]
codex-flows threads transplant <thread-id> --from-codex-home <src> --to-codex-home <dst> [--replace]
```

Thread transplant copies raw Codex rollout JSONL files between `CODEX_HOME`
roots. `transplant` copies one native rollout directly from a source home to a
target home, preserving the `sessions/.../rollout-*.jsonl` path and failing on
conflicts unless `--replace` is set. `inspect` validates a thread id or rollout
JSONL directly and prints byte length and sha256. `install-rollout` places a
loose JSONL file into a Codex home using the native sessions path. See [Thread
transplant](../guides/thread-transplant).

## Pack Repos

```bash
codex-flows pack inspect <source> [--json]
codex-flows pack add <source> [--apply] [--include <name>] [--exclude <name>]
codex-flows pack doctor [--json]
codex-flows pack list [--json]
```

`pack inspect` discovers skills, flow packages, plugins, and hook bundles from a
local directory, GitHub shorthand such as `owner/repo`, or a Git URL. Use
`--ref <ref>` with GitHub shorthand or Git URL sources.

`pack add` is dry-run by default and writes only with `--apply`. It installs
repo-local capabilities into `.agents/skills`, `.codex/flows`, `plugins`,
`.agents/plugins/marketplace.json`, `.codex/hooks`, and `.codex/hooks.json`.
Changed destinations and same-name plugin marketplace entries from another
source are conflicts unless `--overwrite` is set; overwrite backs up replaced
paths under `.codex/pack-backups/<timestamp>/`.

`pack list` reads `.codex/pack-lock.json`. `pack doctor` checks the lockfile,
destination paths and content hashes, plugin marketplace JSON, and direct hook JSON. See
[Install pack repos](../guides/install-pack-repos).

## Flow Inspection

```bash
codex-flows flow dispatch --event <event.json>
codex-flows flow events [--type <type>] [--limit <n>]
codex-flows flow event <event-id>
codex-flows flow replay <event-id> [--wait]
codex-flows flow runs [--event-id <id>] [--status <status>] [--limit <n>]
codex-flows flow run <run-id>
```

These commands use the workspace backend flow capability. They inspect and
control generic flow events and runs; they do not execute app-server thread
commands directly.

## Local Runner

The package includes `codex-flow-runner` for local flow packages:

```bash
codex-flow-runner list
codex-flow-runner fire --event event.json
codex-flow-runner run <flow> <step> --event event.json
```

`flow fire` dispatches through the local client and runs every step whose
trigger type and schema match the event.

`flow run` also accepts run metadata used by workspace backend launches:

```bash
codex-flow-runner run <flow> <step> --event event.json \
  --run-id run_123 \
  --attempt-id run_123 \
  --workspace-backend-url ws://127.0.0.1:3586
```

## Workspace Flow Backend

```bash
codex-workspace-backend-local serve --cwd <workspace>
codex-workspace-backend-local list-events --limit 20
codex-workspace-backend-local show-event <event-id>
codex-workspace-backend-local list-runs --status failed --limit 20
codex-workspace-backend-local show-run <run-id>
codex-workspace-backend-local replay-event <event-id> --wait
```

## Companion Bins

```bash
codex-app thread/list '{"limit":20,"sourceKinds":[]}'
```

## Common Options

| Option | Purpose |
|--------|---------|
| `--app-url`, `--app-server-url <url>` | App-server WebSocket URL. |
| `--workspace-url`, `--workspace-backend-url <url>` | Workspace backend WebSocket URL. |
| `--url`, `--ws-url <url>` | Set both app-server and workspace backend URLs. |
| `--timeout-ms <ms>` | Request timeout. Defaults to `90000`, or `1500` for fetch probes. |
| `--compact` | Print compact JSON. |
| `--pretty` | Print pretty JSON. |
| `--json` | Print JSON for commands that support it. |
| `--no-color` | Disable ANSI colors for fetch. |
| `--mode <auto|local|actions>` | Workspace execution mode. |
| `--workspace-root <path>` | Workspace root. Defaults to discovery. |
| `--global-codex-home <path>` | Global Codex home for memory transplant. |
| `--workspace-codex-home <path>` | Workspace Codex home for memory transplant. |
| `--codex-home <path>` | Codex home for thread transplant. |
| `--from-codex-home <path>` | Source Codex home for direct thread transplant. |
| `--to-codex-home <path>` | Target Codex home for direct thread transplant. |
| `--apply` | Apply memory transplant or pack install changes. |
| `--overwrite` | Replace destination memory files or changed pack item directories after backup. |
| `--replace` | Replace an existing thread rollout after backup. |
| `--ref <ref>` | Git ref for non-local pack sources. |
| `--include <name>` | Include a pack item by name or `kind:name`. |
| `--exclude <name>` | Exclude a pack item by name or `kind:name`. |
| `--merge codex` | Merge `MEMORY.md` and `memory_summary.md` with Codex. |
| `--no-backup` | Disable overwrite or merge backups. |
| `--flow <name>` | Flow name for `actions assert-run`. |
| `--step <name>` | Step name for `actions assert-run`. |
| `--artifact-text <text>` | Text that must appear in an asserted Actions run. |
| `--forgejo` | Generate a Forgejo workflow with `workspace init actions`. |
| `--github` | Generate a GitHub Actions workflow with `workspace init actions`. |
| `--with-smoke` | Generate an Actions smoke flow with `workspace init actions`. |
| `--with-agent-turn` | Generate an agent-turn flow with `workspace init actions`. |

## Environment

| Variable | Purpose |
|----------|---------|
| `CODEX_WORKSPACE_APP_SERVER_WS_URL` | Default direct app-server WebSocket URL. |
| `CODEX_WORKSPACE_BACKEND_WS_URL` | Default workspace backend WebSocket URL. |
| `CODEX_WORKSPACE_MODE` | Default workspace autonomy mode: `auto`, `local`, or `actions`. |
| `CODEX_HOME` | Active Codex home. Actions mode sets it to the repo `.codex`. |
| `CODEX_AUTH_JSON_B64` | Base64 JSON auth payload consumed by `actions prepare-auth`. |
| `CODEX_AUTH_JSON` | Raw JSON auth payload consumed by `actions prepare-auth`. |
| `OPENAI_API_KEY` | API key fallback consumed by `actions prepare-auth`. |
| `CODEX_APP_SERVER_CODEX_COMMAND` | Overrides the Codex command for stdio app-server launches. |
| `CODEX_FLOW_BACKEND_URL` | HTTP backend URL for compatible flow inspection and dispatch clients. |
| `CODEX_FLOW_BACKEND_SECRET` | Shared HMAC secret for HTTP flow dispatch. |
| `CODEX_FLOW_BACKEND_EXECUTOR` | `direct` or `systemd-run`. |
| `CODEX_FLOW_BACKEND_DATA_DIR` | Durable backend state directory. |
| `CODEX_FLOW_EVENT_ID` | Event id passed to running Node steps. |
| `CODEX_FLOW_RUN_ID` | Run id passed to running Node steps. |
| `CODEX_FLOW_ATTEMPT_ID` | Attempt identity passed to running Node steps. |
| `CODEX_FLOW_REPLAY` | `1` when the current execution is a replay. |
| `CODEX_FLOW_LAUNCHED_BY` | Runner or backend identity that launched the step. |
