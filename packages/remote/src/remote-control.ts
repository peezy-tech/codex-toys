import { setTimeout as delay } from "node:timers/promises";
import { codexThreadUrl } from "@codex-toys/bridge";
import type { v2 } from "@codex-toys/bridge/generated";
import type { CodexToyboxTransport } from "@codex-toys/toybox";
import {
	APP_CALL_METHOD,
	TOYBOX_INITIALIZE_METHOD,
} from "@codex-toys/toybox";
import {
	createLocalToyboxTransport,
	hasSshRemote,
	withSshRemoteToyboxTransport,
	type SshRemoteProviderOptions,
} from "./remote-provider.ts";

export type RemoteVia = "workbench" | "app";

export type RemoteProbeResult = {
	mode: "workbench" | "app-server";
	status: "connected" | "unavailable";
	url: string;
	remoteControl?: v2.RemoteControlStatusReadResponse;
	error?: string;
};

export type RemoteStatusInfo = {
	toybox: RemoteProbeResult;
	appServer: RemoteProbeResult;
	recommendation: {
		preferred: "workbench" | "app-server" | "none";
		nextCommand: string;
	};
};

export type RemoteTurnStartResult = {
	via: "workbench" | "app-server";
	surface: "workbench" | "app-server";
	url: string;
	threadId: string;
	codexUrl: string;
	turnId: string;
	cwd?: string;
	status: v2.TurnStatus | "accepted" | "timed_out";
	finalMessage: string | null;
	error: string | null;
	durationMs: number | null;
	thread: unknown;
	turn: unknown;
};

type AppServerRequest = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export async function collectRemoteStatusInfo(
	options: { timeoutMs: number } & SshRemoteProviderOptions,
): Promise<RemoteStatusInfo> {
	const toybox = await probeToybox(options);
	return {
		toybox,
		appServer: {
			mode: "app-server",
			status: toybox.status,
			url: toybox.url,
			remoteControl: toybox.remoteControl,
			error: toybox.error,
		},
		recommendation: remoteRecommendation(toybox),
	};
}

export async function startRemoteTurn(options: {
	prompt: string;
	threadId?: string;
	cwd?: string;
	via: RemoteVia;
	appUrl: string;
	workbenchUrl: string;
	timeoutMs: number;
	wait?: boolean;
	sandbox?: v2.SandboxMode;
	approvalPolicy?: v2.AskForApproval;
	permissions?: string;
	model?: string;
} & SshRemoteProviderOptions): Promise<RemoteTurnStartResult> {
	validateTurnOptions(options);
	const surface = options.via === "app" ? "app-server" : "workbench";
	return await withToyboxTransport(options, async (transport, url) => {
		await initializeWorkbenchTransport(transport);
		return await startTurnWithRequest(
			surface,
			url,
			options,
			async (method, params) =>
				await workbenchAppServerRequest(transport, method, params),
		);
	});
}

export function formatRemoteStatusInfo(info: RemoteStatusInfo): string {
	const lines = [
		`toybox             ${probeLabel(info.toybox)}`,
		`remote control     ${remoteControlLabel(info)}`,
		`next               ${info.recommendation.nextCommand}`,
	];
	return `${lines.join("\n")}\n`;
}

export function formatRemoteTurnStartResult(result: RemoteTurnStartResult): string {
	const lines = [
		`turn surface        ${result.via} (${result.url})`,
		`thread id           ${result.threadId}`,
		`open thread         [Codex](${result.codexUrl})`,
		`turn id             ${result.turnId}`,
		`status              ${result.status}`,
	];
	if (result.finalMessage) {
		lines.push("", result.finalMessage);
	}
	if (result.error) {
		lines.push(`error               ${result.error}`);
	}
	return `${lines.join("\n")}\n`;
}

async function probeToybox(
	options: { timeoutMs: number } & SshRemoteProviderOptions,
): Promise<RemoteProbeResult> {
	try {
		return await withToyboxTransport(options, async (transport, url) => {
			const remoteControl = await withTimeout(async () => {
				await initializeWorkbenchTransport(transport);
				return await workbenchAppServerRequest<v2.RemoteControlStatusReadResponse>(
					transport,
					"remoteControl/status/read",
				);
			}, options.timeoutMs, `toybox remote control probe timed out after ${
				options.timeoutMs
			}ms`);
			return {
				mode: "workbench",
				status: "connected",
				url,
				remoteControl,
			};
		});
	} catch (error) {
		return {
			mode: "workbench",
			status: "unavailable",
			url: toyboxUrl(options),
			error: errorMessage(error),
		};
	}
}

