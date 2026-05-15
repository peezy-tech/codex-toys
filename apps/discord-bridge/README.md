# Codex Discord Bridge

Long-lived Discord sidecar for connecting Discord to Codex app-server threads.

## Gateway Mode

Gateway mode is opt-in. It keeps one Discord home channel as the primary UX and
one main Codex thread as the operator memory for the gateway. Legacy
thread-per-task behavior remains available outside the configured home channel.

Set these environment values before starting the bridge:

```bash
CODEX_DISCORD_HOME_CHANNEL_ID=1502107617512919220
CODEX_DISCORD_MAIN_THREAD_ID=019e2509-ddbb-7380-b97b-41575092d86b
CODEX_DISCORD_WORKSPACE_FORUM_CHANNEL_ID=1502107617512919221
CODEX_DISCORD_TASK_THREADS_CHANNEL_ID=1502107617512919222
CODEX_DISCORD_ALLOWED_CHANNEL_IDS=1502107617512919220
CODEX_DISCORD_DIR=/home/peezy
CODEX_FLOW_BACKEND_URL=http://127.0.0.1:8090
CODEX_DISCORD_HOOK_SPOOL_DIR=/home/peezy/.codex/discord-bridge/stop-hooks
```

`CODEX_DISCORD_MAIN_THREAD_ID` is optional. If omitted, the bridge creates a new
main operator thread, attaches the privileged gateway tools to it, and stores it
in the bridge state file. Existing configured main threads are resumed as-is;
recreate the main operator thread if you need to attach gateway tools to a
thread that predates gateway mode.

In the home channel:

- normal messages are sent to the main operator thread
- bot mentions are treated as gateway messages and do not create Discord task
  threads
- `/status` replies directly with gateway state instead of starting a Codex turn
- `/status` also lists active Codex threads, linking any opened Discord thread
  and offering private buttons to open active threads that are not yet in Discord
- `/goals` is available from workspace forum posts and opens an ephemeral goal
  management picker for that workspace
- `/goals` inside an opened Codex Discord thread manages that specific thread's
  goal; use the slash options to set the objective/status/token budget or clear it

The prompt sent to the main thread uses `[discord-gateway]` framing so the model
knows it is operating as the gateway over the codex-flows backend, not as a
single task thread.

## Delegation Tools

Discord should not become a workspace registry. The main operator thread is the
place where routing decisions happen. Privileged `codex_gateway` dynamic tools
are attached only to that main thread and expose:

- `list_delegations`
- `start_delegation`
- `resume_delegation`
- `send_delegation`
- `read_delegation`
- `set_delegation_policy`
- `flush_delegation_results`
- `list_delegation_groups`
- `list_flow_runs`
- `list_flow_events`

Those tools can:

- list tracked delegated Codex sessions and backend runs/events
- start a delegated Codex session in a requested cwd
- resume a delegated Codex session by thread id
- send a turn to a delegated session
- observe or summarize delegated session state
- group delegations for fan-out/fan-in coordination
- record completed delegation results into the main operator thread
- inspect flow backend state through `CODEX_FLOW_BACKEND_URL`

Gateway state stores delegation records, including optional Discord detail
thread ids for noisy work. Delegated Codex sessions do not receive the privileged
gateway tools; only the main operator thread can manage delegation.

## Workbench Prototype

The gateway can optionally maintain a noisy Discord workbench beside the home
channel. Configure both channels to enable it:

```bash
CODEX_DISCORD_WORKSPACE_FORUM_CHANNEL_ID=1502107617512919221
CODEX_DISCORD_TASK_THREADS_CHANNEL_ID=1502107617512919222
```

The home channel remains the compact operator chat. The workspace forum gets one
post for each discoverable top-level folder under `CODEX_DISCORD_DIR`, which is
the gateway's main workspace root. For the home-folder gateway, set
`CODEX_DISCORD_DIR=/home/peezy`; a delegated cwd such as
`/home/peezy/codex-fork-workspace/codex-flows` maps to the
`/home/peezy/codex-fork-workspace` workspace post. Hidden folders and
`node_modules` are skipped. Workspace posts are compact dashboards that only
show Codex threads already opened into Discord. Run `/threads` in a workspace
post to list all Codex threads for that workspace; the bridge replies with an
ephemeral numbered button picker visible only to the command sender. Choosing a
number opens or reuses one Discord task thread in the task thread channel, and
messages in that Discord thread are routed directly to the opened Codex thread.

