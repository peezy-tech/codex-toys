# @peezy.tech/flow-runtime

Generic runtime primitives for Codex flow packages.

This package loads `flow.toml` manifests, matches generic events to flow steps,
validates JSON-schema payloads, and runs steps with the Bun or feature-flagged
Code Mode runners.

```ts
import { discoverFlows, matchingSteps, runFlowStep } from "@peezy.tech/flow-runtime";
```

## Bun Step Helpers

`runner = "bun"` still supports raw scripts that read JSON from stdin and print
`FLOW_RESULT`. The recommended authoring shape is a module default export:

```ts
import {
	defineBunFlow,
	createCodexFlowClientFromContext,
} from "@peezy.tech/flow-runtime/bun";

export default defineBunFlow(async (ctx) => {
	const codex = createCodexFlowClientFromContext(ctx);
	try {
		const turn = await codex.startFlow({
			threadId: typeof ctx.flow.event.payload.threadId === "string"
				? ctx.flow.event.payload.threadId
				: undefined,
			prompt: "Continue this workspace task.",
			wait: false,
		});
		return {
			status: "needs_intervention",
			artifacts: { threadId: turn.threadId, turnId: turn.turnId },
		};
	} finally {
		codex.close();
	}
});
```

The helper uses `ctx.runtime.workspaceBackendUrl` or
`CODEX_WORKSPACE_BACKEND_WS_URL` so the step calls the same workspace backend
that launched the run.

## Flow Client

`@peezy.tech/flow-runtime/client` exposes a small flow-native client factory for
product code that should not care whether flows run locally or through an HTTP
backend:

```ts
import { createFlowClient } from "@peezy.tech/flow-runtime/client";

const flows = createFlowClient({
	mode: "local",
	cwd: process.cwd(),
});

await flows.dispatchEvent({
	id: "patch:upstream.release:openai/codex:rust-v1.2.3",
	type: "upstream.release",
	source: "patch",
	receivedAt: new Date().toISOString(),
	payload: { repo: "openai/codex", tag: "rust-v1.2.3" },
});
```

Use `mode: "http"` to wrap the existing backend HTTP client:

```ts
const flows = createFlowClient({
	mode: "http",
	baseUrl: "http://127.0.0.1:7345",
	hmacSecret: process.env.PATCH_FLOW_DISPATCH_SECRET,
});
```

`@peezy.tech/flow-runtime/local-client` runs matching steps synchronously in the
selected workspace and keeps in-memory run/event state by default. Set
`state: { kind: "file" }` to persist local run/event state under
`.codex/flow-client`. It preserves the generic `FlowEvent` and `FLOW_RESULT`
contracts; callers still provide deterministic event ids when idempotency
matters.

## Backend Client

`@peezy.tech/flow-runtime/backend-client` exposes backend-native inspection and
control for generic flow state. It is intentionally separate from app-server
thread commands: runs, events, attempts, replay, cancel, output, and
`FLOW_RESULT` payloads belong to flow backends.

```ts
import { createFlowBackendHttpClient } from "@peezy.tech/flow-runtime/backend-client";

const backend = createFlowBackendHttpClient({
	baseUrl: "http://127.0.0.1:7345",
	bearerToken: process.env.CODEX_FLOW_BACKEND_TOKEN,
});

const { runs } = await backend.listRuns({ status: "completed", limit: 20 });
```

The client normalizes workspace-local, Convex-adapter, and codex-service-style
run/event responses into stable view models with `processStatus`,
`resultStatus`, `effectiveStatus`, `needsAttention`, attempts, latest output,
and result payload data. Semantic statuses such as `blocked` and
`needs_intervention` are read from `FLOW_RESULT` payloads when the backend
stores them separately from process status.

Code Mode steps remain gated. Enable them with:

```bash
CODEX_FLOWS_MODE=code-mode
```
