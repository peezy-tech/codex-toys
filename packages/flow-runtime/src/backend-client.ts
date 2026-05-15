import { createHmac } from "node:crypto";
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
	FlowReplayOptions,
	FlowReplayResult,
	FlowRunList,
	FlowRunView,
} from "./client-types.ts";
import type { FlowEvent, FlowResultStatus } from "./types.ts";

export type FlowBackendProcessStatus = FlowProcessStatus;
export type FlowBackendEffectiveStatus = FlowEffectiveStatus;
export type FlowBackendListRunsOptions = FlowListRunsOptions;
export type FlowBackendListEventsOptions = FlowListEventsOptions;
export type FlowBackendDispatchOptions = FlowDispatchOptions;
export type FlowBackendReplayOptions = FlowReplayOptions;

export type FlowBackendHttpHeaders =
	| Headers
	| Record<string, string>
	| Array<[string, string]>;

export type FlowBackendFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type FlowBackendOutputView = FlowOutputView;
export type FlowBackendAttemptView = FlowAttemptView;
export type FlowBackendRunView = FlowRunView;
export type FlowBackendEventView = FlowEventView;
export type FlowBackendRunList = FlowRunList;
export type FlowBackendEventList = FlowEventList;
export type FlowBackendDispatchResult = FlowDispatchResult;
export type FlowBackendReplayResult = FlowReplayResult;
export type FlowBackendCancelResult = FlowCancelResult;
export type FlowBackendClient = FlowClient;

