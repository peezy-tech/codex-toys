# codex-toys

Codex bridge, toybox, feed, remote, workbench, Actions, proxy, kits, and CLI tools.

This repository is a monorepo. The only public npm package is `codex-toys`;
reusable runtime surfaces are exported from subpaths such as
`codex-toys/bridge`, `codex-toys/feed`, `codex-toys/workbench`, and
`codex-toys/proxy`.
The scoped `@codex-toys/*` workspaces are internal package boundaries that are
bundled into the published tarball.
The full user documentation lives in the Tome docs site under
[`docs/pages`](docs/pages).

## Start Here

- New users: read [`docs/pages/index.md`](docs/pages/index.md).
- Workflow: [`docs/pages/primitives/workflow.md`](docs/pages/primitives/workflow.md).
- Toybox: [`docs/pages/primitives/toybox.md`](docs/pages/primitives/toybox.md).
- Workbench: [`docs/pages/primitives/workbench.md`](docs/pages/primitives/workbench.md).
- Delegation: [`docs/pages/primitives/delegation.md`](docs/pages/primitives/delegation.md).
- Deferred queues: [`docs/pages/primitives/deferred-queues.md`](docs/pages/primitives/deferred-queues.md).
- Feed: [`docs/pages/primitives/feed.md`](docs/pages/primitives/feed.md).
- Proxy: [`docs/pages/primitives/proxy.md`](docs/pages/primitives/proxy.md).
- Kits: [`docs/pages/primitives/kits.md`](docs/pages/primitives/kits.md).
- Codex state moves: [`docs/pages/operations/codex-state.md`](docs/pages/operations/codex-state.md).
- Plugins: [`docs/pages/operations/plugins.md`](docs/pages/operations/plugins.md).
- CLI reference: [`docs/pages/reference/cli.md`](docs/pages/reference/cli.md).
- Package reference: [`docs/pages/reference/packages.md`](docs/pages/reference/packages.md).
- Maintainers and release operators: [`RELEASE.md`](RELEASE.md).

## Repo Map

- `packages/bridge`: native Codex app-server, auth, memory, thread, JSON, and
  generated protocol bridge primitives.
- `packages/toybox`: stdio JSON-RPC toybox client/server protocol.
- `packages/feed`: durable RSS/Atom polling, source checkpoints, feed items, and
  collection cursors.
- `packages/workbench`: workbench runtime, delegation, prompt queue, handoff,
  functions, workflow, and overview primitives.
- `packages/actions`: Actions-mode auth and state helpers.
- `packages/remote`: SSH-backed toybox transports and remote control helpers.
- `packages/proxy`: optional HTTP/Vite/browser edge for local dashboards.
- `packages/kits`: kit inspect/add/list/doctor helpers.
- `packages/codex-toys`: the `codex-toys` CLI and umbrella runtime export.
- `workflows`: plugin-native workflow examples that run code before
  skipping, starting, waiting on, or composing native Codex turns.
- `docs`: Tome documentation source.

## Common Commands

Install dependencies:

```bash
vp install
```

Run checks:

```bash
vp run check:types
vp run test
vp run docs:build
```

Run the stdio toybox directly:

```bash
codex-toys toybox serve --cwd /repo
```

Start the optional browser proxy:

```bash
codex-toys-proxy serve --cwd /repo --static ./dashboard
```

Inspect the CLI:

```bash
tsx packages/codex-toys/src/cli/index.ts --help
codex-toys fetch
codex-toys remote preflight
codex-toys feed poll --json
codex-toys feed collect --cursor radar --json
codex-toys workflow list
codex-toys workflow run <name> --event event.json
codex-toys --ssh <target> --cwd <remote-workbench> workflow run <name> --event event.json
codex-toys --ssh <target> --cwd <remote-workbench> fetch
codex-toys --ssh <target> --cwd <remote-workbench> remote preflight
codex-toys --ssh <target> --cwd <remote-workbench> app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-toys --ssh <target> --cwd <remote-workbench> functions list --json
codex-toys --ssh <target> --cwd <remote-workbench> turn run "Scan current folder" --wait --sandbox danger-full-access --approval-policy never
codex-toys workbench doctor
codex-toys toybox status
codex-toys memories transplant global-to-workbench
codex-toys threads transplant <thread-id> --from-codex-home ~/.codex --to-codex-home ./.codex
```

Install the shared Peezy Tech Codex plugin marketplace from GitHub. Use the
granular plugin that matches the job:

```bash
codex plugin marketplace add peezy-tech/skills --ref main
codex plugin add codex-toys-author@peezy-tech
codex plugin add codex-toys-remote-control@peezy-tech
codex plugin add codex-toys-local-workbench@peezy-tech
```

## Documentation Model

The root README is intentionally short. Canonical documentation belongs in the
docs site:

- Primitive pages define the product surface: workflow, toybox, workbench,
  delegation, deferred queues, feed, proxy, and kits.
- Operations pages cover Codex state moves and plugin install.
- Reference pages define CLI commands, package exports, and proxy APIs.

Package READMEs stay npm-focused: install, exports, minimal examples, and links
back to the docs site.

## Published Package

The public npm package is:

- `codex-toys`

Its supported runtime imports are exposed through `codex-toys/*` subpaths, for
example `codex-toys/feed`, `codex-toys/workbench`, `codex-toys/bridge`, and
`codex-toys/proxy/browser`.

Legacy workflow packages have been removed from the monorepo; new workflow
surface belongs in `packages/workbench`, the public `codex-toys/workbench`
subpath, and plugin-native workflow.

Release procedure and remote policy are in [`RELEASE.md`](RELEASE.md). In short:
jojo.build is the canonical development remote, Codeberg is a push mirror, and
GitHub is used for the npm publishing workflow.
