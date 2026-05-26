# @peezy.tech/codex-flows

Codex app-server client APIs, turn automation helpers, workspace backend
helpers, and runnable local backend CLIs.

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
- turn automation: <https://github.com/peezy-tech/codex-flows/blob/main/docs/pages/guides/turn-automation.md>
- package reference: <https://github.com/peezy-tech/codex-flows/blob/main/docs/pages/reference/packages.md>
- workspace autonomy: <https://github.com/peezy-tech/codex-flows/blob/main/docs/pages/guides/workspace-autonomy.md>
- memory transplant: <https://github.com/peezy-tech/codex-flows/blob/main/docs/pages/guides/memory-transplant.md>
- thread transplant: <https://github.com/peezy-tech/codex-flows/blob/main/docs/pages/guides/thread-transplant.md>
- Codex plugin skills and hooks: <https://github.com/peezy-tech/codex-flows/blob/main/docs/pages/guides/install-codex-plugin.md>
- optional pack copies: <https://github.com/peezy-tech/codex-flows/blob/main/docs/pages/guides/install-pack-repos.md>

## Exports

| Export | Purpose |
|--------|---------|
| `@peezy.tech/codex-flows` | Node app-server client, turn automation helpers, SSH provider helpers, event emitter base, stdio/WebSocket transports, JSON-RPC helpers, auth helpers. |
| `@peezy.tech/codex-flows/browser` | Browser-safe app-server client and WebSocket transport. |
| `@peezy.tech/codex-flows/auth` | Privacy-preserving Codex account login, status, and usage helpers. |
| `@peezy.tech/codex-flows/workbench` | Transport-neutral thread UX reducers and app-server request descriptors. |
| `@peezy.tech/codex-flows/threads` | Raw Codex rollout locate, inspect, install, and transplant helpers. |
| `@peezy.tech/codex-flows/workspace-backend` | Workspace backend protocol server/client helpers and capability primitives. |
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
`codex app-server`. Set `CODEX_APP_SERVER_CODEX_COMMAND`,
`CODEX_APP_SERVER_CODEX_ARGS`, or pass `transportOptions.codexCommand` when a
specific binary or launch flags should be used.

Browser entry:

```ts
import { CodexAppServerClient } from "@peezy.tech/codex-flows/browser";

const client = new CodexAppServerClient({
	webSocketTransportOptions: { url: "ws://127.0.0.1:3585" },
});
await client.connect();
```

## Turn Automation

```ts
import { runTurnAutomationScript } from "@peezy.tech/codex-flows";

const run = await runTurnAutomationScript({
	scriptPath: "./automations/check-release/check-release.ts",
	event: { type: "upstream.release", payload: { tag: "v1.2.3" } },
	cwd: "/repo",
	timeoutMs: 90_000,
});

if (run.decision?.action === "turn") {
	console.log(run.decision.prompt);
}
```

Turn automation runs code before deciding whether to skip, start one native
Codex turn, or return a programmatic result after composing several turns. Use
it for plugin-installed prompt automation.

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
codex-flows remote status
codex-flows --ssh devbox --cwd /repo remote preflight
codex-flows remote tunnel start --ssh <user@tailscale-host> --dry-run
codex-flows remote turn start --via workspace --prompt "Check workspace status" --wait
codex-flows turn run "Check workspace status" --wait
codex-flows automation list
codex-flows automation run openai-codex-bindings --event event.json
codex-flows --ssh devbox --cwd /repo automation run openai-codex-bindings --event event.json
codex-flows --ssh devbox --cwd /repo fetch
codex-flows --ssh devbox --cwd /repo app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-flows --ssh devbox --cwd /repo turn run "Scan current folder" --wait --sandbox danger-full-access --approval-policy never
codex-flows app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-flows workspace app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-flows workspace doctor
codex-flows workspace backend init local
codex-flows workspace backend status
codex-flows workspace backend start --dry-run
codex-flows workspace tick --mode local
codex-flows memories transplant global-to-workspace
codex-flows threads transplant <thread-id> --from-codex-home ~/.codex --to-codex-home ./.codex

codex-app thread/list '{"limit":20,"sourceKinds":[]}'
codex-workspace-backend-local serve --local-app-server
```

See `docs/pages/reference/cli.md` for the full command surface.

SSH is a connection provider, not a product UI surface. With `--ssh`, the local
CLI can target a remote workspace, tunnel or spawn the remote workspace backend,
run prompts with `turn run`, route `remote turn start --wait` through the same
provider, and fall back to a remote app-server over stdio for app-only commands.
For non-interactive SSH PATH differences, set `CODEX_FLOWS_REMOTE_PATH_PREPEND`,
absolute remote command overrides, or `CODEX_FLOWS_REMOTE_CODEX_ARGS` /
`CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_ARGS` JSON arrays instead of adding wrapper
scripts on the remote host.

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
