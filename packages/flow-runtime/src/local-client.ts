import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { discoverFlows } from "./manifest.ts";
import { runFlowStep } from "./run.ts";
import { matchingSteps } from "./triggers.ts";
import type {
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
	FlowProgressEvent,
	FlowProgressSink,
	FlowReplayOptions,
	FlowReplayResult,
	FlowRunList,
	FlowRunView,
} from "./client-types.ts";
import type {
	FlowEvent,
	FlowResult,
	FlowResultStatus,
	FlowStep,
	LoadedFlow,
} from "./types.ts";

export type LocalFlowClientOptions = {
	cwd: string;
	roots?: string[];
	env?: Record<string, string | undefined>;
	state?: false | "memory" | {
		kind: "file";
		dataDir?: string;
	};
	progress?: FlowProgressSink;
};

type StoredEvent = {
	event: FlowEvent;
	createdAt: string;
	runIds: string[];
};

type LocalFlowStateSnapshot = {
	events: StoredEvent[];
	runs: FlowRunView[];
};

const resultStatuses = new Set<FlowResultStatus>([
	"skipped",
	"completed",
	"changed",
	"needs_intervention",
	"blocked",
	"failed",
]);

const attentionStatuses = new Set(["blocked", "needs_intervention"]);

export class LocalFlowClientUnsupportedStateError extends Error {
	constructor(operation: string) {
		super(`Local flow client ${operation} requires local state`);
		this.name = "LocalFlowClientUnsupportedStateError";
	}
}

export class LocalFlowClient implements FlowClient {
	#cwd: string;
	#roots: string[] | undefined;
	#env: Record<string, string | undefined>;
	#progress: FlowProgressSink | undefined;
	#state: LocalFlowMemoryState | undefined;

	constructor(options: LocalFlowClientOptions) {
		this.#cwd = path.resolve(options.cwd);
		this.#roots = options.roots?.map((root) =>
			path.isAbsolute(root) ? root : path.resolve(this.#cwd, root),
		);
		this.#env = options.env ?? process.env;
		this.#progress = options.progress;
		this.#state = localState(options.state, this.#cwd);
	}

	async listRuns(options: FlowListRunsOptions = {}): Promise<FlowRunList> {
		return this.#requireState("listRuns").listRuns(options);
	}

	async getRun(runId: string): Promise<FlowRunView> {
		return this.#requireState("getRun").getRun(runId);
	}

	async listEvents(options: FlowListEventsOptions = {}): Promise<FlowEventList> {
		return this.#requireState("listEvents").listEvents(options);
	}

	async getEvent(eventId: string): Promise<FlowEventView> {
		return this.#requireState("getEvent").getEvent(eventId);
	}

	async dispatchEvent(
		input: FlowEvent,
		options: FlowDispatchOptions = {},
	): Promise<FlowDispatchResult> {
		ensureSynchronousLocalDispatch(options);
		const event = normalizeFlowEvent(input);
		const duplicate = this.#state?.duplicateDispatch(event.id);
		if (duplicate) {
			return duplicate;
		}

		const createdAt = new Date().toISOString();
		const flows = await discoverFlows({
			cwd: this.#cwd,
			...(this.#roots ? { roots: this.#roots } : {}),
		});
		const matches = await matchingSteps(flows, event);
		const runs: FlowRunView[] = [];
		for (const match of matches) {
			const run = await this.#executeMatch({
				event,
				flow: match.flow,
				step: match.step,
			});
			runs.push(run);
		}

