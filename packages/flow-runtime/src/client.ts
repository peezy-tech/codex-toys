import {
	createFlowBackendHttpClient,
	type FlowBackendHttpClientOptions,
} from "./backend-client.ts";
import {
	createLocalFlowClient,
	type LocalFlowClientOptions,
} from "./local-client.ts";
import type { FlowClient } from "./client-types.ts";
export type {
	FlowAttemptView,
	FlowCancelResult,
	FlowClient,
	FlowDispatchOptions,
	FlowDispatchResult,
	FlowEffectiveStatus,
	FlowEventList,
	FlowEventView,
	FlowListEventsOptions,
	FlowListRunsOptions,
	FlowOutputView,
	FlowProcessStatus,
	FlowReplayOptions,
	FlowReplayResult,
	FlowRunList,
	FlowRunView,
} from "./client-types.ts";

export type FlowClientOptions =
	| ({ mode: "local" } & LocalFlowClientOptions)
	| ({ mode: "http" } & FlowBackendHttpClientOptions);

export function createFlowClient(options: FlowClientOptions): FlowClient {
	if (options.mode === "local") {
		const { mode: _mode, ...localOptions } = options;
		return createLocalFlowClient(localOptions);
	}
	const { mode: _mode, ...httpOptions } = options;
	return createFlowBackendHttpClient(httpOptions);
}
