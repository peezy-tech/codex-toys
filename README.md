# Codex Bare

Thin browser UI plus TypeScript client for `codex app-server`.

The current source is:

- `apps/web`: React/Vite UI that connects through the workspace backend.
- `apps/cli`: Bun CLI that sends JSON-RPC actions to a listening Codex app-server.
- `apps/discord-bridge`: Discord sidecar that connects Discord threads to
  Codex app-server threads through the workspace backend capability model.
- `apps/flow-runner`: CLI for discovering and firing packaged flows.
- `apps/workspace-backend`: local workspace backend process with browser/control
  WebSocket and optional flow HTTP routes.
- `docs`: Tome documentation site for codex-flow.
- `packages/codex-client`: JSON-RPC client, app-server transports, flow helpers, and generated protocol types.
- `packages/flow-runtime`: flow manifest loading, event matching, and runner primitives.
- `packages/ui`: small shared UI primitives and styling.

## Run

Install dependencies:

```bash
bun install
```

Start the local workspace backend in a separate shell. It can spawn a local
stdio app-server:

```bash
bun run workspace:backend --local-app-server
```

Start the web app:

```bash
bun run dev
```

In development, the web app defaults to a same-origin Vite WebSocket proxy at
`/__codex-workspace-backend`, which forwards to `ws://127.0.0.1:3586`.

Set `VITE_CODEX_WORKSPACE_BACKEND_PROXY_TARGET` to proxy to a different
workspace backend URL. Set `VITE_CODEX_WORKSPACE_BACKEND_WS_URL` only when you
explicitly want the browser to connect directly to a workspace backend
WebSocket.

Send a command to a standalone app-server WebSocket:

```bash
bun apps/cli/src/index.ts thread/list '{"limit": 20, "sourceKinds": []}'
echo '{"refreshToken": false}' | bun apps/cli/src/index.ts account/read
```

List available actions:

```bash
bun apps/cli/src/index.ts actions
```

## Build And Test

```bash
bun run build
bun run test
```

`bun run test` runs the client, flow runtime, workspace backend, CLI, Discord
bridge, and web tests.

## Flow Automation

Flow packages live under `flows/*` and installed copies can live under
`.codex/flows/*`. The publishable Tome docs live in [docs](docs) and cover
`flow.toml`, generic `FlowEvent` dispatch, Bun and Code Mode runners, local
clients, the workspace flow backend, and Convex backends.

```bash
bun run flow list
bun run flow:backend serve --cwd "$(pwd)"
bun run flow:backend list-events --limit 20
bun run flow:backend list-runs --status failed
```

Code Mode flow steps are present on `main` behind one mode flag:

```bash
CODEX_FLOWS_MODE=code-mode
```

That mode enables `runner = "code-mode"` steps and makes stdio app-server
launches default to `bunx @peezy.tech/codex`. `CODEX_APP_SERVER_CODEX_COMMAND`
still wins when a specific local binary should be used.

For release readiness, inspect and replay stored events with
`bun run flow:backend show-event`, `show-run`, and `replay-event`. Do not run a
fabricated full `openai/codex` release lifecycle; the first full lifecycle test
should happen on the next real upstream release.

## Development Flow

Development happens on jojo at `jojo.build`. Codeberg is configured as a push mirror, and GitHub is kept for npm trusted publishing only.

See [DEVELOP.md](DEVELOP.md) for remotes, key setup, jojo CLI setup, mirroring, and the release procedure.

## Documentation

The codex-flow documentation site is a Tome project in `docs/`:

```bash
bun run docs:dev
bun run docs:build
```

The source pages are organized with the Diataxis framework under
`docs/pages/tutorials`, `docs/pages/guides`, `docs/pages/reference`, and
`docs/pages/concepts`. `bun run docs:build` writes the static site and
machine-readable files to `docs/out`.

## Publishing

The canonical development home for this monorepo is `jojo.build/peezy-tech/codex-flows`.
Codeberg mirrors `peezy-tech/codex-flows`; the GitHub repository at `peezy-tech/codex-flows` exists for npm trusted publishing.

The public release train publishes:

- `@peezy.tech/codex-flows` from `packages/codex-client`
- `@peezy.tech/flow-runtime` from `packages/flow-runtime`
- `@peezy.tech/flow-backend-convex` from `packages/flow-backend-convex`

Before the first publish:

```bash
bun run release:check
```

