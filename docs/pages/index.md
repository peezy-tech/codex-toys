---
title: codex-toys
description: App-server clients, feed polling, turn automation, workbench autonomy, and memory tooling for Codex.
---

# codex-toys

`codex-toys` is the workbench automation layer around Codex app-server. Its
preferred runtime shape is a Codex workbench toybox: local stdio or SSH stdio. Turn
automation runs code first, then conditionally starts a native Codex prompt
turn. It has these related surfaces:

- app-server clients and stdio transports for direct Codex thread, auth, and
  protocol work
- plugin-native turn automation scripts that can skip or start native turns
- durable feed polling for RSS/Atom signals and cursor-based item collection
- `codex-toys toybox serve` for local and SSH workbench control
- optional `codex-toys-proxy` HTTP edge for freeform dashboards
- first-class workbench delegation into `@/workbenches/*` and `@/repos/*`
- SSH-backed remote workbench operation from a local CLI or Codex App
- repo-native workbench autonomy and Codex memory/thread transplant tools
- Git-backed Codex plugin install for turn automation and toybox guidance

The project keeps product-specific completion outside the automation layer.
Feed tools can ingest external signals and workbench tools can schedule tasks
and start Codex turns, but each installing product still owns its own
credentials, domain state, scoring, release policy, and final side effects.

## Choose Your Path

