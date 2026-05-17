import type { FlowEvent, FlowResult, FlowStep } from "@peezy.tech/codex-flows/flow-runtime";

export type ConvexFlowRunStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "canceled";

export type ConvexFlowAttemptStatus = Exclude<ConvexFlowRunStatus, "queued">;

export type ConvexFlowOutputKind = "system" | "stdout" | "stderr" | "agent";

export type SyncedFlowStep = FlowStep & {
	trigger?: FlowStep["trigger"] & {
		schemaJson?: unknown;
	};
};

export type SyncedFlowManifest = {
	name: string;
	version: number;
	description?: string;
	root?: string;
	config?: Record<string, unknown>;
	steps: SyncedFlowStep[];
};

export type ClaimedConvexFlowRun<TPayload = unknown> = {
	runId: string;
	attemptId: string;
	leaseToken: string;
	leaseExpiresAt: number;
	flowName: string;
	stepName: string;
	runner: FlowStep["runner"];
	event: FlowEvent<TPayload>;
};

export type DispatchConvexFlowEventResult = {
	status: "accepted" | "duplicate";
	eventId: string;
	runIds: string[];
	matched: number;
};

export type CompleteConvexFlowRunInput = {
	attemptId: string;
	leaseToken: string;
	result: FlowResult;
};
