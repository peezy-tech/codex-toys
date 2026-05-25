# codex-flows

Codex app-server clients, turn automation, flow compatibility tooling,
workspace backend tools, and repo-native workspace operations.

This repository is a monorepo. The npm package users should install is
`@peezy.tech/codex-flows`, which publishes app-server client APIs, turn
automation helpers, flow runtime compatibility helpers, workspace backend
helpers, the `codex-flows` CLI, and runnable local backend bins. The full user
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

- `packages/codex-client`: `@peezy.tech/codex-flows`, the app-server client,
  transports, turn automation helpers, workspace backend helpers, CLI, auth
  helpers, workbench reducers, and generated app-server protocol types.
- `packages/flow-runtime`: generic `FlowEvent` runtime, manifest loading,
  local execution, backend clients, and Node step runners.
- `packages/flow-backend-convex`: reusable Convex component for generic flow
  events, runs, attempts, leases, output, and result payloads.
- `apps/workspace-backend`: local workspace backend process with control
  WebSocket and optional flow HTTP routes.
- `apps/flow-runner`: CLI for listing and running local flow packages.
- `automations`: plugin-native turn automation examples that run code before
  deciding whether to start a native Codex turn.
- `docs`: Tome documentation source.
- `flows`: bundled flow packages.

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

Run the local backend:

```bash
codex-flows workspace backend init local
codex-flows workspace backend start
```

Inspect the CLI:

```bash
tsx packages/codex-client/src/cli/index.ts --help
codex-flows fetch
codex-flows remote status
codex-flows automation list
codex-flows automation run ./automations/check-release.ts --event event.json
codex-flows automation run openai-codex-bindings --event event.json
codex-flows --ssh devbox --cwd /repo automation run openai-codex-bindings --event event.json
codex-flows --ssh devbox --cwd /repo fetch
codex-flows --ssh devbox --cwd /repo app thread/list '{"limit":20,"sourceKinds":[]}'
codex-flows --ssh devbox --cwd /repo flow dispatch --event event.json
codex-flows workspace doctor
codex-flows workspace backend status
codex-flows memories transplant global-to-workspace
codex-flows threads transplant <thread-id> --from-codex-home ~/.codex --to-codex-home ./.codex
```

Install the shared Peezy Tech Codex plugin marketplace from GitHub. Use the
granular plugin that matches the job, or keep `codex-flows` as the full
compatibility install:

```bash
codex plugin marketplace add peezy-tech/skills --ref main
codex plugin add codex-flows-author@peezy-tech
codex plugin add codex-flows-local-workspace@peezy-tech
codex plugin add codex-flows-remote-control@peezy-tech
codex plugin add codex-flows@peezy-tech
```

## Documentation Model

The root README is intentionally short. Canonical documentation belongs in the
docs site:

- Tutorials teach a first successful workflow.
- Guides cover operational tasks such as turn automation, workspace autonomy,
  memory transplant, thread transplant, plugin install, optional pack copies,
  local backend operation, and release flow operation.
- Reference pages define CLI commands, package exports, backend APIs,
  `FlowEvent`, `FLOW_RESULT`, and `flow.toml`.
- Concepts explain boundaries between app-server clients, turn automation,
  flow compatibility, workspace backends, and product-owned domain completion.

Package READMEs stay npm-focused: install, exports, minimal examples, and links
back to the docs site.

## Published Packages

The canonical user-facing package is:

- `@peezy.tech/codex-flows`

The release train still contains compatibility/library packages while the
single-package platform consolidation continues:

- `@peezy.tech/flow-runtime`
- `@peezy.tech/flow-backend-convex`

Release procedure and remote policy are in [`RELEASE.md`](RELEASE.md). In short:
jojo.build is the canonical development remote, Codeberg is a push mirror, and
GitHub is used for the npm publishing workflow.
