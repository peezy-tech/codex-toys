import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	CodexAppServerClient,
	type CodexAppServerClientOptions,
} from "./client.ts";
import type { v2 } from "./generated/index.ts";
import type { JsonRpcNotification } from "./rpc.ts";
import { CodexWorkspaceBackendClient } from "../workspace-backend/client.ts";

type JsonValue = NonNullable<v2.TurnStartParams["outputSchema"]>;
type ThreadConfig = NonNullable<v2.ThreadStartParams["config"]>;
type ThreadResumeConfig = NonNullable<v2.ThreadResumeParams["config"]>;

export type CodexFlowAppServerClient = {
	connect(): Promise<void>;
	close(): void;
	startThread(params: v2.ThreadStartParams): Promise<v2.ThreadStartResponse>;
	resumeThread(params: v2.ThreadResumeParams): Promise<v2.ThreadResumeResponse>;
	readThread(params: v2.ThreadReadParams): Promise<v2.ThreadReadResponse>;
	startTurn(params: v2.TurnStartParams): Promise<v2.TurnStartResponse>;
	on?(event: string, listener: (...args: any[]) => void): unknown;
	off?(event: string, listener: (...args: any[]) => void): unknown;
};

export type CodexFlowClientOptions = {
	client?: CodexFlowAppServerClient;
	appServerUrl?: string;
	requestTimeoutMs?: number;
	clientName?: string;
	clientTitle?: string;
	clientVersion?: string;
	closeInjectedClient?: boolean;
};

export type CodexFlowInputItem =
	| v2.UserInput
	| {
			type: "text";
			text: string;
			text_elements?: v2.TextElement[];
	  };

export type CodexFlowInput =
	| string
	| CodexFlowInputItem
	| CodexFlowInputItem[];

export type CodexFlowThreadOptions = Partial<
	Omit<v2.ThreadStartParams, "experimentalRawEvents" | "persistExtendedHistory">
> & {
	experimentalRawEvents?: boolean;
	persistExtendedHistory?: boolean;
};

export type CodexFlowResumeOptions = Partial<
	Omit<v2.ThreadResumeParams, "threadId" | "persistExtendedHistory">
> & {
	persistExtendedHistory?: boolean;
};

export type CodexFlowTurnOptions = Partial<
	Omit<v2.TurnStartParams, "threadId" | "input">
>;

export type CodexFlowWaitOptions = {
	timeoutMs?: number;
	pollIntervalMs?: number;
	signal?: AbortSignal;
	throwOnFailure?: boolean;
};

export type StartCodexFlowParams = {
	threadId?: string;
	prompt?: string;
	input?: CodexFlowInput;
	cwd?: string | null;
	model?: string | null;
	modelProvider?: string | null;
	serviceTier?: string | null;
	approvalPolicy?: v2.AskForApproval | null;
	approvalsReviewer?: v2.ApprovalsReviewer | null;
	sandbox?: v2.SandboxMode | null;
	permissions?: v2.PermissionProfileSelectionParams | null;
	config?: ThreadConfig | ThreadResumeConfig | null;
	baseInstructions?: string | null;
	developerInstructions?: string | null;
	personality?: v2.ThreadStartParams["personality"];
	outputSchema?: JsonValue | null;
	thread?: CodexFlowThreadOptions;
	resume?: CodexFlowResumeOptions | false;
	turn?: CodexFlowTurnOptions;
	wait?: boolean | CodexFlowWaitOptions;
};

export type CodexFlowStartResult = {
	thread: v2.Thread;
	turn: v2.Turn;
	threadId: string;
	turnId: string;
	completedTurn?: v2.Turn;
};

export type CodexFlowRunContextLike = {
	flow: {
		name: string;
		root: string;
		step: string;
		event?: unknown;
	};
	runtime?: {
		workspaceBackendUrl?: string;
	};
};

export type RunCodexAgentTurnFromFlowOptions =
	StartCodexFlowParams & {
		flowClient?: CodexFlowClient;
		client?: CodexFlowAppServerClient;
		appServerUrl?: string;
		requestTimeoutMs?: number;
		exportThreadJson?: string | false;
	};

export type RunCodexAgentTurnFromFlowResult = CodexFlowStartResult & {
	threadJsonPath?: string;
	exportedThread?: v2.Thread;
	artifacts: {
		threadId: string;
		turnId: string;
		turnStatus?: v2.TurnStatus;
		threadJsonPath?: string;
	};
};

