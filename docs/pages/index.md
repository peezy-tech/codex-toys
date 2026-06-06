---
title: codex-toys
description: Primitive-first documentation for codex-toys workflow, workbench, feed, components, guides, and Codex state helpers.
---

# codex-toys

`codex-toys` is a workbench layer for Codex. It gives a repository or operator
process a small set of primitives for running code before Codex turns, operating
local or SSH-backed workbenches, ingesting external or manual feed signals,
dispatching durable work, and moving durable Codex state between homes.

The public npm package is `codex-toys`. Internal `@codex-toys/*` packages are
feature boundaries that are embedded into the public tarball and exposed through
`codex-toys/*` subpaths.

## Primitive Map

| Primitive | Owns | Start here |
|-----------|------|------------|
| Workflow | A script that inspects state and can start, read, wait on, or delegate Codex turns. | [Workflow](primitives/workflow) |
| Workbench | Repo-local config, modes, explicit tasks, functions, health, and overview. | [Workbench](primitives/workbench) |
| Delegation | Starting and tracking Codex work in another workbench-relative cwd. | [Delegation](primitives/delegation) |
| Dispatch And Queues | Durable future intents, prompt queues, handoff queues, attempts, and collection. | [Dispatch and queues](primitives/dispatch-queues) |
| Feed | RSS/Atom and manual intake, item storage, cursors, and ack-aware dispatch. | [Feed](primitives/feed) |

## Components

| Component | Owns | Start here |
|-----------|------|------------|
| Toybox | The stdio JSON-RPC workbench control surface used locally and over SSH. | [Toybox](components/toybox) |
| Proxy | Optional HTTP edge for browser dashboards. | [Proxy](components/proxy) |
| Kits | Repo-local copies of skills, plugins, and workflow templates. | [Kits](components/kits) |
| CLI | Command porcelain over primitives and components. | [CLI](components/cli) |

## Guides

| Guide | Use it when |
|-------|-------------|
| [Repository autonomy](guides/repository-autonomy) | A repo should run its workbench on a GitHub Actions schedule and commit durable Codex state back to itself. |
| [Remote Codex workbench](guides/remote-codex-workbench) | A VPS or SSH host should run a separate Codex workbench controlled from local commands. |
| [Local scheduled workbench](guides/local-scheduled-workbench) | A trusted local machine should run explicit workbench or feed commands on systemd user timers. |
| [Dashboard over toybox](guides/dashboard-over-toybox) | A browser UI should inspect or operate a local or SSH-backed workbench through the proxy. |
| [Feed to workflow](guides/feed-to-workflow) | RSS or Atom items should dispatch into workflow-backed workbench tasks. |
| [Capability kit setup](guides/capability-kit-setup) | A workbench should install checked-in local skills, plugins, or workflows from a kit. |
| [Delegated repo work](guides/delegated-repo-work) | A controlling workbench should start and track Codex work in another checkout. |

## Operations

| Operation | Owns | Start here |
|-----------|------|------------|
| Codex State | Memory and thread rollout moves between Codex homes. | [Codex state](operations/codex-state) |
| Plugins | Codex plugin install surfaces for codex-toys guidance. | [Plugins](operations/plugins) |

## First Commands

```bash
codex-toys fetch
codex-toys toybox serve --cwd <workbench>
codex-toys workflow list
codex-toys workflow run <name> --event event.json
codex-toys workbench doctor
codex-toys feed poll --json
codex-toys workbench prompt enqueue "Review this later."
codex-toys workbench dispatch list --json
```

Run the same workbench over SSH without opening a remote port:

```bash
codex-toys --ssh <target> --cwd <remote-workbench> fetch
codex-toys --ssh <target> --cwd <remote-workbench> workflow run <name> --event event.json
codex-toys --ssh <target> --cwd <remote-workbench> workbench dispatch collect --cursor operator --json
```

## Runtime Shape

Local CLI commands spawn `codex-toys toybox serve` over stdio when they need
workbench methods. SSH commands start that same toybox on the remote host and
speak JSON-RPC over SSH stdio. Core commands do not expose HTTP or WebSocket
servers.

Browser dashboards opt into HTTP explicitly with `codex-toys-proxy`. The proxy
forwards generic app and workbench calls to the toybox instead of creating a
second product model.

## Boundary

`codex-toys` owns reusable mechanics:

- Codex app-server bridge helpers
- toybox transport and method metadata
- workflow script execution and host helpers
- feed intake and cursor state
- workbench tasks, functions, queues, delegation, and overview
- memory and thread rollout file moves
- kit inspection and repo-local installation

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
codex plugin add codex-toys-local-workbench@peezy-tech
codex plugin add codex-toys-remote-control@peezy-tech
```

Use kits only when a workbench intentionally wants repo-local copies of skills,
plugins, or workflow templates.
