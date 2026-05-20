import { codexFlowsCodeModeEnabled } from "@peezy.tech/codex-flows";
import { runBunStep } from "./runners/bun.ts";
import { runCodeModeStep, type RunCodeModeStepOptions } from "./runners/code-mode.ts";
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
	codeMode?: Pick<RunCodeModeStepOptions, "codexCommand" | "codexHome" | "stream">;
	progress?: FlowProgressSink;
};

export async function runFlowStep(options: RunFlowStepOptions): Promise<FlowResult> {
	if (options.step.runner === "bun") {
		return runBunStep(options);
	}
	if (!codeModeEnabled(options.env ?? process.env)) {
		throw new Error(
			`Code Mode flow step ${options.flow.manifest.name}/${options.step.name} requires CODEX_FLOWS_ENABLE_CODE_MODE=1`,
		);
	}
	return runCodeModeStep({
		flow: options.flow,
		step: options.step,
		event: options.event,
		...options.codeMode,
		progress: options.progress,
	});
}

export function codeModeEnabled(env: Record<string, string | undefined>): boolean {
	return codexFlowsCodeModeEnabled(env);
}
