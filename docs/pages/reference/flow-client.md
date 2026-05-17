---
title: Flow client
description: Common local and HTTP client API.
---

# Flow client

The common client lives at `@peezy.tech/codex-flows/flow-runtime/client`.

```ts
export type FlowClient = {
  listRuns(options?: FlowListRunsOptions): Promise<FlowRunList>;
  getRun(runId: string): Promise<FlowRunView>;
  listEvents(options?: FlowListEventsOptions): Promise<FlowEventList>;
  getEvent(eventId: string): Promise<FlowEventView>;
  dispatchEvent(event: FlowEvent, options?: FlowDispatchOptions): Promise<FlowDispatchResult>;
  replayEvent(eventId: string, options?: FlowReplayOptions): Promise<FlowReplayResult>;
  cancelRun(runId: string): Promise<FlowCancelResult>;
};
```

## Factory

```ts
const flows = createFlowClient({
  mode: "local",
  cwd: process.cwd(),
});
```

```ts
const flows = createFlowClient({
  mode: "http",
  baseUrl: "http://127.0.0.1:7345",
  hmacSecret: process.env.CODEX_FLOW_BACKEND_SECRET,
});
```

## Local options

```ts
type LocalFlowClientOptions = {
  cwd: string;
  roots?: string[];
  env?: Record<string, string | undefined>;
  state?: false | "memory" | { kind: "file"; dataDir?: string };
  codex?: {
    mode?: "stdio";
    command?: string;
    codexHome?: string;
    stream?: boolean;
  };
};
```

Local mode runs matching steps synchronously. `cancelRun` is unsupported in
local synchronous mode. `wait: false` is unsupported until a worker loop exists.

## View model

Run views expose process status, semantic result status, `effectiveStatus`,
`needsAttention`, attempt records, output, latest output, result payload, and
the raw backend or local record.