		const result = dispatchResult({
			status: "accepted",
			event,
			runs,
			matched: matches.length,
			raw: {
				status: "accepted",
				eventId: event.id,
				runIds: runs.map((run) => run.id),
				matched: matches.length,
			},
		});
		this.#state?.recordDispatch(event, createdAt, runs);
		return result;
	}

	async replayEvent(
		eventId: string,
		options: FlowReplayOptions = {},
	): Promise<FlowReplayResult> {
		ensureSynchronousLocalDispatch(options);
		const state = this.#requireState("replayEvent");
		const event = state.rawEvent(eventId);
		const replayNonce = `${Date.now()}:${Math.random()}`;
		const flows = await discoverFlows({
			cwd: this.#cwd,
			...(this.#roots ? { roots: this.#roots } : {}),
		});
		const matches = await matchingSteps(flows, event);
		const runs: FlowRunView[] = [];
		for (const match of matches) {
			const run = await this.#executeMatch({
				event,
				flow: match.flow,
				step: match.step,
				replayNonce,
			});
			runs.push(run);
		}
		state.recordReplay(event.id, runs);
		return dispatchResult({
			status: "accepted",
			event,
			runs,
			matched: matches.length,
			raw: {
				status: "accepted",
				eventId: event.id,
				runIds: runs.map((run) => run.id),
				matched: matches.length,
				replay: true,
			},
		});
	}

	async cancelRun(_runId: string): Promise<FlowCancelResult> {
		throw new LocalFlowClientUnsupportedStateError("cancelRun");
	}

	async #executeMatch(options: {
		event: FlowEvent;
		flow: LoadedFlow;
		step: FlowStep;
		replayNonce?: string;
	}): Promise<FlowRunView> {
		const runId = localRunId(
			options.event.id,
			options.flow.manifest.name,
			options.step.name,
			options.replayNonce,
		);
		const startedAt = new Date().toISOString();
		const progressBase = {
			eventId: options.event.id,
			runId,
			flowName: options.flow.manifest.name,
			stepName: options.step.name,
			runner: options.step.runner,
		};
		this.#emitProgress({
			kind: "run_start",
			...progressBase,
		});
		try {
			const result = await runFlowStep({
				flow: options.flow,
				step: options.step,
				event: options.event,
				env: this.#env,
				runtime: {
					runId,
					eventId: options.event.id,
					attemptId: runId,
					replay: options.replayNonce !== undefined,
					workspaceBackendUrl: this.#env.CODEX_WORKSPACE_BACKEND_WS_URL,
					launchedBy: "flow-runtime-local-client",
				},
				progress: (event) => this.#emitProgress({
					...progressBase,
					...event,
				}),
			});
			const completedAt = new Date().toISOString();
			this.#emitProgress({
				kind: "run_complete",
				...progressBase,
				status: result.status,
			});
			return localRunView({
				runId,
				event: options.event,
				flow: options.flow,
				step: options.step,
				processStatus: "completed",
				result,
				startedAt,
				completedAt,
			});
		} catch (error) {
			const completedAt = new Date().toISOString();
			this.#emitProgress({
				kind: "run_complete",
				...progressBase,
				status: "failed",
				text: error instanceof Error ? error.message : String(error),
			});
			return localRunView({
				runId,
				event: options.event,
				flow: options.flow,
				step: options.step,
				processStatus: "failed",
				error: error instanceof Error ? error.message : String(error),
				startedAt,
				completedAt,
			});
		}
	}

	#emitProgress(event: Omit<FlowProgressEvent, "createdAt"> & { createdAt?: string }): void {
		this.#progress?.({
			...event,
			createdAt: event.createdAt ?? new Date().toISOString(),
		});
	}

	#requireState(operation: string): LocalFlowMemoryState {
		if (!this.#state) {
			throw new LocalFlowClientUnsupportedStateError(operation);
		}
		return this.#state;
	}
}

export function createLocalFlowClient(options: LocalFlowClientOptions): LocalFlowClient {
	return new LocalFlowClient(options);
}

class LocalFlowMemoryState {
	#events = new Map<string, StoredEvent>();
	#runs = new Map<string, FlowRunView>();

	constructor(snapshot?: LocalFlowStateSnapshot) {
		for (const event of snapshot?.events ?? []) {
			this.#events.set(event.event.id, event);
		}
		for (const run of snapshot?.runs ?? []) {
			this.#runs.set(run.id, run);
		}
	}