Because newly added npm packages do not exist yet, bootstrap their first version
with a human npm session, short-lived npm token, or npm trusted-publishing setup
from the public repo checkout. The `peezy.tech` npm organization/scope must
exist first, and the publishing account or token must have write access to that
scope:

```bash
for package in packages/codex-client packages/flow-runtime packages/flow-backend-convex; do
  (cd "$package" && npm publish --access public)
done
```

If first-publishing through GitHub Actions, add a short-lived `NPM_TOKEN` secret
to the `npm-publish` environment before dispatching the workflow. The workflow
uses that token when present and otherwise falls back to npm trusted publishing.
After the first publish succeeds and package-level trusted publishing is
configured, remove the bootstrap token.

After the packages exist, configure npm trusted publishing for each public
package:

- Packages: `@peezy.tech/codex-flows`, `@peezy.tech/flow-runtime`, `@peezy.tech/flow-backend-convex`
- Repository: `peezy-tech/codex-flows`
- Workflow: `.github/workflows/publish-codex-flows.yml`
- Environment: `npm-publish`

Future publishes should use the GitHub Actions workflow and should not require
an npm token.

## Packages

### `@peezy.tech/codex-flows`

The low-level app-server client package. It exports:

- `@peezy.tech/codex-flows`: Node/Bun entry with stdio and WebSocket transports.
- `@peezy.tech/codex-flows/browser`: browser entry with WebSocket transport only.
- `@peezy.tech/codex-flows/flows`: framework-agnostic helpers for app servers that want to start Codex-backed workflows.
- `@peezy.tech/codex-flows/workbench`: transport-neutral thread UX state reducers and app-server request descriptors.
- `@peezy.tech/codex-flows/workspace-backend`: workspace backend client,
  protocol server, and built-in capability primitives.
- `@peezy.tech/codex-flows/rpc`: JSON-RPC helpers and types.
- `@peezy.tech/codex-flows/generated`: generated Codex app-server protocol types.

### `@peezy.tech/codex-opencode-go-router`

Private workspace package for running a local Responses API adapter that lets
Codex use OpenCode Go chat-completions providers. It maps Codex Responses
requests, tool specs, tool-call outputs, and DeepSeek reasoning replay to the
OpenCode Go upstream surface. See
`packages/codex-opencode-go-router/README.md`.

### `flow-runner`

CLI package for listing flow packages, firing every step that matches a
`FlowEvent`, or running one explicit flow step.

### `codex-workspace-backend-local`

Local workspace backend process. In networked mode, it exposes the workspace
backend browser/control WebSocket and mounts the existing flow HTTP routes. The
same flow execution and inspection behavior is a built-in workspace capability
that embedded presenters can call directly without HTTP. Flow state is persisted
to SQLite, and matching steps can run directly or through transient
`systemd-run` units.

### `@peezy.tech/flow-runtime`

Shared runtime package for loading `flow.toml`, validating payload JSON Schema,
matching steps to generic events, and invoking Bun or feature-flagged Code Mode
steps. It also exports `@peezy.tech/flow-runtime/backend-client` for
backend-native flow event/run inspection and control over HTTP. That client
normalizes backend-owned run state such as process status, semantic
`FLOW_RESULT` status, attempts, output, replay, cancel, and attention flags.

### Boundary

App-server thread commands stay app-server-native: consumers should call
`client.request(method, params)` or the generated protocol methods directly.
Workbench helpers derive UI state and return `{ method, params }` descriptors;
they do not execute app-server calls. Flow backend clients operate on generic
`FlowEvent`, runs, attempts, output, replay, and cancel state. Domain completion
such as pet-game asset registration, payment updates, or minting remains in the
installing app's worker or Convex wrappers.

### `@peezy.tech/flow-backend-convex`

Reusable Convex component package for generic flow event, run, attempt, lease,
output, replay, cancel, and inspection state. Apps install its Convex component
and expose their own authenticated wrappers for service workers.

### `web`

The browser app imports `@peezy.tech/codex-flows/workspace-backend`, opens a
workspace backend WebSocket, lists threads, starts turns, interrupts running
turns, and renders thread items and live app-server events forwarded through the
workspace backend.

### `cli`

CLI package for piping JSON params into app-server JSON-RPC actions over a
running WebSocket listener. It defaults to `ws://127.0.0.1:3585`, respects
`CODEX_WORKSPACE_APP_SERVER_WS_URL`, supports `--url`, and lists available
actions from the generated app-server action list.

### `@workspace/ui`

Shared Tailwind/shadcn-compatible UI primitives used by the web app.
