# codex-toys

CLI and umbrella runtime export for the codex-toys package stack.

```bash
pnpm add codex-toys
```

or:

```bash
npm install codex-toys
```

Actions-mode runner images are published with each release:

```text
ghcr.io/peezy-tech/codex-toys-actions:<version>
ghcr.io/peezy-tech/codex-toys-actions:latest
ghcr.io/peezy-tech/codex-toys-actions:codex-<codex-version>
```

The `codex-<codex-version>` tags are rebuilt by the OpenAI Codex release feed
with native Codex pinned before the bindings workflow runs.

Full documentation lives in the repo docs site and is also published as a
version-matched Markdown snapshot under `docs/pages` in the npm tarball:

- overview: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/index.md>
- workflow: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/primitives/workflow.md>
- workbench: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/primitives/workbench.md>
- dispatch and queues: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/primitives/dispatch-queues.md>
- feed: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/primitives/feed.md>
- toybox: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/components/toybox.md>
- proxy: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/components/proxy.md>
- kits: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/components/kits.md>
- CLI reference: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/components/cli.md>
- repository autonomy: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/guides/repository-autonomy.md>
- remote Codex workbench: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/guides/remote-codex-workbench.md>
- local scheduled workbench: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/guides/local-scheduled-workbench.md>
- dashboard over toybox: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/guides/dashboard-over-toybox.md>
- feed to workflow: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/guides/feed-to-workflow.md>
- capability kit setup: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/guides/capability-kit-setup.md>
- delegated repo work: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/guides/delegated-repo-work.md>
- Codex state moves: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/operations/codex-state.md>
- plugin install: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/operations/plugins.md>
- package reference: <https://github.com/peezy-tech/codex-toys/blob/main/docs/pages/reference/packages.md>

## Public Imports

`codex-toys` is the only public npm package. Runtime surfaces are available
from focused subpaths:

| Import | Purpose |
|--------|---------|
| `codex-toys/bridge` | Native Codex app-server, auth, memory, thread, JSON-RPC, and generated protocol bridge primitives. |
| `codex-toys/toybox` | Stdio JSON-RPC toybox client/server protocol. |
| `codex-toys/feed` | Durable RSS/Atom polling, manual feed item append, source checkpoints, feed items, and collection cursors. |
| `codex-toys/workbench` | Workbench runtime, delegation, prompt queue, handoff, functions, workflow, and overview primitives. |
| `codex-toys/actions` | GitHub/Forgejo Actions auth and state helpers. |
| `codex-toys/remote` | SSH-backed toybox transports and remote control helpers. |
| `codex-toys/proxy` | Optional HTTP proxy, browser client, Vite middleware, and `codex-toys-proxy` binary. |
| `codex-toys/kits` | Kit inspect/add/list/doctor helpers for `codex-kit.toml` and `.codex/kit-lock.json`. |
| `codex-toys` | Umbrella runtime export. |

## App-Server Client

```ts
import { CodexAppServerClient } from "codex-toys/bridge";

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
import { createCodexToysBrowserClient } from "codex-toys/proxy/browser";

const codexToys = createCodexToysBrowserClient();
const schema = await codexToys.schema();
const threads = await codexToys.app.call("thread/list", { limit: 20 });
```

The browser package only talks to the optional HTTP proxy with `fetch`; it does
not include a WebSocket app-server or workbench client. Direct proxy API CORS is
loopback-only (`localhost`, `127.0.0.1`, `::1`, and `*.localhost`); local
dashboards can also avoid CORS entirely by using the Vite plugin or proxy
`--static` same-origin serving.

## Feed

```ts
import {
	createFeedContext,
	loadFeedConfig,
	pollFeedSources,
	collectFeedItems,
} from "codex-toys/feed";

const context = await createFeedContext({ root: "/repo", mode: "local" });
const config = await loadFeedConfig(context);

await pollFeedSources(context, config, { sourceId: "openai-blog" });
const batch = await collectFeedItems(context, { cursor: "radar" });
```

Feed reads `.codex/feed.toml`, accepts manual item append, writes mode-scoped
state under `.codex/feed/*`, and leaves product-specific scoring, prompt policy,
and dispatch to consumers.

## Workflow

```ts
import { runWorkflowScript } from "codex-toys/workbench";

const run = await runWorkflowScript({
	scriptPath: "./workflows/release-check/check.ts",
	event: { type: "upstream.release", payload: { tag: "v1.2.3" } },
	cwd: "/repo",
	timeoutMs: 90_000,
});

console.log(run.result);
```

