# codex-toys

Codex bridge, toybox, feed, remote, workbench, Actions, proxy, kits, and CLI tools.

This repository is a monorepo. The only public npm package is `codex-toys`;
reusable runtime surfaces are exported from subpaths such as
`codex-toys/bridge`, `codex-toys/feed`, `codex-toys/workbench`, and
`codex-toys/proxy`.
The scoped `@codex-toys/*` workspaces are internal package boundaries that are
bundled into the published tarball.
The full user documentation lives in the Tome docs site under
[`docs/pages`](docs/pages). The public npm tarball also carries a Markdown
snapshot at `docs/pages` so installed versions keep matching docs.
Each release also publishes the Actions-mode base image
`ghcr.io/peezy-tech/codex-toys-actions:<version>` for scheduled workbench runs.
The OpenAI Codex release feed also publishes native Codex-pinned image tags such
as `ghcr.io/peezy-tech/codex-toys-actions:codex-0.137.0` before running the
binding refresh workflow.

## Start Here

- New users: read [`docs/pages/index.md`](docs/pages/index.md).
- Workflow: [`docs/pages/primitives/workflow.md`](docs/pages/primitives/workflow.md).
- Workbench: [`docs/pages/primitives/workbench.md`](docs/pages/primitives/workbench.md).
- Delegation: [`docs/pages/primitives/delegation.md`](docs/pages/primitives/delegation.md).
- Dispatch and queues: [`docs/pages/primitives/dispatch-queues.md`](docs/pages/primitives/dispatch-queues.md).
- Feed: [`docs/pages/primitives/feed.md`](docs/pages/primitives/feed.md).
- Toybox: [`docs/pages/components/toybox.md`](docs/pages/components/toybox.md).
- Proxy: [`docs/pages/components/proxy.md`](docs/pages/components/proxy.md).
- Kits: [`docs/pages/components/kits.md`](docs/pages/components/kits.md).
- CLI reference: [`docs/pages/components/cli.md`](docs/pages/components/cli.md).
- Repository autonomy: [`docs/pages/guides/repository-autonomy.md`](docs/pages/guides/repository-autonomy.md).
- Remote Codex workbench: [`docs/pages/guides/remote-codex-workbench.md`](docs/pages/guides/remote-codex-workbench.md).
- Local scheduled workbench: [`docs/pages/guides/local-scheduled-workbench.md`](docs/pages/guides/local-scheduled-workbench.md).
- Dashboard over toybox: [`docs/pages/guides/dashboard-over-toybox.md`](docs/pages/guides/dashboard-over-toybox.md).
- Feed to workflow: [`docs/pages/guides/feed-to-workflow.md`](docs/pages/guides/feed-to-workflow.md).
- Capability kit setup: [`docs/pages/guides/capability-kit-setup.md`](docs/pages/guides/capability-kit-setup.md).
- Delegated repo work: [`docs/pages/guides/delegated-repo-work.md`](docs/pages/guides/delegated-repo-work.md).
- Codex state moves: [`docs/pages/operations/codex-state.md`](docs/pages/operations/codex-state.md).
- Plugins: [`docs/pages/operations/plugins.md`](docs/pages/operations/plugins.md).
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

- Primitive pages define the product surface: workflow, workbench, delegation,
  dispatch queues, and feed.
- Component pages define supporting surfaces: toybox, proxy, kits, and CLI.
- Guides show end-to-end setup paths for scheduled workbenches, remotes,
  dashboards, feeds, kits, and delegation.
- Operations pages cover Codex state moves and plugin install.
- Reference pages define package exports.

Package READMEs stay npm-focused: install, exports, minimal examples, and links
back to the docs site.

## Published Package

The public npm package is:

- `codex-toys`

Its supported runtime imports are exposed through `codex-toys/*` subpaths, for
example `codex-toys/feed`, `codex-toys/workbench`, `codex-toys/bridge`, and
`codex-toys/proxy/browser`.
The package also includes the Markdown documentation snapshot under
`docs/pages`; built Tome assets are not published.

Legacy workflow packages have been removed from the monorepo; new workflow
surface belongs in `packages/workbench`, the public `codex-toys/workbench`
subpath, and plugin-native workflow.

Release procedure and remote policy are in [`RELEASE.md`](RELEASE.md). In short:
jojo.build is the canonical development remote, Codeberg is a push mirror, and
GitHub is used for the npm publishing workflow.
