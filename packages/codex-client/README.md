# @peezy-tech/codex-flows

Workspace package for talking to `codex app-server`.

This package owns the low-level JSON-RPC client, transports, framework-agnostic flow helpers, and generated Codex app-server protocol types.

## Exports

- `@peezy-tech/codex-flows`
  - `CodexAppServerClient`
  - `CodexStdioTransport`
  - `CodexWebSocketTransport`
  - JSON-RPC helpers and types
- `@peezy-tech/codex-flows/browser`
	- browser-safe `CodexAppServerClient`
	- `CodexWebSocketTransport`
	- JSON-RPC helpers and types
- `@peezy-tech/codex-flows/flows`
  - `CodexFlowClient`
  - `createCodexFlowClient`
  - prompt/input normalization and optional turn completion waiting
- `@peezy-tech/codex-flows/rpc`
	- JSON-RPC message types and parsing helpers
- `@peezy-tech/codex-flows/generated`
  - generated Codex app-server protocol types
- `@peezy-tech/codex-flows/generated/*`
  - generated per-type modules

## Transports

`CodexAppServerClient` defaults to a stdio transport that starts `codex app-server` when no explicit transport is provided.

It can also connect to an existing WebSocket app-server when `CODEX_WORKSPACE_APP_SERVER_WS_URL` is set, or when `webSocketTransportOptions.url` is passed.

```ts
import { CodexAppServerClient } from "@peezy-tech/codex-flows";

const client = new CodexAppServerClient();
await client.connect();

const threads = await client.listThreads({});

client.close();
```

Browser entry:

```ts
import { CodexAppServerClient } from "@peezy-tech/codex-flows/browser";

const client = new CodexAppServerClient({
	webSocketTransportOptions: { url: "ws://127.0.0.1:3585" },
});
await client.connect();
```

Flow helpers:

```ts
import { createCodexFlowClient } from "@peezy-tech/codex-flows/flows";

const codex = createCodexFlowClient({
	appServerUrl: "ws://127.0.0.1:3585",
});

const result = await codex.startFlow({
	cwd: "/path/to/app",
	prompt: "Run the app-specific Codex workflow.",
	approvalPolicy: "never",
	sandbox: "danger-full-access",
	wait: false,
});

console.log(result.threadId, result.turnId);
```

## Scripts

```bash
bun run --filter @peezy-tech/codex-flows build
bun run --filter @peezy-tech/codex-flows check:types
bun run --filter @peezy-tech/codex-flows test
bun run --filter @peezy-tech/codex-flows pack:dry-run
bun run --filter @peezy-tech/codex-flows release:check
```

`build` emits ESM JavaScript, source maps, and declaration files into `dist`.

## Install

After publishing, install the package from npm:

```bash
bun add @peezy-tech/codex-flows
```

or:

```bash
npm install @peezy-tech/codex-flows
```

## Publishing

Run the release check before publishing:

```bash
bun run --filter @peezy-tech/codex-flows release:check
```

The release check runs package tests, type checking, a clean `dist` build, and `npm pack --dry-run`. Review the pack output before publishing so only `dist`, `README.md`, and package metadata are included.

For the first publish, use a human npm session or short-lived npm token from the public `peezy-tech/codex-flows` repo checkout. The `peezy-tech` npm organization/scope must exist first, and the publishing account or token must have write access to that scope:

```bash
cd packages/codex-client
npm publish --access public
```

After `@peezy-tech/codex-flows` exists on npm, configure trusted publishing for `.github/workflows/publish-codex-flows.yml` in the public `peezy-tech/codex-flows` repo. Future publishes should run through GitHub Actions without an npm token.

## Notes

Generated protocol files live in `src/app-server/generated`. Keep handwritten client and transport code outside that generated tree.
