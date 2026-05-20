export type FlowEvent<TPayload = unknown> = {
	id: string;
	type: string;
	source?: string;
	occurredAt?: string;
	receivedAt: string;
	payload: TPayload;
};

export type FlowResultStatus =
	| "skipped"
	| "completed"
	| "changed"
	| "needs_intervention"
	| "blocked"
	| "failed";

export type FlowResult = {
	status: FlowResultStatus;
	message?: string;
	artifacts?: Record<string, unknown>;
	next?: Array<FlowEvent<Record<string, unknown>>>;
	[key: string]: unknown;
};

export type FlowStepRunner = "node" | "code-mode";

export type FlowStepTrigger = {
	type: string;
	schema?: string;
};

export type FlowStep = {
	name: string;
	runner: FlowStepRunner;
	script: string;
	timeoutMs: number;
	cwd?: string;
	trigger?: FlowStepTrigger;
};

export type FlowManifest = {
	name: string;
	version: number;
	description?: string;
	config?: Record<string, unknown>;
	guidance?: {
		skills?: string[];
	};
	steps: FlowStep[];
};

export type LoadedFlow = {
	root: string;
	manifestPath: string;
	manifest: FlowManifest;
};

export type FlowRunRuntimeContext = {
	eventId: string;
	runId?: string;
	attemptId?: string;
	replay: boolean;
	workspaceBackendUrl?: string;
	launchedBy?: string;
};

export type FlowRunRuntimeInput = Partial<FlowRunRuntimeContext>;

export type FlowRunContext = {
	flow: {
		name: string;
		version: number;
		root: string;
		step: string;
		config?: Record<string, unknown>;
		event: FlowEvent;
	};
	runtime: FlowRunRuntimeContext;
};
