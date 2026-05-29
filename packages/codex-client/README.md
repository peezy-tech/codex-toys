# @peezy.tech/codex-flows

Codex app-server client APIs, turn automation helpers, local/SSH stdio agent
helpers, and an optional generic HTTP proxy for dashboards.

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
| `@peezy.tech/codex-flows` | Node app-server client, turn automation helpers, SSH agent helpers, event emitter base, stdio transports, JSON-RPC helpers, auth helpers. |
| `@peezy.tech/codex-flows/browser` | Browser-safe fetch helpers for the optional proxy API. |
| `@peezy.tech/codex-flows/proxy` | Generic HTTP proxy handler for dashboards that need `/api/status`, `/api/schema`, `/api/rpc`, `/api/app/:method`, and `/api/workspace/:method`. |
| `@peezy.tech/codex-flows/functions` | Workspace function definitions and agent method helpers. |
| `@peezy.tech/codex-flows/vite` | Vite middleware plugin that mounts the generic proxy handler for local dashboards. |
| `@peezy.tech/codex-flows/auth` | Privacy-preserving Codex account login, status, and usage helpers. |
| `@peezy.tech/codex-flows/workbench` | Transport-neutral thread UX reducers and app-server request descriptors. |
| `@peezy.tech/codex-flows/threads` | Raw Codex rollout locate, inspect, install, and transplant helpers. |
| `@peezy.tech/codex-flows/workspace-backend` | Internal workspace JSON-RPC protocol server/client helpers and capability primitives used by the agent. |
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

Browser entry for freeform dashboards:

```ts
import { createCodexFlowsBrowserClient } from "@peezy.tech/codex-flows/browser";

const codexFlows = createCodexFlowsBrowserClient();
const schema = await codexFlows.schema();
const threads = await codexFlows.app.call("thread/list", { limit: 20 });
```

The browser package only talks to the optional HTTP proxy with `fetch`; it does
not include a WebSocket app-server or workspace client.

## Turn Automation

```ts
import { runTurnAutomationScript } from "@peezy.tech/codex-flows";

const run = await runTurnAutomationScript({
	scriptPath: "./automations/check-release/check-release.ts",
	event: { type: "upstream.release", payload: { tag: "v1.2.3" } },
	cwd: "/repo",
	timeoutMs: 90_000,
});

console.log(run.result);
```

Turn automation runs code before returning a JSON result. Scripts can start one
native Codex turn or compose several turns through `context.turn.start`,
`context.turn.read`, and `context.turn.wait`. When running through a codex-flows
agent, scripts can also start delegated Codex threads in another checkout with
`context.delegate.start({ cwd: "@/workspaces/name", prompt })`.

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

The package publishes the `codex-flows` CLI and the optional
`codex-flows-proxy` web edge:

```bash
codex-flows fetch
codex-flows agent serve --cwd /repo
codex-flows --ssh devbox --cwd /repo remote preflight
codex-flows turn run "Check workspace status" --wait
codex-flows automation list
codex-flows automation run openai-codex-bindings --event event.json
codex-flows --ssh devbox --cwd /repo automation run openai-codex-bindings --event event.json
codex-flows --ssh devbox --cwd /repo fetch
codex-flows --ssh devbox --cwd /repo app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-flows --ssh devbox --cwd /repo functions list --json
codex-flows --ssh devbox --cwd /repo functions call portfolioSnapshot --json
codex-flows --ssh devbox --cwd /repo turn run "Scan current folder" --wait --sandbox danger-full-access --approval-policy never
codex-flows app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-flows workspace app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-flows workspace delegate start --cwd @/workspaces/trading --prompt "Inspect status"
codex-flows workspace doctor
codex-flows workspace tick --mode local
codex-flows memories transplant global-to-workspace
codex-flows threads transplant <thread-id> --from-codex-home ~/.codex --to-codex-home ./.codex

codex-flows-proxy serve --cwd /repo --static ./dashboard
codex-flows-proxy serve --ssh devbox --cwd /repo --static ./dashboard
```

See `docs/pages/reference/cli.md` for the full command surface.

Local CLI, MCP, automation, functions, and delegation use a spawned
`codex-flows agent serve` process over stdio. With `--ssh`, the local CLI starts
the same agent on the target and speaks JSON-RPC over the SSH stdio stream. No
codex-flows core command opens a WebSocket port. Browser dashboards opt into HTTP
explicitly by starting `codex-flows-proxy`, whose schema is derived from the
agent's advertised methods instead of duplicated route logic.

For non-interactive SSH PATH differences, set `CODEX_FLOWS_REMOTE_PATH_PREPEND`,
`CODEX_FLOWS_AGENT_COMMAND`, `CODEX_FLOWS_REMOTE_CODEX_COMMAND`, or
`CODEX_FLOWS_REMOTE_CODEX_ARGS` JSON arrays. The remote target needs `node`,
`codex-flows`, and `codex`.

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
