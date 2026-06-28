---
title: codex-toys
description: Primitive-first documentation for codex-toys workflow, runtime, feed, templates, and Codex state helpers.
---

# codex-toys

`codex-toys` is a small workspace layer around native Codex. Native Codex owns
threads, turns, app UI, plugins, skills, hooks, auth, model settings, and app
automations. `codex-toys` owns workspace templates, workspace functions,
workflow execution, feed intake, explicit queues, Actions/runtime scaffolding,
runtime transports, and Codex state utilities.

The public npm package is `codex-toys`. Internal `@codex-toys/*` packages are
implementation boundaries that are embedded into the public tarball and exposed
through focused `codex-toys/*` subpaths.

## Primitive Map

| Primitive | Owns | Start here |
|-----------|------|------------|
| Workflow | A script that inspects state and can start, read, or wait on native Codex turns. | [Workflow](primitives/workflow) |
| Workbench | Repo-local config, modes, explicit tasks, functions, health, and overview. | [Workbench](primitives/workbench) |
| Dispatch And Queues | Durable future intents, prompt queues, handoff queues, attempts, and collection. | [Dispatch and queues](primitives/dispatch-queues) |
| Feed | RSS/Atom and manual intake, item storage, cursors, and ack-aware dispatch. | [Feed](primitives/feed) |

## Components

| Component | Owns | Start here |
|-----------|------|------------|
| Runtime | Local stdio, SSH stdio, and optional HTTP/browser transport over the same app/workbench/function methods. | [Runtime](components/runtime) |
| Kits | Workspace templates installed from local or Git sources. | [Kits](components/kits) |
| CLI | Command porcelain over primitives and components. | [CLI](components/cli) |

## Guides

| Guide | Use it when |
|-------|-------------|
| [Repository autonomy](guides/repository-autonomy) | A repo should run its workbench on a GitHub Actions schedule and commit durable Codex state back to itself. |
| [Remote runtime](guides/remote-runtime) | A VPS or SSH host should run Codex work while local commands control it over SSH stdio. |
| [Local scheduled workbench](guides/local-scheduled-workbench) | A trusted local machine should run explicit workbench or feed commands on systemd user timers. |
| [Dashboard over runtime](guides/dashboard-over-runtime) | A browser UI should inspect or operate a local or SSH-backed workspace through the runtime HTTP edge. |
| [Feed to workflow](guides/feed-to-workflow) | RSS or Atom items should dispatch into workflow-backed workbench tasks. |
| [Capability kit setup](guides/capability-kit-setup) | A workspace should install checked-in local templates from a kit. |

## Operations

| Operation | Owns | Start here |
|-----------|------|------------|
| Codex State | Memory and thread rollout moves between Codex homes. | [Codex state](operations/codex-state) |
| Plugins | Codex plugin install surfaces for codex-toys guidance. | [Plugins](operations/plugins) |

## First Commands

```bash
codex-toys fetch
codex-toys runtime serve --cwd <workspace>
codex-toys runtime http --cwd <workspace> --static ./dashboard
codex-toys workflow list
codex-toys workflow run <name> --event event.json
codex-toys workbench doctor
codex-toys functions list --json
codex-toys feed poll --json
codex-toys workbench prompt enqueue "Review this later."
codex-toys workbench dispatch list --json
```

Run the same workspace over SSH without opening a remote port:

```bash
codex-toys --ssh <target> --cwd <remote-workspace> fetch
codex-toys --ssh <target> --cwd <remote-workspace> runtime preflight --json
codex-toys --ssh <target> --cwd <remote-workspace> workflow run <name> --event event.json
codex-toys --ssh <target> --cwd <remote-workspace> functions list --json
codex-toys --ssh <target> --cwd <remote-workspace> turn run "Scan current folder" --wait
```

## Runtime Shape

Local CLI commands spawn `codex-toys runtime serve` over stdio when they need
workspace methods. SSH commands start that same stdio runtime on the remote
host and speak JSON-RPC over SSH stdio. Browser dashboards opt into HTTP with
`codex-toys runtime http`, which forwards generic app, workbench, and function
calls to the runtime instead of creating a second product API.

## Boundary

`codex-toys` owns reusable mechanics:

- Codex app-server bridge helpers
- runtime transport and method metadata
- workflow script execution and host helpers
- feed intake and cursor state
- workbench tasks, functions, queues, and overview
- memory and thread rollout file moves
- kit inspection and workspace-template installation

Installing products own domain completion: credentials, source catalogs, scoring,
prompt policy, deployment decisions, branch or release policy, external writes,
and product dashboards.

## Install Surfaces

Install the CLI/runtime package from npm:

```bash
npm install codex-toys
```

Install Codex-facing guidance from the shared plugin marketplace:

```bash
codex plugin marketplace add peezy-tech/skills --ref main
codex plugin add codex-toys-author@peezy-tech
codex plugin add codex-toys-local-workspace@peezy-tech
codex plugin add codex-toys-remote-control@peezy-tech
```

Use kits only when a workspace intentionally wants repo-local templates.
