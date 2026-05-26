---
title: CLI reference
description: Commands for turn automation, app-server calls, workspace backend calls, workspace autonomy, memory transplant, thread transplant, and pack repos.
---

# CLI reference

`codex-flows` controls Codex app-server and workspace backend surfaces. The
same package also publishes focused bins for app-server calls and the local
workspace backend.

```bash
codex-flows --help
```

## Fetch

```bash
codex-flows fetch [--json] [--no-color]
codex-flows neofetch [--json] [--no-color]
codex-flows --ssh <target> --cwd <remote-workspace> fetch
```

`fetch` probes the configured workspace backend and app-server endpoints, then
prints local package, runtime, endpoint, workspace, and Codex environment
information. With a reachable backend it also includes capabilities, recent
thread counts, and delegation counts. With `--ssh`, the local CLI probes a
remote workspace backend through SSH and prints the remote workspace cwd while
leaving local credentials alone.

## Remote Control

```bash
codex-flows remote status [--json]
codex-flows --ssh <target> --cwd <remote-workspace> remote preflight [--json]
codex-flows remote tunnel start --ssh <user@tailscale-host> [--dry-run]
codex-flows remote turn start --prompt <text> [--via workspace|app] [--cwd <path>] [--wait]
codex-flows --ssh <target> --cwd <remote-workspace> remote turn start --prompt <text> [--wait]
```

These commands are for the local-Codex-App-to-remote-VPS use case. `remote
status` probes both the local app-server `remoteControl/status/read` method and
the configured workspace backend URL. No backend is a valid status result, not a
fatal setup error. `remote tunnel start` runs an OpenSSH local forward from
`127.0.0.1:<local-port>` to the remote backend address, defaulting to
`127.0.0.1:3586` on both sides. `remote preflight` checks SSH reachability,
remote cwd, remote Node/Codex/backend commands, transient backend startup, and
app-server pass-through. `remote turn start` creates a thread and starts a turn
through the workspace backend tunnel when available. With `--wait`, it polls the
turn until completion and prints the final assistant message. With `--ssh`, it
uses the same transient or existing SSH-backed provider as `fetch`, `workspace`,
`app`, and `automation`.

The global `--ssh` provider is the remote-first automation path. App-server,
workspace backend, automation, and fetch commands can run locally while
targeting a remote workspace:

```bash
codex-flows --ssh devbox --cwd /repo remote preflight
codex-flows --ssh devbox --cwd /repo app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-flows --ssh devbox --cwd /repo workspace delegation.list
codex-flows --ssh devbox --cwd /repo automation run check-release --event event.json
codex-flows --ssh devbox --cwd /repo turn run "Scan current folder" --wait --sandbox danger-full-access --approval-policy never
```

By default the provider starts a transient `codex-workspace-backend-local serve
--local-app-server` on the remote host. Use `--remote-mode existing` only when a
backend is already running and should be reached through an SSH tunnel. Missing
remote binaries produce setup errors; the CLI does not install or copy
credentials to the remote host.

Useful options and environment:

```bash
--workspace-url ws://127.0.0.1:3586
--app-url ws://127.0.0.1:3585
--ssh <user@tailscale-host>
--local-port 3586
--remote-host 127.0.0.1
--remote-port 3586
--remote-mode spawn
--remote-path-prepend /home/me/.local/bin:/home/me/.bun/bin:/home/me/.cargo/bin
--remote-codex-command /home/me/.local/bin/codex
--remote-codex-arg -s --remote-codex-arg danger-full-access
--remote-workspace-backend-command /home/me/.bun/bin/codex-workspace-backend-local

CODEX_FLOWS_REMOTE_SSH_TARGET=<user@tailscale-host>
CODEX_FLOWS_REMOTE_CWD=/repo
CODEX_FLOWS_REMOTE_MODE=spawn
CODEX_FLOWS_REMOTE_TUNNEL_PORT=3586
CODEX_FLOWS_REMOTE_BACKEND_HOST=127.0.0.1
CODEX_FLOWS_REMOTE_BACKEND_PORT=3586
CODEX_FLOWS_REMOTE_PATH_PREPEND=/home/me/.local/bin:/home/me/.bun/bin:/home/me/.cargo/bin
CODEX_FLOWS_REMOTE_CODEX_COMMAND=codex
CODEX_FLOWS_REMOTE_CODEX_ARGS=["-s","danger-full-access"]
CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND=codex-workspace-backend-local
CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_ARGS=["--verbose"]
```

Remote commands run through non-interactive SSH, so login-shell PATH setup may
not apply. Prefer `CODEX_FLOWS_REMOTE_PATH_PREPEND` for remote bin directories
or absolute command overrides. Do not rely on inline `PATH=... command` strings
inside `CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND`; keep command lookup and
remote environment setup separate.

## Turn Run

```bash
codex-flows turn run <prompt> [--wait] [--thread-id <id>]
codex-flows --ssh <target> --cwd <remote-workspace> turn run <prompt> --wait
```

