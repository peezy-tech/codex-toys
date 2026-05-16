---
title: CLI reference
description: Commands for app-server calls, workspace backend calls, flow inspection, workspace autonomy, and memory transplant.
---

# CLI reference

`codex-flows` controls Codex app-server and workspace backend surfaces.

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
```

- `doctor` reports mode, repo root, `.codex/workspace.toml`, runtime
  `CODEX_HOME`, state roots, task counts, due tasks, failing tasks, latest run,
  memory roots, memory summary presence, and backend reachability.
- `tick` runs due scheduled tasks and reactive rules.
- `run <task-id>` runs one task immediately.

See [Workspace autonomy](../guides/workspace-autonomy) for config, modes, and
CI behavior.

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

The monorepo also has a source runner script for local flow packages:

```bash
bun run flow list
bun run flow fire --event event.json
bun run flow run <flow> <step> --event event.json
```

`flow fire` dispatches through the local client and runs every step whose
trigger type and schema match the event.

`flow run` also accepts run metadata used by workspace backend launches:

```bash
bun run flow run <flow> <step> --event event.json \
  --run-id run_123 \
  --attempt-id run_123 \
  --workspace-backend-url ws://127.0.0.1:3586
```

## Workspace Flow Backend

```bash
bun run flow:backend serve --cwd <workspace>
bun run flow:backend list-events --limit 20
bun run flow:backend show-event <event-id>
bun run flow:backend list-runs --status failed --limit 20
bun run flow:backend show-run <run-id>
bun run flow:backend replay-event <event-id> --wait
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
| `--apply` | Apply memory transplant changes. |
| `--overwrite` | Replace destination memory files after backup. |
| `--merge codex` | Merge `MEMORY.md` and `memory_summary.md` with Codex. |
| `--no-backup` | Disable overwrite or merge backups. |

## Environment

| Variable | Purpose |
|----------|---------|
| `CODEX_WORKSPACE_APP_SERVER_WS_URL` | Default direct app-server WebSocket URL. |
| `CODEX_WORKSPACE_BACKEND_WS_URL` | Default workspace backend WebSocket URL. |
| `CODEX_WORKSPACE_MODE` | Default workspace autonomy mode: `auto`, `local`, or `actions`. |
| `CODEX_HOME` | Active Codex home. Actions mode sets it to the repo `.codex`. |
| `CODEX_FLOWS_MODE=code-mode` | Enables Code Mode flow steps and Peezy Codex defaults. |
| `CODEX_APP_SERVER_CODEX_COMMAND` | Overrides the Codex command for stdio app-server launches. |
| `CODEX_FLOW_BACKEND_URL` | HTTP backend URL for consumers such as Discord bridge inspection. |
| `CODEX_FLOW_BACKEND_SECRET` | Shared HMAC secret for HTTP flow dispatch. |
| `CODEX_FLOW_BACKEND_EXECUTOR` | `direct` or `systemd-run`. |
| `CODEX_FLOW_BACKEND_DATA_DIR` | Durable backend state directory. |
| `CODEX_FLOW_EVENT_ID` | Event id passed to running Bun steps. |
| `CODEX_FLOW_RUN_ID` | Run id passed to running Bun steps. |
| `CODEX_FLOW_ATTEMPT_ID` | Attempt identity passed to running Bun steps. |
| `CODEX_FLOW_REPLAY` | `1` when the current execution is a replay. |
| `CODEX_FLOW_LAUNCHED_BY` | Runner or backend identity that launched the step. |
