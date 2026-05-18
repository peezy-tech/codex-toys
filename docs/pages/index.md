---
title: codex-flows
description: App-server clients, flow automation, workspace autonomy, and memory tooling for Codex.
---

# codex-flows

`codex-flows` is the workspace automation layer around Codex app-server. It has
four related surfaces:

- app-server clients and transports for direct Codex thread, auth, and protocol
  work
- generic flow automation built around `FlowEvent`, `flow.toml`, and
  `FLOW_RESULT`
- workspace backend and Discord operation for long-running workspace control
- repo-native workspace autonomy and Codex memory/thread transplant tools
- repo-local pack installation for skills, flows, plugins, and hooks

The project keeps product-specific completion outside the generic layer. Flow
steps can produce results, backends can store and replay runs, and workspace
tools can schedule tasks, but each installing product still owns its own
credentials, domain state, release policy, and final side effects.

## Choose Your Path

| Goal | Start with |
|------|------------|
| Call Codex app-server from TypeScript or Bun | [Packages](reference/packages) |
| Inspect or call app-server and workspace backend methods from a terminal | [CLI reference](reference/cli) |
| Build a first reusable flow | [Build your first flow](tutorials/first-flow) |
| Dispatch and replay generic events | [Dispatch and replay events](guides/dispatch-and-replay-events) |
| Run a local flow backend | [Operate the workspace flow backend](guides/operate-workspace-flow-backend) |
| Schedule repo-local workspace tasks | [Workspace autonomy](guides/workspace-autonomy) |
| Move durable Codex memories between global and repo homes | [Memory transplant](guides/memory-transplant) |
| Move a Codex thread rollout between Codex homes | [Thread transplant](guides/thread-transplant) |
| Install reusable skills, flows, plugins, and hooks into a workspace | [Install pack repos](guides/install-pack-repos) |
| Operate Discord over the workspace backend | [Discord bridge](reference/discord-bridge) |
| Broadcast workspace updates into Discord voice | [Workspace voice gateway](reference/workspace-voice-gateway) |
| Understand the single-package platform target | [Single package platform](concepts/single-package-platform) |
| Maintain releases | [Operate Codex release flows](guides/operate-codex-release-flows) and `RELEASE.md` |

## Current Package Surface

`@peezy.tech/codex-flows` publishes:

- `@peezy.tech/codex-flows`: Node/Bun app-server client and transports
- `@peezy.tech/codex-flows/browser`: browser-safe WebSocket app-server client
- `@peezy.tech/codex-flows/flows`: Codex-backed flow helpers
- `@peezy.tech/codex-flows/auth`: privacy-preserving account status and login helpers
- `@peezy.tech/codex-flows/actions`: Actions-mode workspace helpers
- `@peezy.tech/codex-flows/memories`: stable Codex memory artifact helpers
- `@peezy.tech/codex-flows/workbench`: transport-neutral thread UX reducers and request descriptors
- `@peezy.tech/codex-flows/threads`: raw rollout locate, inspect, install, and transplant helpers
- `@peezy.tech/codex-flows/workspace-backend`: workspace backend protocol helpers and capability primitives
- `@peezy.tech/codex-flows/flow-runtime`: local flow runtime, clients, and Bun helpers
- `@peezy.tech/codex-flows/rpc`: JSON-RPC message helpers
- `@peezy.tech/codex-flows/generated`: generated app-server protocol types
- `codex-flows`: CLI for fetch, app-server calls, workspace backend calls,
  flow inspection, workspace autonomy, memory transplant, thread transplant,
  and pack repo install
- `codex-workspace-backend-local`: local workspace backend process
- `codex-app`: app-server JSON-RPC utility CLI
- `codex-flow-runner`: local flow runner CLI

Discord text and voice integrations are gateway packages/apps that consume
`@peezy.tech/codex-flows`; they are not bundled into the core package.

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

## Pack Install In One Screen

Pack repos collect reusable Codex capabilities for installation into a workspace
repo. Inspect first:

```bash
codex-flows pack inspect owner/repo
codex-flows pack add owner/repo --include tdd
```

Apply only after reviewing the dry-run:

```bash
codex-flows pack add owner/repo --include tdd --apply
```

Installs stay repo-local: skills go to `.agents/skills`, flows to
`.codex/flows`, plugins to `plugins` plus `.agents/plugins/marketplace.json`,
and direct hooks to `.codex/hooks` plus `.codex/hooks.json`.

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

Flow packages match events with `flow.toml` and JSON Schema. Steps run through a
Bun runner or a gated Code Mode runner. Bun steps can be raw
stdin/`FLOW_RESULT` scripts or module-style handlers that return a result object
and, when trusted, call the launching workspace backend to orchestrate Codex
turns.

## Boundaries

- App-server client APIs call Codex thread/auth/protocol methods.
- Flow clients and backends own generic event/run state, replay, cancellation,
  attempts, output, and result payloads.
- Workspace autonomy owns repo-local schedules and generated workspace state
  under `.codex/workspace`.
- Memory transplant owns file-based copies under `memories/` only.
- Thread transplant owns byte-preserving rollout copies under `sessions/` only.
- Pack install owns repo-local capability copies and `.codex/pack-lock.json`.
- Products own final domain completion, external credentials, deployment policy,
  Discord routing policy, and release side effects.