`turn run` is the prompt primitive for local and SSH-backed workspaces. It starts
or reuses a Codex thread, starts a turn, prints the thread and turn ids, and with
`--wait` blocks until the turn completes or the timeout expires. `--sandbox` and
`--permissions` are mutually exclusive. Use `--json` for machine-readable
`threadId`, `turnId`, `status`, `cwd`, `finalMessage`, and `error` output.

## Turn Automation

```bash
codex-flows automation list [--json]
codex-flows automation run <name> [--event <event.json>] [--prompt <text>] [--via workspace|app]
codex-flows --ssh <target> --cwd <remote-workspace> automation run <name> [--event <event.json>]
```

`automation run` executes a pre-turn script and starts a native Codex turn only
when the script returns `{"action":"turn"}`. Automations must be named
manifests under `.codex/automations/*` or `automations/*`. The script exports a
default TypeScript/JavaScript handler that receives `automation`, `runtime`,
optional `event`, optional `prompt`, and optional `cwd` fields.
`automation list` discovers named automations from `.codex/automations/*` and
`automations/*`.

Skip result:

```json
{
  "action": "skip",
  "reason": "nothing changed"
}
```

Turn result:

```json
{
  "action": "turn",
  "prompt": "Inspect this release and prepare the update.",
  "cwd": "/repo"
}
```

The turn is started through the workspace backend or app-server according to
`--via`. With `--ssh`, the script runs locally and the resulting turn targets
the remote workspace through the SSH provider. See [Turn automation](../guides/turn-automation).

## App-Server Calls

```bash
codex-flows app <method> [params-json]
codex-flows app <method> --params-json <json>
codex-flows app <method> --params-file params.json
codex-flows app call <method> [params-json]
echo '<params-json>' | codex-flows app <method>
codex-flows app actions
```

The direct app-server path defaults to `CODEX_WORKSPACE_APP_SERVER_WS_URL` or
`ws://127.0.0.1:3585`. Use `--app-url`, `--app-server-url`, `--url`, or
`--ws-url` to override it. Use `stdio://` to spawn a local app-server. On
PowerShell, prefer `--params-json $params` or `--params-file params.json`:

```powershell
$params = @{ limit = 20; sourceKinds = @() } | ConvertTo-Json -Compress
codex-flows app thread/list --params-json $params

@{ threadId = "019e..." } | ConvertTo-Json -Compress | Set-Content params.json
codex-flows app thread/turns/list --params-file params.json
```

If an older PowerShell native-command mode strips JSON quotes before argv
delivery, `--params-json` also accepts the common stripped shape for simple
objects, for example `{limit:3,sourceKinds:[]}`.

## Workspace Backend Calls

```bash
codex-flows workspace <method> [params-json]
codex-flows workspace <method> --params-json <json>
codex-flows workspace <method> --params-file params.json
codex-flows workspace call <method> [params-json]
codex-flows workspace app <method> [params-json]
codex-flows workspace app <method> --params-json <json>
codex-flows workspace app <method> --params-file params.json
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
codex-flows workspace backend init local [--overwrite] [--json]
codex-flows workspace backend status [--json]
codex-flows workspace backend start [--dry-run] [--json]
codex-flows workspace tick [--mode auto|local|actions]
codex-flows workspace run <task-id> [--mode auto|local|actions]
codex-flows workspace init actions [--forgejo|--github]
```

- `doctor` reports mode, repo root, `.codex/workspace.toml`, runtime
  `CODEX_HOME`, state roots, task counts, due tasks, failing tasks, latest run,
  memory roots, memory summary presence, invariant errors, backend reachability,
  local backend env state, Node version, plugin hook discovery, hook spool
  state, and a suggested next command. In Actions mode it flags any runner that
  would use a Codex home outside the repository `.codex` directory.
- `backend init local` writes `.codex/workspace/backend.local.env`, creates the
  local hook-spool directories, and adds local runtime paths to `.gitignore`.
- `backend status` reports the same local backend, Node, plugin-hook, and
  hook-spool diagnostics without the rest of the workspace autonomy report.
- `backend start` starts `codex-workspace-backend-local serve` in the foreground
  using the local env file. Use `--dry-run` to print the command without
  starting it.
- `tick` runs due scheduled tasks and reactive rules.
- `run <task-id>` runs one task immediately.
- `init actions` scaffolds `.codex/workspace.toml`, `.codex/config.toml`,
  workflow files, and `.gitignore` entries for runtime-only Codex files.

See [Workspace autonomy](../guides/workspace-autonomy) for config, modes, and
CI behavior.

## Actions Helpers