Workflow runs code before returning a JSON result. Scripts can start one
native Codex turn or compose several turns through `context.turn.start`,
`context.turn.read`, and `context.turn.wait`. When running through a codex-toys
toybox, scripts can also start delegated Codex threads in another checkout with
`context.delegate.start({ cwd: "@/workbenches/name", prompt })`.

## Auth Helpers

```ts
import {
	CodexAppServerClient,
	createCodexAuthClient,
} from "codex-toys/bridge";

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

`codex-toys/workbench` owns workbench policy, queues, workflow execution,
delegation methods, functions, overview, and thread presentation helpers. When a
workflow or delegation needs Codex work, it constructs native app-server calls
through a supplied host request function:

```ts
import { threadGoalSetDescriptor } from "codex-toys/workbench";

const action = threadGoalSetDescriptor({
	threadId,
	objective: "Finish the release checks.",
	status: "active",
	tokenBudget: 8000,
});

await client.request(action.method, action.params);
```

The app-server protocol remains the source of truth for native thread and turn
commands.

## CLI

The `codex-toys` package publishes both the main CLI and the optional
`codex-toys-proxy` web edge:

```bash
codex-toys fetch
codex-toys toybox serve --cwd /repo
codex-toys --ssh <target> --cwd <remote-workbench> remote preflight
codex-toys turn run "Check workbench status" --wait
codex-toys workflow list
codex-toys feed poll --json
codex-toys feed collect --cursor radar --json
codex-toys workflow run <name> --event event.json
codex-toys --ssh <target> --cwd <remote-workbench> workflow run <name> --event event.json
codex-toys --ssh <target> --cwd <remote-workbench> fetch
codex-toys --ssh <target> --cwd <remote-workbench> app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-toys --ssh <target> --cwd <remote-workbench> functions list --json
codex-toys --ssh <target> --cwd <remote-workbench> turn run "Scan current folder" --wait --sandbox danger-full-access --approval-policy never
codex-toys app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-toys workbench app thread/list --params-json '{"limit":20,"sourceKinds":[]}'
codex-toys workbench delegate start --cwd @/repos/example --prompt "Inspect status"
codex-toys workbench doctor
codex-toys workbench run daily-review --mode local
codex-toys workbench prompt enqueue "Review later." --queue low-priority --effort low
codex-toys workbench prompt run-due --queue low-priority --limit 1
codex-toys workbench prompt collect --queue low-priority --json
codex-toys workbench handoff enqueue "Test the dashboard locally." --capability browser
codex-toys workbench handoff drain --capability browser --materialize --prompt-queue local-followups
codex-toys workbench dispatch create --params-json '{"target":{"kind":"turn","prompt":"Review later."}}'
codex-toys workbench dispatch list --json
codex-toys workbench dispatch prune --older-than-days 30 --dry-run
codex-toys memories transplant global-to-workbench
codex-toys threads transplant <thread-id> --from-codex-home ~/.codex --to-codex-home ~/.codex --cwd "$PWD"

codex-toys-proxy serve --cwd /repo --static ./dashboard
codex-toys-proxy serve --ssh <target> --cwd <remote-workbench> --static ./dashboard
```

See `docs/pages/components/cli.md` for the full command surface.

Use systemd user timers or Actions schedules to run explicit workbench and feed
commands. `workbench doctor` reports workbench state; scheduler visibility
belongs to the host scheduler.

Local CLI, MCP, workflow, functions, and delegation use a spawned
`codex-toys toybox serve` process over stdio. With `--ssh`, the local CLI starts
the same toybox on the target and speaks JSON-RPC over the SSH stdio stream. No
codex-toys core command opens a WebSocket port. Browser dashboards opt into HTTP
explicitly by starting `codex-toys-proxy`, whose schema is derived from the
toybox's advertised methods instead of duplicated route logic. The direct proxy
API reflects CORS only for loopback browser origins.

For non-interactive SSH PATH differences, set `CODEX_TOYS_REMOTE_PATH_PREPEND`,
`CODEX_TOYS_TOYBOX_COMMAND`, `CODEX_TOYS_REMOTE_CODEX_COMMAND`, or
`CODEX_TOYS_REMOTE_CODEX_ARGS` JSON arrays. The remote target needs `node`,
`codex-toys`, and `codex`.

## Development Scripts

```bash
vp run --filter codex-toys build
vp run --filter codex-toys check:types
vp run --filter codex-toys test
vp run --filter codex-toys pack:dry-run
vp run --filter codex-toys release:check
```

`build` emits ESM JavaScript, source maps, and declaration files into `dist`.
`release:check` runs tests, type checking, a clean build, export smoke tests,
and a tarball install smoke test. The public pack script also copies
`docs/pages` into the tarball and rejects built docs assets.

Generated protocol files live in `src/app-server/generated`. Keep handwritten
client and transport code outside that generated tree.
