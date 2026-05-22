import { runNodeStep } from "./runners/node.ts";
import type { FlowProgressSink } from "./client-types.ts";
import type {
	FlowEvent,
	FlowResult,
	FlowRunRuntimeInput,
	FlowStep,
	LoadedFlow,
} from "./types.ts";

export type RunFlowStepOptions = {
	flow: LoadedFlow;
	step: FlowStep;
	event: FlowEvent;
	env?: Record<string, string | undefined>;
	runtime?: FlowRunRuntimeInput;
	progress?: FlowProgressSink;
};

export async function runFlowStep(options: RunFlowStepOptions): Promise<FlowResult> {
	return runNodeStep(options);
}