export type WaitForTurnParams = {
	threadId: string;
	turnId: string;
	timeoutMs?: number;
	pollIntervalMs?: number;
	signal?: AbortSignal;
	throwOnFailure?: boolean;
};

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export class CodexFlowTimeoutError extends Error {
	readonly threadId: string;
	readonly turnId: string;
	readonly timeoutMs: number;

	constructor(params: { threadId: string; turnId: string; timeoutMs: number }) {
		super(
			`Timed out waiting for Codex turn ${params.turnId} on thread ${params.threadId}`,
		);
		this.name = "CodexFlowTimeoutError";
		this.threadId = params.threadId;
		this.turnId = params.turnId;
		this.timeoutMs = params.timeoutMs;
	}
}

export class CodexFlowTurnFailedError extends Error {
	readonly threadId: string;
	readonly turn: v2.Turn;

	constructor(threadId: string, turn: v2.Turn) {
		super(turn.error?.message ?? `Codex turn ${turn.id} failed`);
		this.name = "CodexFlowTurnFailedError";
		this.threadId = threadId;
		this.turn = turn;
	}
}

export class CodexFlowClient {
	readonly client: CodexFlowAppServerClient;
	#connected = false;
	#closeClient: boolean;

	constructor(options: CodexFlowClientOptions = {}) {
		this.client =
			options.client ??
			new CodexAppServerClient({
				...clientIdentityOptions(options),
				webSocketTransportOptions: options.appServerUrl
					? {
							url: options.appServerUrl,
							requestTimeoutMs: options.requestTimeoutMs,
						}
					: undefined,
				transportOptions: options.requestTimeoutMs
					? { requestTimeoutMs: options.requestTimeoutMs }
					: undefined,
			});
		this.#closeClient = options.client
			? options.closeInjectedClient === true
			: true;
	}

	async connect(): Promise<void> {
		if (this.#connected) {
			return;
		}
		await this.client.connect();
		this.#connected = true;
	}

	close(): void {
		this.#connected = false;
		if (this.#closeClient) {
			this.client.close();
		}
	}

	async startFlow(params: StartCodexFlowParams): Promise<CodexFlowStartResult> {
		await this.connect();

		const input = [
			...toCodexUserInput(params.prompt),
			...toCodexUserInput(params.input),
		];
		if (input.length === 0) {
			throw new Error("Codex flow input is required");
		}

		const thread = await this.#openThread(params);
		const turnResponse = await this.client.startTurn(
			turnStartParams(thread.id, input, params),
		);

		const result: CodexFlowStartResult = {
			thread,
			turn: turnResponse.turn,
			threadId: thread.id,
			turnId: turnResponse.turn.id,
		};

		const waitOptions = normalizeWait(params.wait);
		if (waitOptions) {
			result.completedTurn = await this.waitForTurn({
				threadId: thread.id,
				turnId: turnResponse.turn.id,
				...waitOptions,
			});
		}

		return result;
	}

	async waitForTurn(params: WaitForTurnParams): Promise<v2.Turn> {
		await this.connect();

		const timeoutMs = params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
		const pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		const signal = params.signal;
		const throwOnFailure = params.throwOnFailure === true;

		return new Promise<v2.Turn>((resolve, reject) => {
			let settled = false;
			let polling = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			let interval: ReturnType<typeof setInterval> | undefined;

			const settle = (turn: v2.Turn): void => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				try {
					resolve(maybeThrowForFailedTurn(params.threadId, turn, throwOnFailure));
				} catch (error) {
					reject(error);
				}
			};

			const fail = (error: Error): void => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			};

			const onNotification = (message: JsonRpcNotification): void => {
				const turn = completedTurnFromNotification(
					message,
					params.threadId,
					params.turnId,
				);
				if (turn) {
					settle(turn);
				}
			};

			const onClose = (): void => {
				fail(new Error("Codex app-server connection closed while waiting for a turn"));
			};

			const onAbort = (): void => {
				fail(new Error("Codex flow wait aborted"));
			};

			const poll = (): void => {
				if (polling || settled) {
					return;
				}
				polling = true;
				void this.#findTurn(params.threadId, params.turnId)
					.then((turn) => {
						if (turn && isTerminalTurn(turn)) {
							settle(turn);
						}
					})
					.catch((error: unknown) => {
						if (!isRetryableThreadReadError(error)) {
							fail(asError(error));
						}
					})
					.finally(() => {
						polling = false;
					});
			};

			const cleanup = (): void => {
				if (timeout) clearTimeout(timeout);
				if (interval) clearInterval(interval);
				this.client.off?.("notification", onNotification);
				this.client.off?.("close", onClose);
				signal?.removeEventListener("abort", onAbort);
			};

			this.client.on?.("notification", onNotification);
			this.client.on?.("close", onClose);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
				return;
			}

