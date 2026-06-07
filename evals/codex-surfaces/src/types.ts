export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type TokenUsageBreakdown = {
	totalTokens: number;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
};

export type TokenUsageSummary =
	| { status: "known"; total: TokenUsageBreakdown }
	| { status: "unknown" };

export type ScenarioPermissions = {
	sandbox?: string;
	approvalPolicy?: string;
	permissions?: string;
};

export type OracleConfig =
	| { type: "finalTextIncludes"; text: string }
	| { type: "finalTextMatches"; pattern: string; flags?: string }
	| { type: "eventTypeSeen"; eventType: NormalizedEvent["type"] }
	| { type: "eventMethodSeen"; method: string }
	| { type: "commandSeen"; pattern: string; flags?: string }
	| { type: "fileExists"; path: string }
	| { type: "jsonPathEquals"; file: string; path: string; equals: JsonValue };

export type Scenario = {
	id: string;
	title: string;
	description: string;
	prompt: string;
	targetCwd?: string;
	timeoutMs?: number;
	permissions?: ScenarioPermissions;
	tags?: string[];
	expectedArtifacts?: string[];
	nativePacket?: {
		checklist?: string[];
		affordanceHints?: string[];
	};
	oracle: OracleConfig[];
};

export type ProfileKind = "closed-app-server" | "native-app";

export type Profile = {
	id: string;
	label: string;
	kind: ProfileKind;
	description: string;
	toysEnabled: boolean;
	codexHomeMode: "global" | "repo-local" | "operator-app";
	affordances: string[];
	promptAddendum?: string;
	appServer?: {
		codexCommand?: string;
		args?: string[];
		env?: Record<string, string>;
		requestTimeoutMs?: number;
	};
	taskPacket?: {
		operatorInstructions: string[];
	};
};

export type RunManifest = {
	id: string;
	scenarioId: string;
	profileId: string;
	profileKind: ProfileKind;
	status: "created" | "running" | "completed" | "failed";
	createdAt: string;
	updatedAt: string;
	repoRoot: string;
	targetCwd: string;
	runDir: string;
	threadId?: string;
	turnId?: string;
	sessionJsonl?: string;
	packetPath?: string;
	notes?: string[];
};

export type NormalizedEvent =
	| { type: "thread.started"; at?: string; threadId: string; method?: string; raw: unknown }
	| { type: "turn.started"; at?: string; threadId?: string; turnId?: string; method?: string; raw: unknown }
	| { type: "turn.completed"; at?: string; threadId?: string; turnId?: string; status?: string; durationMs?: number; method?: string; raw: unknown }
	| { type: "token.usage"; at?: string; threadId?: string; turnId?: string; usage: TokenUsageBreakdown; method?: string; raw: unknown }
	| { type: "command"; at?: string; command: string; status?: string; exitCode?: number | null; durationMs?: number | null; raw: unknown }
	| { type: "file.change"; at?: string; status?: string; paths: string[]; raw: unknown }
	| { type: "tool.call"; at?: string; namespace?: string | null; tool: string; status?: string; raw: unknown }
	| { type: "agent.final"; at?: string; text: string; raw: unknown }
	| { type: "user.intervention"; at?: string; label: string; raw: unknown }
	| { type: "stderr"; at?: string; text: string; raw: unknown }
	| { type: "error"; at?: string; message: string; raw: unknown }
	| { type: "raw"; at?: string; method?: string; raw: unknown };

export type OracleCheck = {
	type: OracleConfig["type"];
	passed: boolean;
	message: string;
};

export type OracleResult = {
	status: "passed" | "failed";
	checks: OracleCheck[];
};

export type RunResult = {
	id: string;
	scenarioId: string;
	profileId: string;
	status: "passed" | "failed" | "error";
	createdAt: string;
	completedAt: string;
	elapsedMs: number;
	tokenUsage: TokenUsageSummary;
	metrics: {
		commandCount: number;
		failedCommandCount: number;
		fileChangeCount: number;
		toolCallCount: number;
		userInterventionCount: number;
	};
	finalText: string;
	oracle: OracleResult;
	artifacts: {
		manifest: string;
		rawEvents?: string;
		normalizedEvents?: string;
		packet?: string;
	};
	error?: string;
};
