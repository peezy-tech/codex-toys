# codex-flows

Codex app-server clients, flow automation, workspace backend tools, and
repo-native workspace operations.

This repository is a monorepo. The npm package most users install is
`@peezy.tech/codex-flows`, which publishes the `codex-flows` CLI plus app-server
client APIs. The full user documentation lives in the Tome docs site under
[`docs/pages`](docs/pages).

## Start Here

- New users: read [`docs/pages/index.md`](docs/pages/index.md).
- CLI reference: [`docs/pages/reference/cli.md`](docs/pages/reference/cli.md).
- Workspace autonomy: [`docs/pages/guides/workspace-autonomy.md`](docs/pages/guides/workspace-autonomy.md).
- Memory transplant: [`docs/pages/guides/memory-transplant.md`](docs/pages/guides/memory-transplant.md).
- Pack repos: [`docs/pages/guides/install-pack-repos.md`](docs/pages/guides/install-pack-repos.md).
- Maintainers and release operators: [`RELEASE.md`](RELEASE.md).

## Repo Map

- `packages/codex-client`: `@peezy.tech/codex-flows`, the app-server client,
  transports, workspace backend helpers, CLI, auth helpers, workbench reducers,
  and generated app-server protocol types.
- `packages/flow-runtime`: generic `FlowEvent` runtime, manifest loading,
  local execution, backend clients, and Bun or gated Code Mode step runners.
- `packages/flow-backend-convex`: reusable Convex component for generic flow
  events, runs, attempts, leases, output, and result payloads.
- `apps/workspace-backend`: local workspace backend process with browser/control
  WebSocket and optional flow HTTP routes.
- `apps/discord-bridge`: Discord sidecar for Codex app-server threads,
  workspace delegation, workbench views, and flow inspection.
- `apps/workspace-voice-gateway`: broadcast-only Discord voice sidecar for
  selected workspace backend updates via the TTS worker.
- `apps/flow-runner`: CLI for listing and running local flow packages.
- `apps/web`: browser UI that talks to the local workspace backend.
- `docs`: Tome documentation source.
- `flows`: bundled flow packages.

## Common Commands

Install dependencies:

```bash
bun install
```

Run checks:

```bash
bun run check:types
bun run test
bun run docs:build
```

Run the local backend and web app:

```bash
bun run workspace:backend --local-app-server
bun run dev
```

Run the local voice broadcast stack:

```bash
bun run voice:up
```

Inspect the CLI:

```bash
bun packages/codex-client/src/cli/index.ts --help
codex-flows fetch
codex-flows workspace doctor
codex-flows memories transplant global-to-workspace
codex-flows pack inspect owner/repo
```

## Documentation Model

The root README is intentionally short. Canonical documentation belongs in the
docs site:

- Tutorials teach a first successful workflow.
- Guides cover operational tasks such as workspace autonomy, memory transplant,
  pack repo install, local backend operation, Discord bridge operation, and
  release flow operation.
- Reference pages define CLI commands, package exports, backend APIs,
  `FlowEvent`, `FLOW_RESULT`, and `flow.toml`.
- Concepts explain boundaries between app-server clients, flow automation,
  workspace backends, and product-owned domain completion.

Package READMEs stay npm-focused: install, exports, minimal examples, and links
back to the docs site.

## Published Packages

The public release train currently contains:

- `@peezy.tech/codex-flows`
- `@peezy.tech/flow-runtime`
- `@peezy.tech/flow-backend-convex`

Release procedure and remote policy are in [`RELEASE.md`](RELEASE.md). In short:
jojo.build is the canonical development remote, Codeberg is a push mirror, and
GitHub is used for the npm publishing workflow.