			timeout = setTimeout(
				() =>
					fail(
						new CodexFlowTimeoutError({
							threadId: params.threadId,
							turnId: params.turnId,
							timeoutMs,
						}),
					),
				timeoutMs,
			);
			if (pollIntervalMs > 0) {
				interval = setInterval(poll, pollIntervalMs);
			}
			poll();
		});
	}

	async readThread(
		threadId: string,
		options: { includeTurns?: boolean } = {},
	): Promise<v2.Thread> {
		await this.connect();
		const response = await this.client.readThread({
			threadId,
			includeTurns: options.includeTurns === true,
		});
		return response.thread;
	}

	async #openThread(params: StartCodexFlowParams): Promise<v2.Thread> {
		if (params.threadId) {
			if (params.resume === false) {
				return this.readThread(params.threadId, { includeTurns: false });
			}
			const response = await this.client.resumeThread(
				threadResumeParams(params.threadId, params),
			);
			return response.thread;
		}

		const response = await this.client.startThread(threadStartParams(params));
		return response.thread;
	}

	async #findTurn(threadId: string, turnId: string): Promise<v2.Turn | undefined> {
		const thread = await this.readThread(threadId, { includeTurns: true });
		return thread.turns.find((turn) => turn.id === turnId);
	}
}

export function createCodexFlowClient(
	options: CodexFlowClientOptions = {},
): CodexFlowClient {
	return new CodexFlowClient(options);
}

export async function runCodexAgentTurnFromFlow(
	context: CodexFlowRunContextLike,
	options: RunCodexAgentTurnFromFlowOptions,
): Promise<RunCodexAgentTurnFromFlowResult> {
	const flowClient = options.flowClient ?? createCodexFlowClientForRunContext(context, options);
	const shouldClose = options.flowClient === undefined;
	try {
		const {
			flowClient: _flowClient,
			client: _client,
			appServerUrl: _appServerUrl,
			requestTimeoutMs: _requestTimeoutMs,
			exportThreadJson,
			...startOptions
		} = options;
		const started = await flowClient.startFlow({
			...startOptions,
			cwd: startOptions.cwd ?? context.flow.root,
			wait: startOptions.wait ?? { throwOnFailure: true },
		});
		let threadJsonPath: string | undefined;
		let exportedThread: v2.Thread | undefined;
		if (exportThreadJson) {
			exportedThread = await flowClient.readThread(started.threadId, { includeTurns: true });
			threadJsonPath = path.isAbsolute(exportThreadJson)
				? exportThreadJson
				: path.resolve(startOptions.cwd ?? context.flow.root, exportThreadJson);
			await mkdir(path.dirname(threadJsonPath), { recursive: true });
			await writeFile(threadJsonPath, `${JSON.stringify(exportedThread, null, 2)}\n`);
		}
		return {
			...started,
			...(threadJsonPath ? { threadJsonPath } : {}),
			...(exportedThread ? { exportedThread } : {}),
			artifacts: {
				threadId: started.threadId,
				turnId: started.turnId,
				...(started.completedTurn?.status ? { turnStatus: started.completedTurn.status } : {}),
				...(threadJsonPath ? { threadJsonPath } : {}),
			},
		};
	} finally {
		if (shouldClose) {
			flowClient.close();
		}
	}
}

export function toCodexUserInput(
	input: string | CodexFlowInput | undefined,
): v2.UserInput[] {
	if (!input) {
		return [];
	}
	if (typeof input === "string") {
		return [{ type: "text", text: input, text_elements: [] }];
	}
	const items = Array.isArray(input) ? input : [input];
	return items.map((item) => {
		if (item.type === "text") {
			return {
				type: "text",
				text: item.text,
				text_elements: item.text_elements ?? [],
			};
		}
		return item;
	}) as v2.UserInput[];
}

export function isTerminalTurn(turn: v2.Turn): boolean {
	return turn.status !== "inProgress";
}

function clientIdentityOptions(
	options: CodexFlowClientOptions,
): Pick<
	CodexAppServerClientOptions,
	"clientName" | "clientTitle" | "clientVersion"
> {
	return compactUndefined({
		clientName: options.clientName ?? "peezy.tech-codex-flows",
		clientTitle: options.clientTitle ?? "Codex Flows SDK",
		clientVersion: options.clientVersion ?? "0.1.0",
	});
}

function threadStartParams(params: StartCodexFlowParams): v2.ThreadStartParams {
	const thread = params.thread ?? {};
	return compactUndefined({
		...thread,
		model: params.model ?? thread.model,
		modelProvider: params.modelProvider ?? thread.modelProvider,
		serviceTier: params.serviceTier ?? thread.serviceTier,
		cwd: params.cwd ?? thread.cwd,
		approvalPolicy: params.approvalPolicy ?? thread.approvalPolicy,
		approvalsReviewer: params.approvalsReviewer ?? thread.approvalsReviewer,
		sandbox: params.sandbox ?? thread.sandbox,
		permissions: params.permissions ?? thread.permissions,
		config: params.config ?? thread.config,
		baseInstructions: params.baseInstructions ?? thread.baseInstructions,
		developerInstructions:
			params.developerInstructions ?? thread.developerInstructions,
		personality: params.personality ?? thread.personality,
		experimentalRawEvents: thread.experimentalRawEvents ?? false,
		persistExtendedHistory: thread.persistExtendedHistory ?? false,
	});
}