	duplicateDispatch(eventId: string): FlowDispatchResult | undefined {
		const stored = this.#events.get(eventId);
		if (!stored) {
			return undefined;
		}
		const runs = stored.runIds.map((runId) => this.#runs.get(runId)).filter(isDefined);
		return {
			status: "duplicate",
			eventId,
			runIds: stored.runIds,
			matched: 0,
			idempotent: true,
			event: this.eventView(eventId),
			runs,
			raw: {
				status: "duplicate",
				eventId,
				runIds: stored.runIds,
				matched: 0,
				idempotent: true,
			},
		};
	}

	recordDispatch(event: FlowEvent, createdAt: string, runs: FlowRunView[]): void {
		for (const run of runs) {
			this.#runs.set(run.id, run);
		}
		this.#events.set(event.id, {
			event,
			createdAt,
			runIds: runs.map((run) => run.id),
		});
	}

	recordReplay(eventId: string, runs: FlowRunView[]): void {
		const stored = this.#events.get(eventId);
		if (!stored) {
			throw new Error(`Unknown event: ${eventId}`);
		}
		for (const run of runs) {
			this.#runs.set(run.id, run);
			stored.runIds.push(run.id);
		}
	}

	listRuns(options: FlowListRunsOptions): FlowRunList {
		let runs = Array.from(this.#runs.values());
		if (options.eventId) {
			runs = runs.filter((run) => run.eventId === options.eventId);
		}
		if (options.status) {
			runs = runs.filter((run) =>
				run.processStatus === options.status || run.effectiveStatus === options.status,
			);
		}
		runs = runs.slice(-clampLimit(options.limit)).reverse();
		return {
			runs,
			...(options.eventId ? { eventId: options.eventId } : {}),
			raw: { runs },
		};
	}

	getRun(runId: string): FlowRunView {
		const run = this.#runs.get(runId);
		if (!run) {
			throw new Error(`Unknown run: ${runId}`);
		}
		return run;
	}

	listEvents(options: FlowListEventsOptions): FlowEventList {
		let events = Array.from(this.#events.values());
		if (options.type) {
			events = events.filter((event) => event.event.type === options.type);
		}
		events = events.slice(-clampLimit(options.limit)).reverse();
		const views = events.map((event) => this.eventView(event.event.id));
		return {
			events: views,
			raw: { events: views },
		};
	}

	getEvent(eventId: string): FlowEventView {
		return this.eventView(eventId);
	}

	rawEvent(eventId: string): FlowEvent {
		const stored = this.#events.get(eventId);
		if (!stored) {
			throw new Error(`Unknown event: ${eventId}`);
		}
		return stored.event;
	}

	eventView(eventId: string): FlowEventView {
		const stored = this.#events.get(eventId);
		if (!stored) {
			throw new Error(`Unknown event: ${eventId}`);
		}
		const runs = stored.runIds.map((runId) => this.#runs.get(runId)).filter(isDefined);
		return {
			id: stored.event.id,
			type: stored.event.type,
			...(stored.event.source ? { source: stored.event.source } : {}),
			...(stored.event.occurredAt ? { occurredAt: stored.event.occurredAt } : {}),
			receivedAt: stored.event.receivedAt,
			payload: stored.event.payload,
			runIds: stored.runIds,
			runs,
			createdAt: stored.createdAt,
			raw: {
				kind: "local-event",
				event: stored.event,
				createdAt: stored.createdAt,
				runIds: stored.runIds,
			},
		};
	}

	snapshot(): LocalFlowStateSnapshot {
		return {
			events: Array.from(this.#events.values()),
			runs: Array.from(this.#runs.values()),
		};
	}
}

class LocalFlowFileState extends LocalFlowMemoryState {
	#statePath: string;

	constructor(dataDir: string) {
		const statePath = path.join(dataDir, "state.json");
		super(readStateSnapshot(statePath));
		this.#statePath = statePath;
		mkdirSync(path.dirname(this.#statePath), { recursive: true });
	}

	override recordDispatch(event: FlowEvent, createdAt: string, runs: FlowRunView[]): void {
		super.recordDispatch(event, createdAt, runs);
		this.#save();
	}

	override recordReplay(eventId: string, runs: FlowRunView[]): void {
		super.recordReplay(eventId, runs);
		this.#save();
	}

	#save(): void {
		writeFileSync(this.#statePath, JSON.stringify(this.snapshot(), null, 2));
	}
}

function dispatchResult(options: {
	status: string;
	event: FlowEvent;
	runs: FlowRunView[];
	matched: number;
	raw: unknown;
}): FlowDispatchResult {
	const runIds = options.runs.map((run) => run.id);
	return {
		status: options.status,
		eventId: options.event.id,
		runIds,
		matched: options.matched,
		event: {
			id: options.event.id,
			type: options.event.type,
			...(options.event.source ? { source: options.event.source } : {}),
			...(options.event.occurredAt ? { occurredAt: options.event.occurredAt } : {}),
			receivedAt: options.event.receivedAt,
			payload: options.event.payload,
			runIds,
			runs: options.runs,
			raw: { kind: "local-event", event: options.event, runIds },
		},
		runs: options.runs,
		raw: options.raw,
	};
}

function localRunView(options: {
	runId: string;
	event: FlowEvent;
	flow: LoadedFlow;
	step: FlowStep;
	processStatus: FlowProcessStatus;
	result?: FlowResult;
	error?: string;
	startedAt: string;
	completedAt: string;
}): FlowRunView {
	const resultStatus = resultStatusFrom(options.result);
	const effectiveStatus: FlowEffectiveStatus =
		resultStatus ?? options.processStatus;
	const attempt = localAttemptView({
		runId: options.runId,
		status: options.processStatus,
		startedAt: options.startedAt,
		completedAt: options.completedAt,
		error: options.error,
	});
	const output: FlowOutputView[] = [];
	return {
		id: options.runId,
		eventId: options.event.id,
		flowName: options.flow.manifest.name,
		flowVersion: options.flow.manifest.version,
		stepName: options.step.name,
		runner: options.step.runner,
		backend: "local",
		processStatus: options.processStatus,
		...(resultStatus ? { resultStatus } : {}),
		status: effectiveStatus,
		effectiveStatus,
		needsAttention: attentionStatuses.has(effectiveStatus),
		attemptCount: 1,
		attempts: [attempt],
		output,
		...(options.result ? { resultPayload: options.result } : {}),
		...(options.error ? { error: options.error } : {}),
		createdAt: options.startedAt,
		startedAt: options.startedAt,
		completedAt: options.completedAt,
		updatedAt: options.completedAt,
		raw: {
			kind: "local-run",
			event: options.event,
			flowRoot: options.flow.root,
			flowName: options.flow.manifest.name,
			stepName: options.step.name,
			result: options.result,
			error: options.error,
		},
	};
}

function localAttemptView(options: {
	runId: string;
	status: FlowProcessStatus;
	startedAt: string;
	completedAt: string;
	error?: string;
}): FlowAttemptView {
	return {
		id: `${options.runId}:attempt:1`,
		status: options.status,
		attemptNumber: 1,
		startedAt: options.startedAt,
		completedAt: options.completedAt,
		...(options.error ? { error: options.error } : {}),
		raw: {
			kind: "local-attempt",
			runId: options.runId,
		},
	};
}

function normalizeFlowEvent(value: unknown): FlowEvent {
	const record = isRecord(value) ? value : {};
	if (typeof record.id !== "string" || typeof record.type !== "string") {
		throw new Error("FlowEvent requires string id and type");
	}
	return {
		...record,
		id: record.id,
		type: record.type,
		receivedAt: typeof record.receivedAt === "string" && record.receivedAt
			? record.receivedAt
			: new Date().toISOString(),
		payload: "payload" in record ? record.payload : {},
	} as FlowEvent;
}

function localState(
	state: LocalFlowClientOptions["state"],
	cwd: string,
): LocalFlowMemoryState | undefined {
	if (state === false) {
		return undefined;
	}
	if (typeof state === "object") {
		return new LocalFlowFileState(state.dataDir ?? path.join(cwd, ".codex", "flow-client"));
	}
	return new LocalFlowMemoryState();
}

function readStateSnapshot(statePath: string): LocalFlowStateSnapshot | undefined {
	try {
		const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
		if (!isRecord(parsed) || !Array.isArray(parsed.events) || !Array.isArray(parsed.runs)) {
			return undefined;
		}
		return {
			events: parsed.events.filter(isStoredEvent),
			runs: parsed.runs.filter(isFlowRunView),
		};
	} catch (error) {
		if (isErrno(error, "ENOENT")) {
			return undefined;
		}
		throw error;
	}
}

function resultStatusFrom(result: FlowResult | undefined): FlowResultStatus | undefined {
	return result && resultStatuses.has(result.status) ? result.status : undefined;
}

function localRunId(
	eventId: string,
	flowName: string,
	stepName: string,
	replayNonce?: string,
): string {
	const hash = createHash("sha256")
		.update(`${eventId}\0${flowName}\0${stepName}${replayNonce ? `\0${replayNonce}` : ""}`)
		.digest("hex")
		.slice(0, 12);
	return replayNonce ? `run_${hash}_replay` : `run_${hash}`;
}

function ensureSynchronousLocalDispatch(
	options: FlowDispatchOptions | FlowReplayOptions,
): void {
	if (options.wait === false) {
		throw new Error("Local flow dispatch does not support wait: false without a worker loop");
	}
}

function clampLimit(value: number | undefined): number {
	if (!value || !Number.isFinite(value)) {
		return 50;
	}
	return Math.max(1, Math.min(500, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredEvent(value: unknown): value is StoredEvent {
	if (!isRecord(value) || !isRecord(value.event)) {
		return false;
	}
	return typeof value.event.id === "string" &&
		typeof value.event.type === "string" &&
		typeof value.event.receivedAt === "string" &&
		Array.isArray(value.runIds) &&
		value.runIds.every((runId) => typeof runId === "string") &&
		typeof value.createdAt === "string";
}

function isFlowRunView(value: unknown): value is FlowRunView {
	return isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.status === "string" &&
		typeof value.effectiveStatus === "string" &&
		typeof value.needsAttention === "boolean" &&
		typeof value.attemptCount === "number" &&
		Array.isArray(value.attempts) &&
		Array.isArray(value.output) &&
		"raw" in value;
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}