| Goal | Start with |
|------|------------|
| Call Codex app-server from TypeScript | [Packages](reference/packages) |
| Inspect or call app-server and workbench methods from a terminal | [CLI reference](reference/cli) |
| Build a plain HTML/JS dashboard | [CLI reference](reference/cli#proxy) |
| Poll RSS/Atom sources into durable feed items | [Feed](guides/feed) |
| Run code before deciding whether to start a Codex prompt | [Turn automation](guides/turn-automation) |
| Delegate Codex work from an operator workbench into child workbenches or repos | [CLI reference](reference/cli#workbench-delegation) |
| Control a remote workbench from a local Codex App | [Install the Codex plugin](guides/install-codex-plugin) and [CLI reference](reference/cli) |
| Schedule repo-local workbench tasks | [Workbench autonomy](guides/workbench-autonomy) |
| Move durable Codex memories between global and repo homes | [Memory transplant](guides/memory-transplant) |
| Move a Codex thread rollout between Codex homes | [Thread transplant](guides/thread-transplant) |
| Install codex-toys skills into Codex | [Install the Codex plugin](guides/install-codex-plugin) |
| Copy skills, plugins, or automations into a workbench | [Install kit repos](guides/install-kit-repos) |
| Understand the package boundaries | [Package stack](concepts/package-stack) |
| Maintain releases | `RELEASE.md` |

## Current Package Surface

The public npm package is `codex-toys`. Its self-contained runtime surfaces are
split by feature boundary and exposed as subpath imports:

- `codex-toys/bridge`: native Codex app-server, auth, memory, thread, JSON,
  and generated protocol bridge primitives
- `codex-toys/toybox`: stdio JSON-RPC toybox protocol, client, and server
- `codex-toys/feed`: durable RSS/Atom polling, source checkpoints, feed items, and
  collection cursors
- `codex-toys/workbench`: workbench runtime, delegation, prompt queue,
  handoff, functions, automation, and overview primitives
- `codex-toys/actions`: Actions-mode auth and state helpers
- `codex-toys/remote`: SSH-backed toybox transports and remote control helpers
- `codex-toys/proxy`: optional HTTP proxy, browser client, Vite middleware,
  and `codex-toys-proxy`
- `codex-toys/kits`: kit inspect/add/list/doctor helpers
- `codex-toys`: CLI package and umbrella runtime export

## Turn Automation In One Screen

Turn automation runs a local script before deciding whether to start a native
Codex turn:

```bash
codex-toys automation list
codex-toys automation run openai-codex-bindings --event event.json
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

Automation scripts running through a codex-toys toybox can also start a
delegated thread with `context.delegate.start({ cwd: "@/workbenches/name",
prompt })` when the work belongs in another checkout.

The SSH provider runs the automation inside the remote workbench:

```bash
codex-toys --ssh devbox --cwd /repo automation run openai-codex-bindings --event event.json
```

## Workbench Autonomy In One Screen

Workbench control config lives at `.codex/workbench.toml`:

```toml
[workbench]
name = "meta-workbench"

[[workbench.tasks]]
id = "morning-brief"
enabled = true
kind = "skill"
skill = "morning-brief"
schedule = "0 14 * * *"
var = "workbench status"
```

Run it locally without changing your active Codex home:

```bash
codex-toys workbench doctor
codex-toys workbench tick --mode local
codex-toys workbench prompt enqueue "Review this branch later." --queue low-priority --effort low
codex-toys workbench prompt run-due --queue low-priority --limit 1
codex-toys workbench prompt collect --queue low-priority --json
codex-toys workbench handoff enqueue "Run the local browser smoke." --capability browser
codex-toys workbench handoff drain --capability browser --materialize --prompt-queue local-followups
codex-toys workbench deferred list --json
codex-toys workbench deferred pull <intent-id> --json
codex-toys workbench deferred collect --cursor operator --json
codex-toys workbench deferred prune --older-than-days 30 --dry-run
```

Run it in CI with the repo `.codex` home:

```bash
codex-toys actions prepare-auth
codex-toys workbench tick --mode actions
codex-toys actions cleanup
```

Scaffold an Actions-ready workbench with:

```bash
codex-toys workbench init actions --forgejo
```

Local generated state goes under `.codex/workbench/local`. Actions generated
state goes under `.codex/workbench/actions`, durable Actions thread rollouts go
under `.codex/sessions`, and Actions mode always runs with
`CODEX_HOME=<repo>/.codex`.

Deferred runs add durable future run intents in those same mode-specific roots.
They can wrap a direct Codex turn, a named turn automation, or a configured
workbench task, and scheduled tasks now flow through the same intent/attempt
inspection path. The recommended next work is tracked in
[`Deferred Runs Roadmap`](concepts/deferred-runs-roadmap.md).

## Memory Transplant In One Screen

Memory transplant is dry-run by default:

```bash
codex-toys memories transplant global-to-workbench
codex-toys memories transplant workbench-to-global
```

Apply only after reviewing the plan:

```bash
codex-toys memories transplant global-to-workbench --apply
```

The command copies only durable Codex memory artifacts:
`MEMORY.md`, `memory_summary.md`, `raw_memories.md`, and
`rollout_summaries/*.md`. It skips auth, logs, sessions, sqlite databases,
skills, `.git`, generated extension machinery, and other runtime internals.

## Thread Transplant In One Screen

Thread transplant moves one Codex thread rollout between Codex homes:

```bash
codex-toys threads locate <thread-id> --codex-home ~/.codex
codex-toys threads transplant <thread-id> --from-codex-home ~/.codex --to-codex-home ~/.codex --cwd "$PWD"
```

Transplant preserves the thread id and original `sessions/.../rollout-*.jsonl`
path, and rewrites the thread metadata cwd to the destination project so Codex
App can show the imported thread there. It fails on conflicts unless `--replace`
is provided. Pass `--preserve-cwd` for byte-exact archival copies.

## Plugin Install In One Screen

The shared Peezy Tech marketplace is the normal Codex plugin install surface.
Install it from GitHub to load codex-toys skills without copying runtime files
into your workbench:

```bash
codex plugin marketplace add peezy-tech/skills --ref main
codex plugin add codex-toys-author@peezy-tech
codex plugin add codex-toys-local-workbench@peezy-tech
codex plugin add codex-toys-remote-control@peezy-tech
```

For local development against this product checkout, add the checkout root as
a product-local marketplace. Install only the granular plugin you are testing,
then reinstall or upgrade it after marketplace, plugin, or skill edits and
start a new thread:

```bash
codex plugin marketplace add /home/peezy/repos/codex-toys
codex plugin add codex-toys-local-workbench@codex-toys
```

Install `codex-toys-remote-control` on a local Codex App when the toybox runs on
a VPS reached through Tailscale SSH. The full root plugin is still available as
`codex-toys` for whole-product development, but the local
marketplace should otherwise feel like the external marketplace: choose,
install, upgrade, or uninstall the plugin surface you actually need. Source
definitions still live in this repo; release syncs the installable bundles into
`peezy-tech/skills`. Kit install remains available when a workbench
intentionally wants file copies, such as pinning a skill or copying automation
templates.

The CLI can also target an SSH workbench directly:

```bash
codex-toys --ssh devbox --cwd /repo fetch
codex-toys --ssh devbox --cwd /repo app thread/list '{"limit":20,"sourceKinds":[]}'
codex-toys --ssh devbox --cwd /repo automation run openai-codex-bindings --event event.json
```

## Boundaries

- App-server client APIs call Codex thread/auth/protocol methods.
- Turn automation owns pre-turn script execution and conditional native turn
  starts.
- Workbench autonomy owns repo-local schedules and generated workbench state
  under `.codex/workbench`.
- Memory transplant owns file-based copies under `memories/` only.
- Thread transplant owns byte-preserving rollout copies under `sessions/` only.
- Plugin install owns Codex-facing skills and plugin metadata.
- Kit install owns optional repo-local file copies and `.codex/kit-lock.json`.
- Products own final domain completion, external credentials, deployment policy,
  operator routing policy, and release side effects.
