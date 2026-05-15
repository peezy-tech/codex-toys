import type { FlowEvent, FlowResultStatus } from "./types.ts";

export type FlowProcessStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "canceled"
	| string;

export type FlowEffectiveStatus = FlowProcessStatus | FlowResultStatus;

export type FlowListRunsOptions = {
	eventId?: string;
	status?: string;
	limit?: number;
};

export type FlowListEventsOptions = {
	type?: string;
	limit?: number;
};

export type FlowDispatchOptions = {
	wait?: boolean;
};

export type FlowReplayOptions = {
	wait?: boolean;
};

export type FlowOutputView = {
	kind: string;
	text: string;
	createdAt?: string;
	raw: unknown;
};

export type FlowAttemptView = {
	id: string;
	status?: string;
	attemptNumber?: number;
	workerId?: string;
	leaseExpiresAt?: number;
	startedAt?: string;
	completedAt?: string;
	error?: string;
	raw: unknown;
};

export type FlowRunView = {
	id: string;
	eventId?: string;
	flowName?: string;
	flowVersion?: number;
	stepName?: string;
	runner?: string;
	backend?: string;
	processStatus?: FlowProcessStatus;
	resultStatus?: FlowResultStatus;
	status: FlowEffectiveStatus;
	effectiveStatus: FlowEffectiveStatus;
	needsAttention: boolean;
	attemptCount: number;
	attempts: FlowAttemptView[];
	output: FlowOutputView[];
	latestOutput?: FlowOutputView;
	resultPayload?: unknown;
	error?: string;
	createdAt?: string;
	startedAt?: string;
	completedAt?: string;
	updatedAt?: string;
	raw: unknown;
};

export type FlowEventView = {
	id: string;
	type?: string;
	source?: string;
	occurredAt?: string;
	receivedAt?: string;
	payload?: unknown;
	runIds: string[];
	runs: FlowRunView[];
	createdAt?: string;
	raw: unknown;
};

export type FlowRunList = {
	runs: FlowRunView[];
	eventId?: string;
	raw: unknown;
};

export type FlowEventList = {
	events: FlowEventView[];
	raw: unknown;
};

export type FlowDispatchResult = {
	status?: string;
	eventId?: string;
	runIds: string[];
	matched?: number;
	idempotent?: boolean;
	event?: FlowEventView;
	runs: FlowRunView[];
	raw: unknown;
};

export type FlowReplayResult = FlowDispatchResult;

export type FlowCancelResult = {
	run: FlowRunView;
	raw: unknown;
};

export type FlowClient = {
	listRuns(options?: FlowListRunsOptions): Promise<FlowRunList>;
	getRun(runId: string): Promise<FlowRunView>;
	listEvents(options?: FlowListEventsOptions): Promise<FlowEventList>;
	getEvent(eventId: string): Promise<FlowEventView>;
	dispatchEvent(event: FlowEvent, options?: FlowDispatchOptions): Promise<FlowDispatchResult>;
	replayEvent(eventId: string, options?: FlowReplayOptions): Promise<FlowReplayResult>;
	cancelRun(runId: string): Promise<FlowCancelResult>;
};
