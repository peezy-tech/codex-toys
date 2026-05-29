# codex-toys

Codex app-server clients, turn automation, toybox tools, and
repo-native workspace operations.

This repository is a monorepo. The npm package users should install is
`codex-toys`, which publishes app-server client APIs, turn
automation helpers, toybox helpers, the `codex-toys` CLI, and
runnable proxy bins. The full user
documentation lives in the Tome docs site under
[`docs/pages`](docs/pages).

## Start Here

- New users: read [`docs/pages/index.md`](docs/pages/index.md).
- CLI reference: [`docs/pages/reference/cli.md`](docs/pages/reference/cli.md).
- Turn automation: [`docs/pages/guides/turn-automation.md`](docs/pages/guides/turn-automation.md).
- Workspace autonomy: [`docs/pages/guides/workspace-autonomy.md`](docs/pages/guides/workspace-autonomy.md).
- Memory transplant: [`docs/pages/guides/memory-transplant.md`](docs/pages/guides/memory-transplant.md).
- Thread transplant: [`docs/pages/guides/thread-transplant.md`](docs/pages/guides/thread-transplant.md).
- Codex plugin: [`docs/pages/guides/install-codex-plugin.md`](docs/pages/guides/install-codex-plugin.md).
- Optional pack copies: [`docs/pages/guides/install-pack-repos.md`](docs/pages/guides/install-pack-repos.md).
- Single-package platform: [`docs/pages/concepts/single-package-platform.md`](docs/pages/concepts/single-package-platform.md).
- Maintainers and release operators: [`RELEASE.md`](RELEASE.md).

## Repo Map

- `packages/codex-client`: `codex-toys`, the app-server client,
  transports, turn automation helpers, toybox helpers, CLI, auth
  helpers, workbench reducers, and generated app-server protocol types.
- `automations`: plugin-native turn automation examples that run code before
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
tsx packages/codex-client/src/cli/index.ts --help
codex-toys fetch
codex-toys remote status
codex-toys automation list
codex-toys automation run openai-codex-bindings --event event.json
codex-toys --ssh devbox --cwd /repo automation run openai-codex-bindings --event event.json
codex-toys --ssh devbox --cwd /repo fetch
codex-toys --ssh devbox --cwd /repo remote preflight
codex-toys --ssh devbox --cwd /repo app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-toys --ssh devbox --cwd /repo functions list --json
codex-toys --ssh devbox --cwd /repo functions call portfolioSnapshot --json
codex-toys --ssh devbox --cwd /repo turn run "Scan current folder" --wait --sandbox danger-full-access --approval-policy never
codex-toys workspace doctor
codex-toys toybox status
codex-toys memories transplant global-to-workspace
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

- Tutorials teach a first successful workflow.
- Guides cover operational tasks such as turn automation, workspace autonomy,
  memory transplant, thread transplant, plugin install, optional pack copies,
  and toybox/proxy operation.
- Reference pages define CLI commands, package exports, and proxy APIs.
- Concepts explain boundaries between app-server clients, turn automation,
  toyboxes, and product-owned domain completion.

Package READMEs stay npm-focused: install, exports, minimal examples, and links
back to the docs site.

## Published Packages

The canonical user-facing package is:

- `codex-toys`

Legacy automation packages have been removed from the monorepo; new automation
surface belongs in the core package and plugin-native turn automation.

Release procedure and remote policy are in [`RELEASE.md`](RELEASE.md). In short:
jojo.build is the canonical development remote, Codeberg is a push mirror, and
GitHub is used for the npm publishing workflow.
