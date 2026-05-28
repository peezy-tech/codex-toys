---
title: codex-flows
description: App-server clients, turn automation, workspace autonomy, and memory tooling for Codex.
---

# codex-flows

`codex-flows` is the workspace automation layer around Codex app-server. Its
preferred automation shape is turn automation: run code first, then
conditionally start a native Codex prompt turn. It has these related surfaces:

- app-server clients and transports for direct Codex thread, auth, and protocol
  work
- plugin-native turn automation scripts that can skip or start native turns
- workspace backend operation for long-running workspace control
- SSH-backed remote workspace operation from a local CLI or Codex App
- repo-native workspace autonomy and Codex memory/thread transplant tools
- Git-backed Codex plugin install for turn automation guidance and bundled
  lifecycle hooks

The project keeps product-specific completion outside the automation layer.
Workspace tools can schedule tasks and start Codex turns, but each installing
product still owns its own credentials, domain state, release policy, and final
side effects.

## Choose Your Path

| Goal | Start with |
|------|------------|
| Call Codex app-server from TypeScript | [Packages](reference/packages) |
| Inspect or call app-server and workspace backend methods from a terminal | [CLI reference](reference/cli) |
| Run code before deciding whether to start a Codex prompt | [Turn automation](guides/turn-automation) |
| Control a remote workspace from a local Codex App | [Install the Codex plugin](guides/install-codex-plugin) and [CLI reference](reference/cli) |
| Schedule repo-local workspace tasks | [Workspace autonomy](guides/workspace-autonomy) |
| Move durable Codex memories between global and repo homes | [Memory transplant](guides/memory-transplant) |
| Move a Codex thread rollout between Codex homes | [Thread transplant](guides/thread-transplant) |
| Install codex-flows skills and hooks into Codex | [Install the Codex plugin](guides/install-codex-plugin) |
| Copy skills, plugins, or direct hooks into a workspace | [Install pack repos](guides/install-pack-repos) |
| Understand the single-package platform target | [Single package platform](concepts/single-package-platform) |
| Maintain releases | `RELEASE.md` |

## Current Package Surface

`@peezy.tech/codex-flows` publishes:

- `@peezy.tech/codex-flows`: Node app-server client and transports
- `@peezy.tech/codex-flows/browser`: browser-safe WebSocket app-server client
- `@peezy.tech/codex-flows/auth`: privacy-preserving account status and login helpers
- `@peezy.tech/codex-flows/actions`: Actions-mode workspace helpers
- `@peezy.tech/codex-flows/memories`: stable Codex memory artifact helpers
- `@peezy.tech/codex-flows/workbench`: transport-neutral thread UX reducers and request descriptors
- `@peezy.tech/codex-flows/threads`: raw rollout locate, inspect, install, and transplant helpers
- `@peezy.tech/codex-flows/workspace-backend`: workspace backend protocol helpers and capability primitives
- `@peezy.tech/codex-flows/rpc`: JSON-RPC message helpers
- `@peezy.tech/codex-flows/generated`: generated app-server protocol types
- `codex-flows`: CLI for fetch, app-server calls, workspace backend calls,
  turn automation, remote workspace control, workspace autonomy, memory
  transplant, thread transplant, and optional pack repo install
- `codex-workspace-backend-local`: local workspace backend process
- `codex-app`: app-server JSON-RPC utility CLI

## Turn Automation In One Screen

Turn automation runs a local script before deciding whether to start a native
Codex turn:

```bash
codex-flows automation list
codex-flows automation run openai-codex-bindings --event event.json
```

The script can return a skip-like result:

```json
{
  "status": "skipped",
  "reason": "nothing changed"
}
```

Or start a native turn through `context.turn.start` and return the turn
metadata:

```json
{
  "status": "started",
  "turn": {
    "threadId": "019...",
    "turnId": "019..."
  }
}
```

The SSH provider runs the automation inside the remote workspace:

```bash
codex-flows --ssh devbox --cwd /repo automation run openai-codex-bindings --event event.json
```

## Workspace Autonomy In One Screen

Workspace control config lives at `.codex/workspace.toml`:

```toml
[workspace]
name = "meta-workspace"

[[workspace.tasks]]
id = "morning-brief"
enabled = true
kind = "skill"
skill = "morning-brief"
schedule = "0 14 * * *"
var = "workspace status"
```

Run it locally without changing your active Codex home:

```bash
codex-flows workspace doctor
codex-flows workspace tick --mode local
```

Run it in CI with the repo `.codex` home:

```bash
codex-flows actions prepare-auth
codex-flows workspace tick --mode actions
codex-flows actions cleanup
```

Scaffold an Actions-ready workspace with:

```bash
codex-flows workspace init actions --forgejo
```

Local generated state goes under `.codex/workspace/local`. Actions generated
state goes under `.codex/workspace/actions`, and Actions mode always runs with
`CODEX_HOME=<repo>/.codex`.

## Memory Transplant In One Screen

Memory transplant is dry-run by default:

```bash
codex-flows memories transplant global-to-workspace
codex-flows memories transplant workspace-to-global
```

Apply only after reviewing the plan:

```bash
codex-flows memories transplant global-to-workspace --apply
```

The command copies only durable Codex memory artifacts:
`MEMORY.md`, `memory_summary.md`, `raw_memories.md`, and
`rollout_summaries/*.md`. It skips auth, logs, sessions, sqlite databases,
skills, `.git`, generated extension machinery, and other runtime internals.

## Thread Transplant In One Screen

Thread transplant moves one Codex thread rollout between Codex homes:

```bash
codex-flows threads locate <thread-id> --codex-home ~/.codex
codex-flows threads transplant <thread-id> --from-codex-home ~/.codex --to-codex-home ./workspace/.codex
```

Transplant preserves the thread id, rollout bytes, checksum, and original
`sessions/.../rollout-*.jsonl` path. It fails on conflicts unless `--replace`
is provided. Native rollout inspect and install commands cover validation and
loose-file import without introducing a separate bundle format.

## Plugin Install In One Screen

The shared Peezy Tech marketplace is the normal Codex plugin install surface.
Install it from GitHub to load codex-flows skills without copying runtime files
into your workspace. Install the local workspace plugin when you want
plugin-bundled lifecycle hooks:

```bash
codex plugin marketplace add peezy-tech/skills --ref main
codex plugin add codex-flows-author@peezy-tech
codex plugin add codex-flows-local-workspace@peezy-tech
codex plugin add codex-flows-remote-control@peezy-tech
```

For local development against this product checkout, add the checkout root:

```bash
codex plugin marketplace add /home/peezy/meta-workspace/codex-flows
codex plugin add codex-flows-local-workspace@codex-flows
```

Install `codex-flows-remote-control` on a local Codex App when the backend is a
VPS reached through Tailscale SSH. The full plugin is still available as
`codex-flows`. Source definitions still live in this repo; release syncs the
installable bundles into `peezy-tech/skills`. The bundled hooks live at
`hooks/hooks.json` in the local workspace plugin and are discovered by Codex as
plugin hooks. Pack install remains available when a workspace intentionally
wants file copies, such as pinning a skill or merging direct hook config.

The CLI can also target an SSH workspace directly:

```bash
codex-flows --ssh devbox --cwd /repo fetch
codex-flows --ssh devbox --cwd /repo app thread/list '{"limit":20,"sourceKinds":[]}'
codex-flows --ssh devbox --cwd /repo automation run openai-codex-bindings --event event.json
```

## Boundaries

- App-server client APIs call Codex thread/auth/protocol methods.
- Turn automation owns pre-turn script execution and conditional native turn
  starts.
- Workspace autonomy owns repo-local schedules and generated workspace state
  under `.codex/workspace`.
- Memory transplant owns file-based copies under `memories/` only.
- Thread transplant owns byte-preserving rollout copies under `sessions/` only.
- Plugin install owns Codex-facing skills, bundled hooks, and plugin metadata.
- Pack install owns optional repo-local file copies and `.codex/pack-lock.json`.
- Products own final domain completion, external credentials, deployment policy,
  operator routing policy, and release side effects.