When the workbench is enabled:

- `start_delegation` and `resume_delegation` create or reuse the workspace forum
  post for the top-level workspace containing the delegation cwd
- bridge startup creates missing workspace forum posts for discoverable folders
  under the main workspace root
- workspace dashboards list only open Discord task threads for that workspace
- `/threads` lists known Codex threads from `thread/list` plus tracked
  delegations that may not have appeared in the list yet
- choosing an item from the ephemeral `/threads` picker creates or reuses one
  Discord task thread in the task thread channel
- `/status` shows all active Codex threads across workspaces and uses the same
  ephemeral button flow to open active threads without Discord task threads
- `/goals` in workspace forum posts lists recent workspace thread goals and lets
  the command sender mark existing goals active, paused, or complete, clear
  them, or open the thread into Discord
- `/goals` in an opened Discord task thread scopes CRUD to that Codex thread:
  no options reads the current goal, `objective`/`status`/`token_budget` create
  or update it, and `clear` removes it
- repeated delegations in the same cwd reuse the same workspace post and update
  the workspace thread list
- Stop lifecycle events update the workspace dashboard and any already-opened
  task thread
- the home channel receives only compact status/link messages for completed
  delegations
- main-thread injection and wake behavior still follow the delegation return
  mode

If both workbench channels are omitted, the workbench is disabled and the bridge
keeps the legacy home-channel result mirroring behavior. Setting only one
workbench channel is rejected as an invalid partial configuration.

Delegations support return modes:

- `wake_on_done`: inject and mirror the result, then wake the main operator when idle
- `wake_on_group`: inject and mirror each result, then wake once the whole group is terminal
- `record_only`: inject and mirror results without waking the main operator
- `manual`: keep results in gateway state until `flush_delegation_results`
- `detached`: do not loop results back to the main thread; useful for human-continued threads

Automatic result return uses `thread/inject_items` to append structured
delegation results to the main operator thread's model-visible history. Codex
hooks, not background thread polling, drive automatic result return and passive
observability. The global hook writes durable lifecycle events into the spool
directory, and the gateway drains that spool on startup and while running.
Starting a main-thread turn is a separate wake step, so long-running main goals
are not interrupted; wakes are queued until the main operator thread is idle.
For sessions that were not created through the gateway, the same hook stream
updates an observed-thread index used by `/threads`.

## Codex Hooks

Install the global hooks once for the Codex runtime that backs the gateway:

```bash
codex-discord-bridge hook install
```

The bridge and hook default to `~/.codex/discord-bridge/stop-hooks`; override
both with `CODEX_DISCORD_HOOK_SPOOL_DIR` or `--hook-spool-dir` if needed.

The installer enables the current hooks feature in `~/.codex/config.toml`:

```toml
[features]
hooks = true
```

It also registers passive observability hooks in `~/.codex/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "codex-discord-bridge hook event",
            "timeout": 10
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "codex-discord-bridge hook event",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "codex-discord-bridge hook event",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The installer also registers `PreToolUse`, `PermissionRequest`, and
`PostToolUse` with the same command. Those higher-volume events update local
observed-thread metadata such as status, current tool, or waiting reason; they
do not create Discord messages.

For package-on-demand installs, write a `bunx` command instead:

```bash
codex-discord-bridge hook install --bunx
codex-discord-bridge hook install --bunx-package @peezy.tech/codex-flows
```

The hook is intentionally dumb: it does not read gateway state or call the
backend. It only writes idempotent lifecycle-event files and lets Codex
continue. The gateway treats known delegated `Stop` events according to their
return mode, uses main-operator `Stop` events to drain queued wakes, and records
unknown non-main sessions as observed threads. Observed threads are visible from
`/threads` for their workspace and can be opened into the task thread channel
on demand.

After changing hook configuration, restart the Codex runtime that backs the
gateway and trust the hook when Codex asks for review. `hooks/list` should show
the hook as `trusted`; untrusted hooks are discovered but do not run.
