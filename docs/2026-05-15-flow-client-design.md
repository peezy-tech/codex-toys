# Flow Client Design - 2026-05-15

This note designs the next reusable client layer for Codex flows. It builds on
the current split between `@peezy.tech/flow-runtime`,
`@peezy.tech/flow-runtime/backend-client`, `codex-flow-runner`, and
`codex-flow-systemd-local`.

## Intent

Consumers such as `patch.moi` should be able to use Codex flows as a product
capability without caring whether execution is backendless in the current
workspace or delegated to a flow backend.

The event-shaped contract remains the stable ABI. The client hides ceremony,
not semantics:

- flow packages still receive `FlowEvent` through the existing runner context
- steps still emit `FLOW_RESULT`
- backend dispatch still uses `event.id` for idempotency
- app-owned domain completion stays outside generic flow clients and backends

The product-facing experience can be direct:

```bash
patch upstream release openai/codex rust-v1.2.3
```

Patch can translate that into:

```ts
await flows.dispatchEvent({
	id: "patch:upstream.release:openai/codex:rust-v1.2.3",
	type: "upstream.release",
	source: "patch",
	receivedAt: new Date().toISOString(),
	payload: {
		repo: "openai/codex",
		tag: "rust-v1.2.3",
	},
});
```

## Existing Surfaces

`@peezy.tech/flow-runtime` already provides the local building blocks:

- `discoverFlows({ cwd, roots })`
- `matchingSteps(flows, event)`
- `runFlowStep({ flow, step, event, env, codeMode })`
- Bun and gated Code Mode runners
- JSON Schema trigger validation

`codex-flow-runner` proves backendless execution works, but only as a CLI over
event JSON files. It does not expose a reusable client object, normalized
run/event views, local idempotency, or replay/list APIs.

`codex-flow-systemd-local` provides durable backend behavior:

- `POST /events`
- `GET /events`
- `GET /runs`
- `POST /events/:id/replay`
- process status in backend records
- semantic result status in `FLOW_RESULT`
- idempotency by `event.id`

`@peezy.tech/flow-runtime/backend-client` normalizes HTTP backend responses and
already covers backend-native list/get/dispatch/replay/cancel operations.

`patch.moi` currently builds `FlowEvent` objects from feed signals and POSTs
them to a configured backend URL. The same product should also support a local
CLI mode where flows run in the current repository without a daemon.

## Proposed Packages

Add two subpath exports to `@peezy.tech/flow-runtime`:

- `@peezy.tech/flow-runtime/local-client`
- `@peezy.tech/flow-runtime/client`

Keep the existing:

- `@peezy.tech/flow-runtime/backend-client`

`local-client` owns backendless execution. `backend-client` owns remote backend
HTTP access. `client` is a tiny factory and shared type surface over both.

No new package named `sdk` should be introduced.

## Client API

The common client should expose flow-native operations:

```ts
export type FlowClient = {
	listRuns(options?: FlowListRunsOptions): Promise<FlowRunList>;
	getRun(runId: string): Promise<FlowRunView>;
	listEvents(options?: FlowListEventsOptions): Promise<FlowEventList>;
	getEvent(eventId: string): Promise<FlowEventView>;
	dispatchEvent(event: FlowEvent, options?: FlowDispatchOptions): Promise<FlowDispatchResult>;
	replayEvent(eventId: string, options?: FlowReplayOptions): Promise<FlowDispatchResult>;
	cancelRun(runId: string): Promise<FlowCancelResult>;
};
```

The view models should be neutral aliases or successors of the current backend
views:

- `FlowRunView`
- `FlowEventView`
- `FlowDispatchResult`
- `FlowRunList`
- `FlowEventList`

They should preserve the fields proven by `backend-client`:

- process status
- semantic `FLOW_RESULT` status
- `effectiveStatus`
- `needsAttention`
- attempts
- output
- latest output
- result payload
- raw backend/local record

The term `backend` can remain as a field value, but common client names should
not force local execution to pretend it is a backend.

## Factory

The factory should be discriminated by mode:

```ts
const flows = createFlowClient({
	mode: "local",
	cwd: process.cwd(),
});
```

```ts
const flows = createFlowClient({
	mode: "http",
	baseUrl: process.env.PATCH_FLOW_BACKEND_URL,
	hmacSecret: process.env.PATCH_FLOW_DISPATCH_SECRET,
});
```

`mode: "http"` should wrap `createFlowBackendHttpClient()`.

`mode: "local"` should wrap `createLocalFlowClient()`.

## Local Client

Local mode should execute matching flow steps directly in the selected
workspace:

```ts
export type LocalFlowClientOptions = {
	cwd: string;
	roots?: string[];
	env?: Record<string, string | undefined>;
	state?: false | "memory" | {
		kind: "file";
		dataDir?: string;
	};
	codex?: LocalFlowCodexOptions;
};
```

Discovery follows the runtime default unless roots are provided:

- `.codex/flows/*`
- `flows/*`

The first implementation should support `state: "memory"` by default. That is
enough for direct CLI runs and tests. A file-backed state mode can be added next
under `.codex/flow-runs` or `.codex/flow-client` without introducing a daemon.

Local dispatch behavior:

- normalize the incoming `FlowEvent`
- discover flows
- match trigger type and schema
- create one run view per matching step
- execute steps using `runFlowStep`
- return a normalized dispatch result
- mark semantic `blocked` and `needs_intervention` as attention states

For local mode, `dispatchEvent` should run synchronously by default. A future
`wait: false` local option can queue to file state, but it should not fake async
behavior before there is a worker loop.

## Idempotency And Replay