function threadResumeParams(
	threadId: string,
	params: StartCodexFlowParams,
): v2.ThreadResumeParams {
		const resume =
			params.resume === undefined || params.resume === false ? {} : params.resume;
	return compactUndefined({
		...resume,
		threadId,
		model: params.model ?? resume.model,
		modelProvider: params.modelProvider ?? resume.modelProvider,
		serviceTier: params.serviceTier ?? resume.serviceTier,
		cwd: params.cwd ?? resume.cwd,
		approvalPolicy: params.approvalPolicy ?? resume.approvalPolicy,
		approvalsReviewer: params.approvalsReviewer ?? resume.approvalsReviewer,
		sandbox: params.sandbox ?? resume.sandbox,
		permissions: params.permissions ?? resume.permissions,
		config: params.config ?? resume.config,
		baseInstructions: params.baseInstructions ?? resume.baseInstructions,
		developerInstructions:
			params.developerInstructions ?? resume.developerInstructions,
		personality: params.personality ?? resume.personality,
		excludeTurns: resume.excludeTurns ?? true,
		persistExtendedHistory: resume.persistExtendedHistory ?? false,
	});
}

function turnStartParams(
	threadId: string,
	input: v2.UserInput[],
	params: StartCodexFlowParams,
): v2.TurnStartParams {
	const turn = params.turn ?? {};
	return compactUndefined({
		...turn,
		threadId,
		input,
		cwd: params.cwd ?? turn.cwd,
		approvalPolicy: params.approvalPolicy ?? turn.approvalPolicy,
		approvalsReviewer: params.approvalsReviewer ?? turn.approvalsReviewer,
		permissions: params.permissions ?? turn.permissions,
		model: params.model ?? turn.model,
		serviceTier: params.serviceTier ?? turn.serviceTier,
		personality: params.personality ?? turn.personality,
		outputSchema: params.outputSchema ?? turn.outputSchema,
	});
}

function normalizeWait(
	wait: StartCodexFlowParams["wait"],
): CodexFlowWaitOptions | undefined {
	if (wait === true) {
		return {};
	}
	if (!wait) {
		return undefined;
	}
	return wait;
}

function completedTurnFromNotification(
	message: JsonRpcNotification,
	threadId: string,
	turnId: string,
): v2.Turn | undefined {
	if (message.method !== "turn/completed" || !isRecord(message.params)) {
		return undefined;
	}
	if (message.params.threadId !== threadId || !isRecord(message.params.turn)) {
		return undefined;
	}
	const turn = message.params.turn as Partial<v2.Turn>;
	return turn.id === turnId && typeof turn.status === "string"
		? (turn as v2.Turn)
		: undefined;
}

function maybeThrowForFailedTurn(
	threadId: string,
	turn: v2.Turn,
	throwOnFailure: boolean,
): v2.Turn {
	if (throwOnFailure && turn.status === "failed") {
		throw new CodexFlowTurnFailedError(threadId, turn);
	}
	return turn;
}

function createCodexFlowClientForRunContext(
	context: CodexFlowRunContextLike,
	options: RunCodexAgentTurnFromFlowOptions,
): CodexFlowClient {
	const workspaceBackendUrl = context.runtime?.workspaceBackendUrl;
	const client = options.client ??
		(workspaceBackendUrl
			? new CodexWorkspaceBackendClient({
					webSocketTransportOptions: {
						url: workspaceBackendUrl,
						requestTimeoutMs: options.requestTimeoutMs,
					},
					clientName: "codex-flow-agent-turn",
					clientTitle: `Codex Flow ${context.flow.name}/${context.flow.step}`,
				})
			: undefined);
	return createCodexFlowClient({
		client,
		closeInjectedClient: client ? true : undefined,
		appServerUrl: client ? undefined : options.appServerUrl,
		requestTimeoutMs: options.requestTimeoutMs,
		clientName: "codex-flow-agent-turn",
		clientTitle: `Codex Flow ${context.flow.name}/${context.flow.step}`,
	});
}

function isRetryableThreadReadError(error: unknown): boolean {
	const message = errorMessage(error).toLowerCase();
	return message.includes("thread") &&
		(message.includes("not found") ||
			message.includes("unknown") ||
			message.includes("not materialized") ||
			message.includes("no such"));
}

function compactUndefined<T extends Record<string, unknown>>(value: T): T {
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			result[key] = entry;
		}
	}
	return result as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
