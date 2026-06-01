# codex-toys

Codex bridge, toybox, remote, workbench, Actions, proxy, kits, and CLI tools.

This repository is a monorepo. The user-facing CLI package is `codex-toys`;
reusable runtime surfaces live in scoped packages such as
`@codex-toys/bridge`, `@codex-toys/workbench`, and `@codex-toys/proxy`.
The full user documentation lives in the Tome docs site under
[`docs/pages`](docs/pages).

## Start Here

- New users: read [`docs/pages/index.md`](docs/pages/index.md).
- CLI reference: [`docs/pages/reference/cli.md`](docs/pages/reference/cli.md).
- Turn automation: [`docs/pages/guides/turn-automation.md`](docs/pages/guides/turn-automation.md).
- Workbench autonomy: [`docs/pages/guides/workbench-autonomy.md`](docs/pages/guides/workbench-autonomy.md).
- Memory transplant: [`docs/pages/guides/memory-transplant.md`](docs/pages/guides/memory-transplant.md).
- Thread transplant: [`docs/pages/guides/thread-transplant.md`](docs/pages/guides/thread-transplant.md).
- Codex plugin: [`docs/pages/guides/install-codex-plugin.md`](docs/pages/guides/install-codex-plugin.md).
- Optional kit copies: [`docs/pages/guides/install-kit-repos.md`](docs/pages/guides/install-kit-repos.md).
- Package stack: [`docs/pages/concepts/package-stack.md`](docs/pages/concepts/package-stack.md).
- Maintainers and release operators: [`RELEASE.md`](RELEASE.md).

## Repo Map

- `packages/bridge`: native Codex app-server, auth, memory, thread, JSON, and
  generated protocol bridge primitives.
- `packages/toybox`: stdio JSON-RPC toybox client/server protocol.
- `packages/workbench`: workbench runtime, delegation, prompt queue, handoff,
  functions, automation, and overview primitives.
- `packages/actions`: Actions-mode auth and state helpers.
- `packages/remote`: SSH-backed toybox transports and remote control helpers.
- `packages/proxy`: optional HTTP/Vite/browser edge for local dashboards.
- `packages/kits`: kit inspect/add/list/doctor helpers.
- `packages/codex-toys`: the `codex-toys` CLI and umbrella runtime export.
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
tsx packages/codex-toys/src/cli/index.ts --help
codex-toys fetch
codex-toys remote preflight
codex-toys automation list
codex-toys automation run openai-codex-bindings --event event.json
codex-toys --ssh devbox --cwd /repo automation run openai-codex-bindings --event event.json
codex-toys --ssh devbox --cwd /repo fetch
codex-toys --ssh devbox --cwd /repo remote preflight
codex-toys --ssh devbox --cwd /repo app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-toys --ssh devbox --cwd /repo functions list --json
codex-toys --ssh devbox --cwd /repo functions call portfolioSnapshot --json
codex-toys --ssh devbox --cwd /repo turn run "Scan current folder" --wait --sandbox danger-full-access --approval-policy never
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

- Tutorials teach a first successful workflow.
- Guides cover operational tasks such as turn automation, workbench autonomy,
  memory transplant, thread transplant, plugin install, optional kit copies,
  and toybox/proxy operation.
- Reference pages define CLI commands, package exports, and proxy APIs.
- Concepts explain boundaries between app-server clients, turn automation,
  toyboxes, and product-owned domain completion.

Package READMEs stay npm-focused: install, exports, minimal examples, and links
back to the docs site.

## Published Packages

The public package stack is:

- `@codex-toys/bridge`
- `@codex-toys/toybox`
- `@codex-toys/workbench`
- `@codex-toys/actions`
- `@codex-toys/remote`
- `@codex-toys/proxy`
- `@codex-toys/kits`
- `codex-toys`

Legacy automation packages have been removed from the monorepo; new automation
surface belongs in `@codex-toys/workbench` and plugin-native turn automation.

Release procedure and remote policy are in [`RELEASE.md`](RELEASE.md). In short:
jojo.build is the canonical development remote, Codeberg is a push mirror, and
GitHub is used for the npm publishing workflow.
