---
title: codex-flows
description: App-server clients, flow automation, workspace autonomy, and memory tooling for Codex.
---

# codex-flows

`codex-flows` is the workspace automation layer around Codex app-server. It has
these related surfaces:

- app-server clients and transports for direct Codex thread, auth, and protocol
  work
- generic flow automation built around `FlowEvent`, `flow.toml`, and
  `FLOW_RESULT`
- workspace backend operation for long-running workspace control
- SSH-backed remote workspace operation from a local CLI or Codex App
- repo-native workspace autonomy and Codex memory/thread transplant tools
- Git-backed Codex plugin install for flow authoring skills and bundled
  lifecycle hooks

The project keeps product-specific completion outside the generic layer. Flow
steps can produce results, backends can store and replay runs, and workspace
tools can schedule tasks, but each installing product still owns its own
credentials, domain state, release policy, and final side effects.

## Choose Your Path

| Goal | Start with |
|------|------------|
| Call Codex app-server from TypeScript | [Packages](reference/packages) |
| Inspect or call app-server and workspace backend methods from a terminal | [CLI reference](reference/cli) |
| Build a first reusable flow | [Build your first flow](tutorials/first-flow) |
| Dispatch and replay generic events | [Dispatch and replay events](guides/dispatch-and-replay-events) |
| Run a local flow backend | [Operate the workspace flow backend](guides/operate-workspace-flow-backend) |
| Control a remote backend from a local Codex App | [Install the Codex plugin](guides/install-codex-plugin) and [CLI reference](reference/cli) |
| Schedule repo-local workspace tasks | [Workspace autonomy](guides/workspace-autonomy) |
| Move durable Codex memories between global and repo homes | [Memory transplant](guides/memory-transplant) |
| Move a Codex thread rollout between Codex homes | [Thread transplant](guides/thread-transplant) |
| Install codex-flows skills and hooks into Codex | [Install the Codex plugin](guides/install-codex-plugin) |
| Copy flow bundles or direct hooks into a workspace | [Install pack repos](guides/install-pack-repos) |
| Understand the single-package platform target | [Single package platform](concepts/single-package-platform) |
| Maintain releases | [Operate Codex release flows](guides/operate-codex-release-flows) and `RELEASE.md` |

## Current Package Surface

`@peezy.tech/codex-flows` publishes:

- `@peezy.tech/codex-flows`: Node app-server client and transports
- `@peezy.tech/codex-flows/browser`: browser-safe WebSocket app-server client
- `@peezy.tech/codex-flows/flows`: Codex-backed flow helpers
- `@peezy.tech/codex-flows/auth`: privacy-preserving account status and login helpers
- `@peezy.tech/codex-flows/actions`: Actions-mode workspace helpers
- `@peezy.tech/codex-flows/memories`: stable Codex memory artifact helpers
- `@peezy.tech/codex-flows/workbench`: transport-neutral thread UX reducers and request descriptors
- `@peezy.tech/codex-flows/threads`: raw rollout locate, inspect, install, and transplant helpers
- `@peezy.tech/codex-flows/workspace-backend`: workspace backend protocol helpers and capability primitives
- `@peezy.tech/codex-flows/flow-runtime`: local flow runtime, clients, and Node helpers
- `@peezy.tech/codex-flows/rpc`: JSON-RPC message helpers
- `@peezy.tech/codex-flows/generated`: generated app-server protocol types
- `codex-flows`: CLI for fetch, app-server calls, workspace backend calls,
  remote backend control, flow inspection, workspace autonomy, memory
  transplant, thread transplant, and optional pack repo install
- `codex-workspace-backend-local`: local workspace backend process
- `codex-app`: app-server JSON-RPC utility CLI
- `codex-flow-runner`: local flow runner CLI

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
codex-flows workspace init actions --forgejo --with-smoke --with-agent-turn
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
Install it from GitHub to load codex-flows skills without copying flow packages
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
VPS reached through Tailscale SSH. The compatibility plugin is still available
as `codex-flows`. Source definitions still live in this repo; release syncs
the installable bundles into `peezy-tech/skills`. The bundled hooks live at
`hooks/hooks.json` in the local workspace plugin and are discovered by Codex as
plugin hooks. Pack install remains available when a workspace intentionally
wants file copies, such as pinning a flow bundle into `.codex/flows` or merging
direct hook config.

The CLI can also target an SSH workspace directly:

```bash
codex-flows --ssh devbox --cwd /repo fetch
codex-flows --ssh devbox --cwd /repo app thread/list '{"limit":20,"sourceKinds":[]}'
codex-flows --ssh devbox --cwd /repo flow dispatch --event event.json
```

## Flow Automation In One Screen

Products dispatch generic events:

```json
{
  "id": "patch:upstream.release:openai/codex:rust-v1.2.3",
  "type": "upstream.release",
  "source": "patch",
  "receivedAt": "2026-05-15T00:00:00.000Z",
  "payload": {
    "repo": "openai/codex",
    "tag": "rust-v1.2.3"
  }
}
```

Flow packages match events with `flow.toml` and JSON Schema. Steps run through
the Node runner. Steps can be raw stdin/`FLOW_RESULT` scripts or module-style
handlers that return a result object and, when trusted, call the launching
workspace backend to orchestrate Codex turns.

## Boundaries

- App-server client APIs call Codex thread/auth/protocol methods.
- Flow clients and backends own generic event/run state, replay, cancellation,
  attempts, output, and result payloads.
- Workspace autonomy owns repo-local schedules and generated workspace state
  under `.codex/workspace`.
- Memory transplant owns file-based copies under `memories/` only.
- Thread transplant owns byte-preserving rollout copies under `sessions/` only.
- Plugin install owns Codex-facing skills, bundled hooks, and plugin metadata.
- Pack install owns optional repo-local file copies and `.codex/pack-lock.json`.
- Products own final domain completion, external credentials, deployment policy,
  operator routing policy, and release side effects.
