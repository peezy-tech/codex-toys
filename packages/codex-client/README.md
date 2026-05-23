# @peezy.tech/codex-flows

Codex app-server client APIs, workspace backend helpers, flow tooling, and
runnable local backend CLIs.

```bash
pnpm add @peezy.tech/codex-flows
```

or:

```bash
npm install @peezy.tech/codex-flows
```

Full documentation lives in the repo docs site:

- overview: <https://github.com/peezy-tech/codex-flows/blob/main/docs/pages/index.md>
- CLI reference: <https://github.com/peezy-tech/codex-flows/blob/main/docs/pages/reference/cli.md>
- package reference: <https://github.com/peezy-tech/codex-flows/blob/main/docs/pages/reference/packages.md>
- workspace autonomy: <https://github.com/peezy-tech/codex-flows/blob/main/docs/pages/guides/workspace-autonomy.md>
- memory transplant: <https://github.com/peezy-tech/codex-flows/blob/main/docs/pages/guides/memory-transplant.md>
- thread transplant: <https://github.com/peezy-tech/codex-flows/blob/main/docs/pages/guides/thread-transplant.md>
- Codex plugin skills and hooks: <https://github.com/peezy-tech/codex-flows/blob/main/docs/pages/guides/install-codex-plugin.md>
- optional pack copies: <https://github.com/peezy-tech/codex-flows/blob/main/docs/pages/guides/install-pack-repos.md>

## Exports

| Export | Purpose |
|--------|---------|
| `@peezy.tech/codex-flows` | Node app-server client, event emitter base, stdio/WebSocket transports, JSON-RPC helpers, auth helpers. |
| `@peezy.tech/codex-flows/browser` | Browser-safe app-server client and WebSocket transport. |
| `@peezy.tech/codex-flows/flows` | Helpers for starting Codex-backed flow work. |
| `@peezy.tech/codex-flows/auth` | Privacy-preserving Codex account login, status, and usage helpers. |
| `@peezy.tech/codex-flows/workbench` | Transport-neutral thread UX reducers and app-server request descriptors. |
| `@peezy.tech/codex-flows/threads` | Raw Codex rollout locate, inspect, install, and transplant helpers. |
| `@peezy.tech/codex-flows/workspace-backend` | Workspace backend protocol server/client helpers and capability primitives. |
| `@peezy.tech/codex-flows/flow-runtime` | Flow package discovery, trigger matching, local execution, and flow result helpers. |
| `@peezy.tech/codex-flows/flow-runtime/*` | Flow runtime client, local-client, backend-client, Node helper, and runner subpaths. |
| `@peezy.tech/codex-flows/rpc` | JSON-RPC message types and parsing helpers. |
| `@peezy.tech/codex-flows/generated` | Generated Codex app-server protocol types. |
| `@peezy.tech/codex-flows/generated/*` | Generated per-type modules. |

## App-Server Client

```ts
import { CodexAppServerClient } from "@peezy.tech/codex-flows";

const client = new CodexAppServerClient();
await client.connect();

const threads = await client.listThreads({});

client.close();
```

`CodexAppServerClient` defaults to a stdio transport that starts
`codex app-server`. Set `CODEX_APP_SERVER_CODEX_COMMAND` or pass
`transportOptions.codexCommand` when a specific binary should be used.

Browser entry:

```ts
import { CodexAppServerClient } from "@peezy.tech/codex-flows/browser";

const client = new CodexAppServerClient({
	webSocketTransportOptions: { url: "ws://127.0.0.1:3585" },
});
await client.connect();
```

## Flow Helpers

```ts
import { createCodexFlowClient } from "@peezy.tech/codex-flows/flows";

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

## Auth Helpers

```ts
import {
	CodexAppServerClient,
	createCodexAuthClient,
} from "@peezy.tech/codex-flows";

const client = new CodexAppServerClient();
await client.connect();

const auth = createCodexAuthClient(client);
const state = await auth.getState();

if (state.status !== "authenticated") {
	const login = await auth.startChatGptLogin();
	console.log(login.authUrl);
}
```

The high-level auth state intentionally omits email addresses and stable account
identifiers. It exposes anonymous auth mode, plan, and usage data by default.

## Workbench Boundary

`@peezy.tech/codex-flows/workbench` does not execute app-server requests. It
derives reusable UX state from app-server notifications and completed turns, and
returns request descriptors for actions:

```ts
import { threadGoalSetDescriptor } from "@peezy.tech/codex-flows/workbench";

const action = threadGoalSetDescriptor({
	threadId,
	objective: "Finish the release checks.",
	status: "active",
	tokenBudget: 8000,
});

await client.request(action.method, action.params);
```

The app-server protocol remains the source of truth for thread commands.

## CLI

The package publishes the `codex-flows` binary and runnable process bins for the
local backend and utility CLIs:

```bash
codex-flows fetch
codex-flows app thread/list '{"limit":20,"sourceKinds":[]}'
codex-flows workspace app thread/list '{"limit":20,"sourceKinds":[]}'
codex-flows workspace doctor
codex-flows workspace tick --mode local
codex-flows memories transplant global-to-workspace
codex-flows threads transplant <thread-id> --from-codex-home ~/.codex --to-codex-home ./.codex
codex-flows flow events --limit 20

codex-app thread/list '{"limit":20,"sourceKinds":[]}'
codex-flow-runner list
codex-workspace-backend-local serve --local-app-server
```

See `docs/pages/reference/cli.md` for the full command surface.

Gateway packages, such as Discord text or voice integrations, should depend on
this package and consume `@peezy.tech/codex-flows/workspace-backend` instead of
being bundled into the core package.

## Development Scripts

```bash
vp run --filter @peezy.tech/codex-flows build
vp run --filter @peezy.tech/codex-flows check:types
vp run --filter @peezy.tech/codex-flows test
vp run --filter @peezy.tech/codex-flows pack:dry-run
vp run --filter @peezy.tech/codex-flows release:check
```

`build` emits ESM JavaScript, source maps, and declaration files into `dist`.
`release:check` runs tests, type checking, a clean build, export smoke tests,
and `npm pack --dry-run`.

Generated protocol files live in `src/app-server/generated`. Keep handwritten
client and transport code outside that generated tree.
