# codex-toys

Codex bridge, runtime/connect transport, feed, workbench, Actions, kits, and CLI
tools.

This repository is a monorepo. The only public npm package is `codex-toys`;
runtime surfaces are exported from subpaths such as `codex-toys/bridge`,
`codex-toys/feed`, `codex-toys/workbench`, `codex-toys/runtime`, and
`codex-toys/kits`. The scoped `@codex-toys/*` workspaces are internal package
boundaries bundled into the published tarball.

The full user documentation lives in the Tome docs site under
[`docs/pages`](docs/pages). The public npm tarball also carries a Markdown
snapshot at `docs/pages` so installed versions keep matching docs.

Each release publishes the Actions-mode base image
`ghcr.io/peezy-tech/codex-toys-actions:<version>` for repository-owned
workbench runs. The OpenAI Codex release feed also publishes native
Codex-pinned image tags such as
`ghcr.io/peezy-tech/codex-toys-actions:codex-0.137.0` before running the binding
refresh workflow.

## Start Here

- New users: read [`docs/pages/index.md`](docs/pages/index.md).
- Workflow: [`docs/pages/primitives/workflow.md`](docs/pages/primitives/workflow.md).
- Workbench: [`docs/pages/primitives/workbench.md`](docs/pages/primitives/workbench.md).
- Dispatch and queues: [`docs/pages/primitives/dispatch-queues.md`](docs/pages/primitives/dispatch-queues.md).
- Feed: [`docs/pages/primitives/feed.md`](docs/pages/primitives/feed.md).
- Runtime: [`docs/pages/components/runtime.md`](docs/pages/components/runtime.md).
- Kits: [`docs/pages/components/kits.md`](docs/pages/components/kits.md).
- CLI reference: [`docs/pages/components/cli.md`](docs/pages/components/cli.md).
- Repository autonomy: [`docs/pages/guides/repository-autonomy.md`](docs/pages/guides/repository-autonomy.md).
- Remote runtime: [`docs/pages/guides/remote-runtime.md`](docs/pages/guides/remote-runtime.md).
- Local scheduled workbench: [`docs/pages/guides/local-scheduled-workbench.md`](docs/pages/guides/local-scheduled-workbench.md).
- Dashboard over runtime: [`docs/pages/guides/dashboard-over-runtime.md`](docs/pages/guides/dashboard-over-runtime.md).
- Feed to workflow: [`docs/pages/guides/feed-to-workflow.md`](docs/pages/guides/feed-to-workflow.md).
- Capability kit setup: [`docs/pages/guides/capability-kit-setup.md`](docs/pages/guides/capability-kit-setup.md).
- Codex state moves: [`docs/pages/operations/codex-state.md`](docs/pages/operations/codex-state.md).
- Plugins: [`docs/pages/operations/plugins.md`](docs/pages/operations/plugins.md).
- Package reference: [`docs/pages/reference/packages.md`](docs/pages/reference/packages.md).
- Maintainers and release operators: [`RELEASE.md`](RELEASE.md).

## Repo Map

- `packages/bridge`: native Codex app-server, auth, memory, thread, JSON, and
  generated protocol bridge primitives.
- `packages/feed`: durable RSS/Atom polling, manual feed item append, source
  checkpoints, feed items, and collection cursors.
- `packages/workbench`: workbench runtime, prompt queue, handoff, functions,
  workflow, and overview primitives.
- `packages/actions`: Actions-mode auth and state helpers.
- `packages/kits`: kit inspect/add/list/doctor helpers.
- `packages/codex-toys`: the `codex-toys` CLI and umbrella runtime export.
- Internal transport workspaces implement the public `codex-toys/runtime`
  surface.
- `workflows`: plugin-native workflow examples that run code before skipping,
  starting, waiting on, or composing native Codex turns.
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

Inspect the CLI and runtime:

```bash
tsx packages/codex-toys/src/cli/index.ts --help
codex-toys fetch
codex-toys runtime serve --cwd /repo
codex-toys runtime http --cwd /repo --static ./dashboard
codex-toys runtime host-overview --json
codex-toys feed poll --json
codex-toys feed collect --cursor radar --json
codex-toys workflow list
codex-toys workflow run <name> --event event.json
codex-toys --ssh <target> --cwd <remote-workspace> workflow run <name> --event event.json
codex-toys --ssh <target> --cwd <remote-workspace> fetch
codex-toys --ssh <target> --cwd <remote-workspace> runtime preflight --json
codex-toys --ssh <target> --cwd <remote-workspace> app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-toys --ssh <target> --cwd <remote-workspace> functions list --json
codex-toys --ssh <target> --cwd <remote-workspace> turn run "Scan current folder" --wait --sandbox danger-full-access --approval-policy never
codex-toys workbench doctor
codex-toys workbench overview --json
codex-toys memories transplant global-to-workbench
codex-toys threads transplant <thread-id> --from-codex-home ~/.codex --to-codex-home ./.codex
```

Install the shared Peezy Tech Codex plugin marketplace from GitHub. Use the
granular plugin that matches the job:

```bash
codex plugin marketplace add peezy-tech/skills --ref main
codex plugin add codex-toys-author@peezy-tech
codex plugin add codex-toys-remote-control@peezy-tech
codex plugin add codex-toys-local-workspace@peezy-tech
```

## Documentation Model

The root README is intentionally short. Canonical documentation belongs in the
docs site:

- Primitive pages define workflow, workbench, dispatch queues, and feed.
- Component pages define runtime, kits, and CLI.
- Guides show setup paths for scheduler-owned workbenches, remote runtime,
  dashboards, feeds, and kits.
- Operations pages cover Codex state moves and plugin install.
- Reference pages define package exports.

Package READMEs stay npm-focused: install, exports, minimal examples, and links
back to the docs site.

## Published Package

The public npm package is:

- `codex-toys`

Its supported runtime imports are exposed through `codex-toys/*` subpaths, for
example `codex-toys/feed`, `codex-toys/workbench`, `codex-toys/bridge`, and
`codex-toys/runtime`.

The package also includes the Markdown documentation snapshot under
`docs/pages`; built Tome assets are not published.

Release procedure and remote policy are in [`RELEASE.md`](RELEASE.md). In
short: jojo.build is the canonical development remote, Codeberg is a push
mirror, and GitHub is used for the npm publishing workflow.