The client must not silently generate random ids for normal dispatch. A product
can hide event construction, but it must still provide a deterministic event id
or idempotency key when duplicate suppression matters.

Recommended product helper pattern:

```ts
const event = patchUpstreamReleaseEvent({
	repo: "openai/codex",
	tag: "rust-v1.2.3",
});
await flows.dispatchEvent(event);
```

HTTP mode inherits backend idempotency and replay semantics:

- duplicate `event.id` dispatch returns the backend's duplicate/idempotent
  response
- `replayEvent(eventId)` creates a new backend attempt

Local memory mode can dedupe duplicate event ids only for the lifetime of the
client process. File-backed local state should make idempotency durable and make
`replayEvent(eventId)` create a new local attempt.

If local state is disabled, `listEvents`, `getEvent`, `listRuns`, `getRun`, and
`replayEvent` should fail with a clear unsupported-state error rather than
returning misleading empty data.

## Code Mode Configuration

Flow orchestration location and Codex execution location are separate axes.

Local flow execution can still use a local or remote Codex executor for
`runner = "code-mode"` steps.

Initial local Code Mode support should preserve current behavior:

```ts
codex: {
	mode: "stdio",
	command: process.env.CODEX_APP_SERVER_CODEX_COMMAND,
	codexHome: process.env.CODEX_HOME,
	stream: true,
}
```

The design should leave room for:

```ts
codex: {
	mode: "remote",
	url: "https://codex-worker.internal",
	headers: { authorization: "Bearer ..." },
}
```

Remote Code Mode should not be added until `runCodeModeStep` has a real remote
app-server transport. Do not simulate remote Codex by shelling out through
unrelated HTTP APIs.

Code Mode remains gated by `CODEX_FLOWS_MODE=code-mode` or
`CODEX_FLOWS_ENABLE_CODE_MODE=1`.

## Workspace Configuration

The existing `.codex/workspace.toml` is already used for Discord gateway
surfaces. Flow client configuration can use the same file, but should stay in a
separate table:

```toml
[flows]
mode = "local"
roots = ["flows"]
state = "memory"

[flows.codex]
mode = "stdio"
stream = true
```

Patch can resolve configuration in this order:

1. CLI flags
2. environment variables
3. `.codex/workspace.toml`
4. defaults

The Discord-specific `[[discord.gateway.surfaces]]` table must remain unrelated
to flow execution.

## Patch Integration

Patch should be able to use one abstraction in both roles:

- CLI utility run from a fork checkout
- feed watching service that dispatches upstream activity

Suggested Patch adapter:

```ts
const flows = createFlowClientFromPatchConfig({
	cwd,
	env: process.env,
});
```

Resolution:

- if a backend URL is configured, use `mode: "http"`
- otherwise use `mode: "local"` in the current workspace

The existing Patch server can replace its hand-rolled fetch/HMAC dispatch logic
with the HTTP client mode. The future Patch CLI can use local mode by default.

Patch-specific commands should create domain events but not bypass the generic
flow ABI:

```bash
patch upstream release openai/codex rust-v1.2.3
patch flow fire upstream.release --repo openai/codex --tag rust-v1.2.3
patch flow runs
```

## Boundaries

This client is not an app-server SDK. It must not expose convenience wrappers
for app-server thread methods such as `setGoal`, `readThread`, `startTurn`, or
`renameThread`.

The client owns generic flow concerns:

- event dispatch
- flow discovery
- local step execution
- backend dispatch
- run/event normalization
- replay/cancel when supported by the selected mode

It does not own:

- Patch fork policy
- organization release rules
- pet-game asset registration
- payment state
- minting
- Discord gateway write tools
- arbitrary app-server command wrappers

Domain completion remains app-owned. A flow result can say work completed or
needs intervention; the consuming app decides what that means in its product.

## Implementation Plan

1. Extract neutral view model names from `backend-client` without breaking the
   existing backend-client export.
2. Add `local-client` with in-memory state and synchronous dispatch.
3. Add `client` factory that returns local or HTTP clients.
4. Refactor `codex-flow-runner` to use the local client internally.
5. Add optional file-backed local state for durable idempotency, list/get, and
   replay.
6. Update Patch to consume the common client instead of hand-rolled HTTP
   dispatch.
7. Add `.codex/workspace.toml` flow configuration support only after the direct
   constructor API is stable.

## Test Plan

Local client tests:

- discovers `.codex/flows/*` before `flows/*`
- dispatches one event to all matching steps
- returns normalized run/event/result views
- preserves `FLOW_RESULT.status` as semantic result status
- marks `blocked` and `needs_intervention` as `needsAttention`
- forwards Code Mode configuration to `runFlowStep`
- rejects replay/list/get when durable or memory state does not contain the
  requested event/run
- dedupes duplicate event ids in memory mode

HTTP factory tests:

- delegates to `FlowBackendHttpClient`
- preserves HMAC/header/auth construction
- returns the same normalized payload shape as direct backend-client use

CLI and Patch-oriented tests:

- `codex-flow-runner fire` continues to produce the existing payload shape
- Patch can select local mode when no backend URL is configured
- Patch can select HTTP mode when a backend URL is configured
- Patch product helpers create deterministic event ids for fork-maintenance
  commands

## Open Decisions

The first implementation can proceed with conservative defaults, but these
should be decided before exposing a stable CLI promise:

- whether local mode should default to in-memory state or file state
- exact default local state directory if file state is enabled
- whether local dispatch should ever support `wait: false`
- final remote Code Mode transport shape
- whether `cancelRun` in local synchronous mode should be unsupported or tied to
  a future worker process