async function withToyboxTransport<T>(
	options: { timeoutMs: number } & SshRemoteProviderOptions,
	callback: (transport: CodexToyboxTransport, url: string) => Promise<T>,
): Promise<T> {
	if (hasSshRemote(options)) {
		return await withSshRemoteToyboxTransport(options, async (transport) =>
			await callback(transport, "ssh://toybox")
		);
	}
	const transport = createLocalToyboxTransport(options);
	try {
		transport.start();
		return await callback(transport, "toybox://local");
	} finally {
		transport.close();
	}
}

function validateTurnOptions(options: {
	sandbox?: v2.SandboxMode;
	permissions?: string;
}): void {
	if (options.sandbox && options.permissions) {
		throw new Error("--sandbox cannot be combined with --permissions");
	}
}

function threadStartParams(options: {
	cwd?: string;
	sandbox?: v2.SandboxMode;
	approvalPolicy?: v2.AskForApproval;
	permissions?: string;
	model?: string;
}): v2.ThreadStartParams {
	return compactUndefined({
		model: options.model,
		cwd: options.cwd,
		sandbox: options.sandbox,
		approvalPolicy: options.approvalPolicy,
		permissions: options.permissions,
		experimentalRawEvents: false,
		persistExtendedHistory: false,
	});
}

function turnStartParams(
	threadId: string,
	options: {
		prompt: string;
		cwd?: string;
		sandbox?: v2.SandboxMode;
		approvalPolicy?: v2.AskForApproval;
		permissions?: string;
		model?: string;
	},
	flags: {
		includeSandboxPolicy?: boolean;
	} = {},
): v2.TurnStartParams {
	return compactUndefined({
		threadId,
		cwd: options.cwd,
		approvalPolicy: options.approvalPolicy,
		sandboxPolicy: flags.includeSandboxPolicy
			? sandboxPolicyFromMode(options.sandbox)
			: undefined,
		permissions: options.permissions,
		model: options.model,
		input: [
			{
				type: "text",
				text: options.prompt,
				text_elements: [],
			},
		],
	});
}

async function startTurnWithRequest(
	surface: "workbench" | "app-server",
	url: string,
	options: {
		prompt: string;
		threadId?: string;
		cwd?: string;
		timeoutMs: number;
		wait?: boolean;
		sandbox?: v2.SandboxMode;
		approvalPolicy?: v2.AskForApproval;
		permissions?: string;
		model?: string;
	},
	request: AppServerRequest,
): Promise<RemoteTurnStartResult> {
	const startedAt = Date.now();
	let threadResponse: unknown;
	const existingThread = Boolean(options.threadId);
	const threadId = options.threadId ??
		nestedId(
			threadResponse = await request("thread/start", threadStartParams(options)),
			"thread",
			"thread/start",
		);
	const turnResponse = await request(
		"turn/start",
		turnStartParams(threadId, options, {
			includeSandboxPolicy: existingThread,
		}),
	);
	const turn = record(record(turnResponse).turn);
	const turnId = stringValue(turn.id) ?? nestedId(turnResponse, "turn", "turn/start");
	const initialStatus = turnStatus(turn.status) ?? "accepted";
	let status: RemoteTurnStartResult["status"] = initialStatus;
	let finalMessage: string | null = null;
	let error: string | null = null;
	let durationMs: number | null = null;
	if (options.wait) {
		const waited = await waitForTurn({
			threadId,
			turnId,
			timeoutMs: Math.max(1, options.timeoutMs - (Date.now() - startedAt) - 100),
			request,
		});
		status = waited.status;
		finalMessage = waited.finalMessage;
		error = waited.error;
		durationMs = waited.durationMs;
	}
	return {
		via: surface,
		surface,
		url,
		threadId,
		codexUrl: codexThreadUrl(threadId),
		turnId,
		...(options.cwd ? { cwd: options.cwd } : {}),
		status,
		finalMessage,
		error,
		durationMs,
		thread: threadResponse ? record(threadResponse).thread : null,
		turn: record(turnResponse).turn,
	};
}

async function waitForTurn(options: {
	threadId: string;
	turnId: string;
	timeoutMs: number;
	request: AppServerRequest;
}): Promise<{
	status: v2.TurnStatus | "timed_out";
	finalMessage: string | null;
	error: string | null;
	durationMs: number | null;
}> {
	const deadline = Date.now() + options.timeoutMs;
	let latestTurn: Record<string, unknown> | undefined;
	while (Date.now() <= deadline) {
		const response = await options.request<v2.ThreadReadResponse>(
			"thread/read",
			{
				threadId: options.threadId,
				includeTurns: true,
			},
		);
		const thread = record(record(response).thread ?? response);
		latestTurn = arrayValue(thread.turns)
			.map(record)
			.find((turn) => stringValue(turn.id) === options.turnId);
		const status = turnStatus(latestTurn?.status);
		const completedTurn = latestTurn;
		if (completedTurn && status && status !== "inProgress") {
			const items = arrayValue(completedTurn.items);
			const finalItems = items.length > 0 ? items : await readTurnItems(options);
			return {
				status,
				finalMessage: finalAgentMessage(finalItems),
				error: turnError(completedTurn),
				durationMs: numberValue(completedTurn.durationMs),
			};
		}
		await delay(Math.min(500, Math.max(1, deadline - Date.now())));
	}
	return {
		status: "timed_out",
		finalMessage: latestTurn ? finalAgentMessage(arrayValue(latestTurn.items)) : null,
		error: `turn did not complete within ${options.timeoutMs}ms`,
		durationMs: null,
	};
}

