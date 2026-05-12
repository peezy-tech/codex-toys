# Codex Bare

Thin browser UI plus TypeScript client for `codex app-server`.

This branch intentionally drops the workspace service, runtime, gateways, jobs,
delegation, and host setup layer. The remaining source is:

- `apps/web`: React/Vite UI that connects directly to a Codex app-server WebSocket.
- `apps/cli`: Bun CLI that sends JSON-RPC actions to a listening Codex app-server.
- `packages/codex-client`: JSON-RPC client, app-server transports, flow helpers, and generated protocol types.
- `packages/ui`: small shared UI primitives and styling.

## Run

Install dependencies:

```bash
bun install
```

Start a Codex app-server WebSocket in a separate shell:

```bash
codex app-server --listen ws://127.0.0.1:3585 --enable apps --enable hooks
```

Start the web app:

```bash
bun run dev
```

In development, the web app defaults to a same-origin Vite WebSocket proxy at
`/__codex-app-server`, which forwards to `ws://127.0.0.1:3585`. This avoids
browser `Origin` header rejections from the app-server, which can show up in
WSL and other browser-to-localhost setups.

Set `VITE_CODEX_APP_SERVER_PROXY_TARGET` to proxy to a different app-server
URL. Set `VITE_CODEX_APP_SERVER_WS_URL` only when you explicitly want the
browser to connect directly to an app-server WebSocket.

Send a command to the running app-server:

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

`bun run test` currently runs the `@peezy.tech/codex-flows` transport tests.

## Development Flow

Development happens on Forgejo at `jojo.build`. Codeberg is configured as a push mirror, and GitHub is kept for npm trusted publishing only.

See [docs/development-flow.md](docs/development-flow.md) for remotes, key setup, Forgejo CLI setup, mirroring, and the release procedure.

## Publishing

The canonical development home for this monorepo is `jojo.build/peezy-tech/codex-flows`.
Codeberg mirrors `peezy-tech/codex-flows`; the GitHub repository at `peezy-tech/codex-flows` exists for npm trusted publishing.

`@peezy.tech/codex-flows` is published from `packages/codex-client`.

Before the first publish:

```bash
bun run --filter @peezy.tech/codex-flows release:check
```

Because the npm package does not exist yet, bootstrap the first version with a
human npm session or short-lived npm token from the public repo checkout. The
`peezy.tech` npm organization/scope must exist first, and the publishing account
or token must have write access to that scope:

```bash
cd packages/codex-client
npm publish --access public
```

After the package exists, configure npm trusted publishing for:

- Package: `@peezy.tech/codex-flows`
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
- `@peezy.tech/codex-flows/rpc`: JSON-RPC helpers and types.
- `@peezy.tech/codex-flows/generated`: generated Codex app-server protocol types.

### `web`

The browser app imports `@peezy.tech/codex-flows/browser`, opens a direct WebSocket
connection, lists threads, starts turns, interrupts running turns, and renders
thread items and live app-server events.

### `cli`

CLI package for piping JSON params into app-server JSON-RPC actions over a
running WebSocket listener. It defaults to `ws://127.0.0.1:3585`, respects
`CODEX_WORKSPACE_APP_SERVER_WS_URL`, supports `--url`, and lists available
actions from the generated app-server action list.

### `@workspace/ui`

Shared Tailwind/shadcn-compatible UI primitives used by the web app.