export type FlowBackendHttpClientOptions = {
	baseUrl: string;
	fetch?: FlowBackendFetch;
	headers?:
		| FlowBackendHttpHeaders
		| (() => FlowBackendHttpHeaders | Promise<FlowBackendHttpHeaders>);
	bearerToken?: string;
	apiKey?: string;
	hmacSecret?: string;
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

export class FlowBackendHttpClient implements FlowBackendClient {
	#baseUrl: string;
	#fetch: FlowBackendFetch;
	#headers: FlowBackendHttpClientOptions["headers"];
	#bearerToken: string | undefined;
	#apiKey: string | undefined;
	#hmacSecret: string | undefined;

	constructor(options: FlowBackendHttpClientOptions) {
		this.#baseUrl = options.baseUrl;
		this.#fetch = options.fetch ?? fetch;
		this.#headers = options.headers;
		this.#bearerToken = options.bearerToken;
		this.#apiKey = options.apiKey;
		this.#hmacSecret = options.hmacSecret;
	}

	async listRuns(
		options: FlowBackendListRunsOptions = {},
	): Promise<FlowBackendRunList> {
		const raw = await this.#request("GET", "/runs", undefined, options);
		return normalizeRunList(raw);
	}

	async getRun(runId: string): Promise<FlowBackendRunView> {
		const raw = await this.#request("GET", `/runs/${encodeURIComponent(runId)}`);
		return normalizeRun(record(raw).run ?? raw);
	}

	async listEvents(
		options: FlowBackendListEventsOptions = {},
	): Promise<FlowBackendEventList> {
		const raw = await this.#request("GET", "/events", undefined, options);
		return normalizeEventList(raw);
	}

	async getEvent(eventId: string): Promise<FlowBackendEventView> {
		const raw = await this.#request("GET", `/events/${encodeURIComponent(eventId)}`);
		return normalizeEvent(record(raw).event ?? raw, record(raw).runs);
	}

	async dispatchEvent(
		event: FlowEvent,
		options: FlowBackendDispatchOptions = {},
	): Promise<FlowBackendDispatchResult> {
		const raw = await this.#request("POST", "/events", event, options);
		return normalizeDispatchResult(raw);
	}

	async replayEvent(
		eventId: string,
		options: FlowBackendReplayOptions = {},
	): Promise<FlowBackendReplayResult> {
		const raw = await this.#request(
			"POST",
			`/events/${encodeURIComponent(eventId)}/replay`,
			options,
		);
		return normalizeDispatchResult(raw);
	}

	async cancelRun(runId: string): Promise<FlowBackendCancelResult> {
		const raw = await this.#request(
			"POST",
			`/runs/${encodeURIComponent(runId)}/cancel`,
			{},
		);
		return {
			run: normalizeRun(record(raw).run ?? raw),
			raw,
		};
	}

	async #request(
		method: string,
		pathname: string,
		body?: unknown,
		query: Record<string, unknown> = {},
	): Promise<unknown> {
		const url = new URL(
			pathname.replace(/^\/+/, ""),
			this.#baseUrl.endsWith("/") ? this.#baseUrl : `${this.#baseUrl}/`,
		);
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined && value !== null) {
				url.searchParams.set(key, String(value));
			}
		}
		const bodyText = body === undefined ? undefined : JSON.stringify(body);
		const headers = await this.#requestHeaders(bodyText);
		const response = await this.#fetch(url, {
			method,
			headers,
			...(bodyText === undefined ? {} : { body: bodyText }),
		});
		if (!response.ok) {
			throw new Error(`Flow backend ${method} ${url.pathname} failed with ${response.status}`);
		}
		return response.json();
	}

	async #requestHeaders(bodyText: string | undefined): Promise<Headers> {
		const headers = new Headers(
			typeof this.#headers === "function"
				? await this.#headers()
				: this.#headers,
		);
		if (this.#bearerToken) {
			headers.set("authorization", `Bearer ${this.#bearerToken}`);
		}
		if (this.#apiKey) {
			headers.set("x-api-key", this.#apiKey);
		}
		if (bodyText !== undefined) {
			headers.set("content-type", "application/json");
		}
		if (this.#hmacSecret && bodyText !== undefined) {
			headers.set("x-flow-signature-256", hmacSignature(this.#hmacSecret, bodyText));
		}
		return headers;
	}
}

export function createFlowBackendHttpClient(
	options: FlowBackendHttpClientOptions,
): FlowBackendHttpClient {
	return new FlowBackendHttpClient(options);
}

export function normalizeRunList(raw: unknown): FlowBackendRunList {
	const value = record(raw);
	return {
		runs: arrayValue(value.runs).map(normalizeRun),
		...(typeof value.eventId === "string" ? { eventId: value.eventId } : {}),
		raw,
	};
}

export function normalizeEventList(raw: unknown): FlowBackendEventList {
	const value = record(raw);
	return {
		events: arrayValue(value.events).map((event) => normalizeEvent(event)),
		raw,
	};
}

export function normalizeDispatchResult(raw: unknown): FlowBackendDispatchResult {
	const value = record(raw);
	const runIds = arrayValue(value.runIds).map(String);
	const runs = arrayValue(value.runs).map(normalizeRun);
	const event = value.event ? normalizeEvent(value.event) : undefined;
	return {
		...(typeof value.status === "string" ? { status: value.status } : {}),
		...(typeof value.eventId === "string" ? { eventId: value.eventId } : {}),
		runIds: runIds.length > 0 ? runIds : runs.map((run) => run.id),
		...(typeof value.matched === "number" ? { matched: value.matched } : {}),
		...(typeof value.idempotent === "boolean" ? { idempotent: value.idempotent } : {}),
		...(event ? { event } : {}),
		runs,
		raw,
	};
}

export function normalizeEvent(raw: unknown, runsInput?: unknown): FlowBackendEventView {
	const value = record(raw);
	const rawRuns = Array.isArray(runsInput)
		? runsInput
		: Array.isArray(value.runs)
			? value.runs
			: [];
	const runs = rawRuns.map(normalizeRun);
	const id = stringValue(value.id) ?? stringValue(value.eventId) ?? "";
	return {
		id,
		...(stringValue(value.type) ? { type: stringValue(value.type) } : {}),
		...(stringValue(value.source) ? { source: stringValue(value.source) } : {}),
		...(stringValue(value.occurredAt) ? { occurredAt: stringValue(value.occurredAt) } : {}),
		...(stringValue(value.receivedAt) ? { receivedAt: stringValue(value.receivedAt) } : {}),
		...("payload" in value ? { payload: value.payload } : {}),
		runIds: arrayValue(value.runIds).map(String).concat(runs.map((run) => run.id)).filter(unique),
		runs,
		...(stringValue(value.createdAt) ? { createdAt: stringValue(value.createdAt) } : {}),
		raw,
	};
}

export function normalizeRun(raw: unknown): FlowBackendRunView {
	const value = record(raw);
	const id = stringValue(value.id) ?? stringValue(value.runId) ?? "";
	const processStatus = stringValue(value.status);
	const resultPayload = parseResultPayload(value);
	const resultStatus = resultStatusFrom(resultPayload) ??
		resultStatusFromStatus(processStatus);
	const effectiveStatus = resultStatus ?? processStatus ?? "unknown";
	const attempts = arrayValue(value.attempts).map(normalizeAttempt);
	const output = normalizeOutput(value);
	const attemptCount = numberValue(value.attemptCount) ??
		numberValue(value.attempts) ??
		attempts.length;
	return {
		id,
		...(stringValue(value.eventId) ? { eventId: stringValue(value.eventId) } : {}),
		...(stringValue(value.flowName) ? { flowName: stringValue(value.flowName) } : {}),
		...(numberValue(value.flowVersion) !== undefined ? { flowVersion: numberValue(value.flowVersion) } : {}),
		...(stringValue(value.stepName) ? { stepName: stringValue(value.stepName) } : {}),
		...(stringValue(value.runner) ? { runner: stringValue(value.runner) } : {}),
		...(stringValue(value.backend) ? { backend: stringValue(value.backend) } : {}),
		...(processStatus ? { processStatus } : {}),
		...(resultStatus ? { resultStatus } : {}),
		status: effectiveStatus,
		effectiveStatus,
		needsAttention: attentionStatuses.has(effectiveStatus),
		attemptCount,
		attempts,
		output,
		...(output.at(-1) ? { latestOutput: output.at(-1) } : {}),
		...(resultPayload !== undefined ? { resultPayload } : {}),
		...(stringValue(value.error) ? { error: stringValue(value.error) } : {}),
		...(stringValue(value.createdAt) ? { createdAt: stringValue(value.createdAt) } : {}),
		...(stringValue(value.startedAt) ? { startedAt: stringValue(value.startedAt) } : {}),
		...(stringValue(value.completedAt) ? { completedAt: stringValue(value.completedAt) } : {}),
		...(stringValue(value.finishedAt) ? { completedAt: stringValue(value.finishedAt) } : {}),
		...(stringValue(value.updatedAt) ? { updatedAt: stringValue(value.updatedAt) } : {}),
		raw,
	};
}

function normalizeAttempt(raw: unknown): FlowBackendAttemptView {
	const value = record(raw);
	return {
		id: stringValue(value.id) ?? stringValue(value.attemptId) ?? "",
		...(stringValue(value.status) ? { status: stringValue(value.status) } : {}),
		...(numberValue(value.attemptNumber) !== undefined ? { attemptNumber: numberValue(value.attemptNumber) } : {}),
		...(stringValue(value.workerId) ? { workerId: stringValue(value.workerId) } : {}),
		...(numberValue(value.leaseExpiresAt) !== undefined ? { leaseExpiresAt: numberValue(value.leaseExpiresAt) } : {}),
		...(stringValue(value.startedAt) ? { startedAt: stringValue(value.startedAt) } : {}),
		...(stringValue(value.completedAt) ? { completedAt: stringValue(value.completedAt) } : {}),
		...(stringValue(value.error) ? { error: stringValue(value.error) } : {}),
		raw,
	};
}

function normalizeOutput(value: Record<string, unknown>): FlowBackendOutputView[] {
	if (Array.isArray(value.output)) {
		return value.output.map((entry) => {
			const output = record(entry);
			return {
				kind: stringValue(output.kind) ?? "output",
				text: stringValue(output.text) ?? "",
				...(stringValue(output.createdAt) ? { createdAt: stringValue(output.createdAt) } : {}),
				raw: entry,
			};
		});
	}
	const output: FlowBackendOutputView[] = [];
	for (const key of ["stdout", "stderr"] as const) {
		const text = stringValue(value[key]);
		if (text) {
			output.push({
				kind: key,
				text,
				raw: { kind: key, text },
			});
		}
	}
	return output;
}

function parseResultPayload(value: Record<string, unknown>): unknown {
	if ("result" in value) {
		return value.result;
	}
	if ("resultJson" in value) {
		const resultJson = value.resultJson;
		if (isRecord(resultJson)) {
			return resultJson;
		}
		if (typeof resultJson === "string" && resultJson.trim()) {
			try {
				return JSON.parse(resultJson);
			} catch {
				return resultJson;
			}
		}
	}
	return undefined;
}

function resultStatusFrom(value: unknown): FlowResultStatus | undefined {
	const status = isRecord(value) ? value.status : undefined;
	return resultStatusFromStatus(status);
}

function resultStatusFromStatus(value: unknown): FlowResultStatus | undefined {
	return typeof value === "string" && resultStatuses.has(value as FlowResultStatus)
		? value as FlowResultStatus
		: undefined;
}

function hmacSignature(secret: string, body: string): string {
	return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function unique<T>(value: T, index: number, values: T[]): boolean {
	return values.indexOf(value) === index;
}