async function readTurnItems(options: {
	threadId: string;
	turnId: string;
	request: AppServerRequest;
}): Promise<unknown[]> {
	try {
		const response = await options.request<v2.ThreadTurnsItemsListResponse>(
			"thread/turns/items/list",
			{
				threadId: options.threadId,
				turnId: options.turnId,
				limit: 200,
				sortDirection: "asc",
			},
		);
		return arrayValue(record(response).data);
	} catch {
		const response = await options.request<v2.ThreadTurnsListResponse>(
			"thread/turns/list",
			{
				threadId: options.threadId,
				limit: 50,
				sortDirection: "desc",
				itemsView: "full",
			},
		);
		const turn = arrayValue(record(response).data)
			.map(record)
			.find((entry) => stringValue(entry.id) === options.turnId);
		return arrayValue(turn?.items);
	}
}

function finalAgentMessage(items: unknown[]): string | null {
	for (const item of items.slice().reverse()) {
		const entry = record(item);
		if (entry.type === "agentMessage") {
			const text = stringValue(entry.text);
			if (text) {
				return text;
			}
		}
	}
	return null;
}

function turnStatus(value: unknown): v2.TurnStatus | undefined {
	if (
		value === "completed" ||
		value === "interrupted" ||
		value === "failed" ||
		value === "inProgress"
	) {
		return value;
	}
	return undefined;
}

function sandboxPolicyFromMode(
	mode: v2.SandboxMode | undefined,
): v2.SandboxPolicy | undefined {
	if (mode === "danger-full-access") {
		return { type: "dangerFullAccess" };
	}
	if (mode === "read-only") {
		return { type: "readOnly", networkAccess: false };
	}
	if (mode === "workspace-write") {
		return {
			type: "workspaceWrite",
			writableRoots: [],
			networkAccess: false,
			excludeTmpdirEnvVar: false,
			excludeSlashTmp: false,
		};
	}
	return undefined;
}

function turnError(turn: Record<string, unknown> | undefined): string | null {
	const error = record(turn?.error);
	return stringValue(error.message) ?? null;
}

async function initializeWorkbenchTransport(
	transport: CodexToyboxTransport,
): Promise<void> {
	await transport.request(TOYBOX_INITIALIZE_METHOD, {
		clientInfo: {
			name: "codex-toys-remote-control",
			title: "Codex Toys Remote Control",
			version: "0.1.0",
		},
		capabilities: {
			appPassThrough: true,
		},
	});
}

async function workbenchAppServerRequest<T = unknown>(
	transport: CodexToyboxTransport,
	method: string,
	params?: unknown,
): Promise<T> {
	return await transport.request<T>(APP_CALL_METHOD, { method, params });
}

function remoteRecommendation(
	workbench: RemoteProbeResult,
): RemoteStatusInfo["recommendation"] {
	if (workbench.status === "connected") {
		return {
			preferred: "workbench",
			nextCommand: "codex-toys turn run \"...\"",
		};
	}
	return {
		preferred: "none",
		nextCommand: "codex-toys --ssh <target> --cwd <remote-workbench> remote preflight",
	};
}

function remoteControlLabel(info: RemoteStatusInfo): string {
	const remote = info.toybox.remoteControl ?? info.appServer.remoteControl;
	if (!remote) {
		return "unavailable";
	}
	return `${remote.status} (${remote.serverName}, installation ${remote.installationId})`;
}

function probeLabel(result: RemoteProbeResult): string {
	if (result.status === "connected") {
		return `connected (${result.url})`;
	}
	return result.error
		? `unavailable (${result.error})`
		: `unavailable (${result.url})`;
}

async function withTimeout<T>(
	callback: () => Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			callback(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

function nestedId(response: unknown, key: string, method: string): string {
	const id = stringValue(record(record(response)[key]).id);
	if (!id) {
		throw new Error(`${method} did not return ${key}.id`);
	}
	return id;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function toyboxUrl(options: Pick<SshRemoteProviderOptions, "sshTarget" | "env">): string {
	return hasSshRemote(options) ? "ssh://toybox" : "toybox://local";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
