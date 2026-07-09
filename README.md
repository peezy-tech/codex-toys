# Codex App-Server Starter

This orphan branch is a small TypeScript starter kit for building utilities on
top of the native Codex app-server.

It keeps the strongest parts of `codex-toys` and leaves the product-specific
layers behind:

- `packages/app-server`: typed app-server client, stdio transport, auth helpers,
  JSON-RPC helpers, and generated protocol bindings.
- `packages/microbridge`: optional `app.call` pass-through protocol for local
  sidecars.
- `packages/http`: local-only HTTP, browser, and Vite helpers.
- `packages/cli`: tiny command porcelain over common app-server methods.
- `examples/node-thread-list`: direct Node usage.
- `examples/vite-thread-dashboard`: browser UI through the Vite HTTP bridge.

## Install

```bash
pnpm install
```

## Validate

```bash
pnpm run check:types
pnpm run test
pnpm run build
```

## Regenerate App-Server Bindings

After installing a new Codex release:

```bash
pnpm run bindings:generate
git diff -- packages/app-server/src/app-server/generated
pnpm run check:types
pnpm run test
```

The generated bindings live in
`packages/app-server/src/app-server/generated`.

## Use The App-Server Client

```ts
import { CodexAppServerClient } from "@codex-appkit/app-server";

const client = new CodexAppServerClient({
	transportOptions: { cwd: process.cwd() },
});

await client.connect();
const threads = await client.listThreads({ limit: 20, sourceKinds: [] });
client.close();
```

## Use The CLI

```bash
codex-appkit app actions
codex-appkit app thread/list '{"limit":20,"sourceKinds":[]}'
codex-appkit auth status
codex-appkit thread list
codex-appkit turn run "summarize this repo" --wait
codex-appkit http serve --static ./dist
```

## Use The Vite Bridge

```ts
import { codexAppkit } from "@codex-appkit/http/vite";

export default {
	plugins: [
		codexAppkit({
			transportOptions: { cwd: process.cwd() },
		}),
	],
};
```

Browser code can then call:

```ts
import { createCodexAppkitBrowserClient } from "@codex-appkit/http/browser";

const codex = createCodexAppkitBrowserClient({
	basePath: "/__codex_appkit/api",
});

const threads = await codex.app.call("thread/list", {
	limit: 20,
	sourceKinds: [],
});
```

The HTTP edge is local-first and only allows loopback browser origins.