```bash
codex-flows actions prepare-auth
codex-flows actions cleanup
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

`pack inspect` discovers skills, plugins, and hook bundles from a local
directory, GitHub shorthand such as `owner/repo`, or a Git URL. Use
`--ref <ref>` with GitHub shorthand or Git URL sources. Prefer Codex plugin
marketplaces for reusable skills; pack commands are for explicit repo-local file
copies.

`pack add` is dry-run by default and writes only with `--apply`. It installs
repo-local capabilities into `.agents/skills`, `plugins`,
`.agents/plugins/marketplace.json`, `.codex/hooks`, and `.codex/hooks.json`.
Changed destinations and same-name plugin marketplace entries from another source
are conflicts unless `--overwrite` is set; overwrite backs up replaced paths
under `.codex/pack-backups/<timestamp>/`.

`pack list` reads `.codex/pack-lock.json`. `pack doctor` checks the lockfile,
destination paths and content hashes, plugin marketplace JSON, and direct hook JSON. See
[Install pack repos](../guides/install-pack-repos).

## Workspace Backend

```bash
codex-workspace-backend-local serve --cwd <workspace>
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
| `--forgejo` | Generate a Forgejo workflow with `workspace init actions`. |
| `--github` | Generate a GitHub Actions workflow with `workspace init actions`. |
| `--wait` | Wait for `turn run` or `remote turn start` completion and print the final assistant message. |
| `--thread-id <id>` | Reuse an existing thread for `turn run` or `remote turn start`. |
| `--model <model>` | Model override for `turn run` or `remote turn start`. |
| `--params-json <json>` | Explicit JSON params for `app`, `workspace`, or `workspace app` calls; tolerates common PowerShell-stripped object keys. |
| `--params-file <path>` | Read JSON params for `app`, `workspace`, or `workspace app` calls from a file. UTF-8 BOMs are tolerated. |
| `--via <workspace\|app>` | Turn surface for remote turns and automation. Defaults to `workspace`. |
| `--sandbox <danger-full-access\|workspace-write\|read-only>` | Sandbox for `turn run` or `remote turn start`. |
| `--approval-policy <never\|on-failure\|on-request\|untrusted>` | Approval policy for `turn run` or `remote turn start`. |
| `--permissions <profile>` | Named permissions profile for `turn run` or `remote turn start`; cannot be combined with `--sandbox`. |
| `--ssh`, `--ssh-target <target>` | SSH target for remote CodexFlows operation. |
| `--remote-mode <existing\|spawn>` | SSH backend mode. Defaults to `spawn`; `existing` only tunnels to an already-running backend. |
| `--local-port <port>` | Local SSH tunnel port. Defaults to `3586`. |
| `--remote-host <host>` | Remote backend bind host. Defaults to `127.0.0.1`. |
| `--remote-port <port>` | Remote backend port. Defaults to `3586`. |
| `--remote-path-prepend <paths>` | Colon-separated remote PATH entries for non-interactive SSH commands. |
| `--remote-codex-command <cmd>` | Remote Codex command path/name. |
| `--remote-codex-arg <arg>` | Extra remote Codex command arg; repeatable. |
| `--remote-workspace-backend-command <cmd>` | Remote workspace backend command path/name. |
| `--remote-workspace-backend-arg <arg>` | Extra remote backend command arg; repeatable. |
| `--cwd <path>` | Remote workspace cwd when used with `--ssh`. |

## Environment

| Variable | Purpose |
|----------|---------|
| `CODEX_WORKSPACE_APP_SERVER_WS_URL` | Default direct app-server WebSocket URL. |
| `CODEX_WORKSPACE_BACKEND_WS_URL` | Default workspace backend WebSocket URL. |
| `CODEX_WORKSPACE_MODE` | Default workspace autonomy mode: `auto`, `local`, or `actions`. |
| `CODEX_HOME` | Active Codex home. Actions mode sets it to the repo `.codex`. |
| `CODEX_AUTH_JSON_B64` | Base64 JSON auth payload consumed by `actions prepare-auth`. |
| `CODEX_AUTH_JSON` | Raw JSON auth payload consumed by `actions prepare-auth`. |
| `OPENAI_API_KEY` | API key consumed by `actions prepare-auth` when JSON auth is not provided. |
| `CODEX_APP_SERVER_CODEX_COMMAND` | Overrides the Codex command for stdio app-server launches. |
| `CODEX_APP_SERVER_CODEX_ARGS` | JSON string array of extra args prepended before `app-server` for stdio app-server launches. |
| `CODEX_FLOWS_REMOTE_SSH_TARGET` | Default SSH target for remote CodexFlows operation. |
| `CODEX_FLOWS_REMOTE_CWD` | Default remote workspace cwd. |
| `CODEX_FLOWS_REMOTE_MODE` | Default SSH backend mode: `existing` or `spawn`. |
| `CODEX_FLOWS_REMOTE_TUNNEL_PORT` | Default local SSH tunnel port. |
| `CODEX_FLOWS_REMOTE_BACKEND_HOST` | Default remote backend host. |
| `CODEX_FLOWS_REMOTE_BACKEND_PORT` | Default remote backend port. |
| `CODEX_FLOWS_REMOTE_PATH_PREPEND` | Colon-separated remote PATH entries prepended before transient SSH commands. |
| `CODEX_FLOWS_REMOTE_CODEX_COMMAND` | Remote Codex command for transient workspace backend startup or explicit `--via app` turns. |
| `CODEX_FLOWS_REMOTE_CODEX_ARGS` | JSON string array of extra remote Codex command args. |
| `CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND` | Remote workspace backend command for transient SSH backend startup. |
| `CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_ARGS` | JSON string array of extra remote backend command args. |
