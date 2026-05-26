import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { v2 } from "../app-server/generated/index.ts";
import { CodexAppServerClient } from "../app-server/client.ts";
import { CodexWebSocketTransport } from "../app-server/websocket-transport.ts";
import {
	APP_SERVER_CALL_METHOD,
	WORKSPACE_BACKEND_INITIALIZE_METHOD,
} from "../workspace-backend/protocol.ts";
import {
	createSshAppServerClient,
	hasSshRemote,
	startSshWorkspaceBackend,
	type SshRemoteProviderOptions,
} from "./remote-provider.ts";

export type RemoteVia = "workspace" | "app";

export type RemoteProbeResult = {
	mode: "workspace" | "app-server";
	status: "connected" | "unavailable";
	url: string;
	remoteControl?: v2.RemoteControlStatusReadResponse;
	error?: string;
};

export type RemoteStatusInfo = {
	workspaceBackend: RemoteProbeResult;
	appServer: RemoteProbeResult;
	recommendation: {
		preferred: "workspace" | "app-server" | "none";
		nextCommand: string;
	};
};

export type RemoteTurnStartResult = {
	via: "workspace" | "app-server";
	surface: "workspace" | "app-server";
	url: string;
	threadId: string;
	turnId: string;
	cwd?: string;
	status: v2.TurnStatus | "accepted" | "timed_out";
	finalMessage: string | null;
	error: string | null;
	durationMs: number | null;
	thread: unknown;
	turn: unknown;
};

export type RemoteTunnelOptions = {
	sshTarget?: string;
	localPort?: number;
	remoteHost?: string;
	remotePort?: number;
	dryRun?: boolean;
	env?: Record<string, string | undefined>;
};

export type RemoteTunnelPlan = {
	sshTarget: string;
	localPort: number;
	remoteHost: string;
	remotePort: number;
	workspaceUrl: string;
	command: string[];
	dryRun: boolean;
};

type AppServerRequest = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export async function collectRemoteStatusInfo(options: {
	appUrl: string;
	workspaceUrl: string;
	timeoutMs: number;
}): Promise<RemoteStatusInfo> {
	const workspaceBackend = await probeWorkspaceRemoteControl(options);
	const appServer = await probeAppServerRemoteControl(options);
	return {
		workspaceBackend,
		appServer,
		recommendation: remoteRecommendation(workspaceBackend, appServer),
	};
}

export async function startRemoteTurn(options: {
	prompt: string;
	threadId?: string;
	cwd?: string;
	via: RemoteVia;
	appUrl: string;
	workspaceUrl: string;
	timeoutMs: number;
	wait?: boolean;
	sandbox?: v2.SandboxMode;
	approvalPolicy?: v2.AskForApproval;
	permissions?: string;
	model?: string;
} & SshRemoteProviderOptions): Promise<RemoteTurnStartResult> {
	validateTurnOptions(options);
	if (hasSshRemote(options)) {
		return options.via === "workspace"
			? await startTurnViaSshWorkspace(options)
			: await startTurnViaSshAppServer(options);
	}
	return options.via === "workspace"
		? await startTurnViaWorkspace(options)
		: await startTurnViaAppServer(options);
}

export function createRemoteTunnelPlan(
	options: RemoteTunnelOptions = {},
): RemoteTunnelPlan {
	const env = options.env ?? process.env;
	const sshTarget = options.sshTarget ?? env.CODEX_FLOWS_REMOTE_SSH_TARGET;
	if (!sshTarget) {
		throw new Error(
			"remote tunnel start requires --ssh <user@tailscale-host> or CODEX_FLOWS_REMOTE_SSH_TARGET",
		);
	}
	const localPort = options.localPort ??
		envInteger(env.CODEX_FLOWS_REMOTE_TUNNEL_PORT) ??
		3586;
	const remoteHost = options.remoteHost ??
		env.CODEX_FLOWS_REMOTE_BACKEND_HOST ??
		"127.0.0.1";
	const remotePort = options.remotePort ??
		envInteger(env.CODEX_FLOWS_REMOTE_BACKEND_PORT) ??
		3586;
	return {
		sshTarget,
		localPort,
		remoteHost,
		remotePort,
		workspaceUrl: `ws://127.0.0.1:${localPort}`,
		command: [
			"ssh",
			"-N",
			"-L",
			`${localPort}:${remoteHost}:${remotePort}`,
			sshTarget,
		],
		dryRun: options.dryRun ?? false,
	};
}

export async function startRemoteTunnel(
	options: RemoteTunnelOptions = {},
): Promise<RemoteTunnelPlan> {
	const plan = createRemoteTunnelPlan(options);
	if (plan.dryRun) {
		return plan;
	}
	await new Promise<void>((resolve, reject) => {
		const child = spawn(plan.command[0]!, plan.command.slice(1), {
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(
				signal
					? `ssh tunnel exited with signal ${signal}`
					: `ssh tunnel exited with code ${code ?? "unknown"}`,
			));
		});
	});
	return plan;
}

export function formatRemoteStatusInfo(info: RemoteStatusInfo): string {
	const lines = [
		`workspace backend   ${probeLabel(info.workspaceBackend)}`,
		`app server          ${probeLabel(info.appServer)}`,
		`remote control      ${remoteControlLabel(info)}`,
		`next                ${info.recommendation.nextCommand}`,
	];
	return `${lines.join("\n")}\n`;
}

export function formatRemoteTurnStartResult(result: RemoteTurnStartResult): string {
	const lines = [
		`turn surface        ${result.via} (${result.url})`,
		`thread id           ${result.threadId}`,
		`turn id             ${result.turnId}`,
		`status              ${result.status}`,
	];
	if (result.finalMessage) {
		lines.push("", result.finalMessage);
	}
	if (result.error) {
		lines.push(`error               ${result.error}`);
	}
	return lines.join("\n") + "\n";
}

export function formatRemoteTunnelPlan(plan: RemoteTunnelPlan): string {
	return [
		`ssh target          ${plan.sshTarget}`,
		`workspace url       ${plan.workspaceUrl}`,
		`command             ${plan.command.join(" ")}`,
		plan.dryRun ? "status              dry run" : "status              tunnel exited",
	].join("\n") + "\n";
}

async function probeWorkspaceRemoteControl(options: {
	workspaceUrl: string;
	timeoutMs: number;
}): Promise<RemoteProbeResult> {
	const transport = new CodexWebSocketTransport({
		url: options.workspaceUrl,
		requestTimeoutMs: options.timeoutMs,
	});
	transport.on("error", () => {});
	try {
		const remoteControl = await withTimeout(async () => {
			await initializeWorkspaceTransport(transport);
			return await workspaceAppServerRequest<v2.RemoteControlStatusReadResponse>(
				transport,
				"remoteControl/status/read",
			);
		}, options.timeoutMs, `workspace remote control probe timed out after ${
			options.timeoutMs
		}ms`);
		return {
			mode: "workspace",
			status: "connected",
			url: options.workspaceUrl,
			remoteControl,
		};
	} catch (error) {
		return {
			mode: "workspace",
			status: "unavailable",
			url: options.workspaceUrl,
			error: errorMessage(error),
		};
	} finally {
		transport.close();
	}
}

async function probeAppServerRemoteControl(options: {
	appUrl: string;
	timeoutMs: number;
}): Promise<RemoteProbeResult> {
	if (options.appUrl !== "stdio://") {
		return await probeAppServerRemoteControlWebSocket(options);
	}
	const client = appServerClient(options.appUrl, options.timeoutMs);
	client.on("error", () => {});
	client.on("request", (message) => {
		client.respondError(
			message.id,
			-32603,
			"codex-flows remote control does not handle app-server requests",
		);
	});
	try {
		const remoteControl = await withTimeout(async () => {
			await client.connect();
			return await client.request<v2.RemoteControlStatusReadResponse>(
				"remoteControl/status/read",
			);
		}, options.timeoutMs, `app-server remote control probe timed out after ${
			options.timeoutMs
		}ms`);
		return {
			mode: "app-server",
			status: "connected",
			url: options.appUrl,
			remoteControl,
		};
	} catch (error) {
		return {
			mode: "app-server",
			status: "unavailable",
			url: options.appUrl,
			error: errorMessage(error),
		};
	} finally {
		client.close();
	}
}

async function probeAppServerRemoteControlWebSocket(options: {
	appUrl: string;
	timeoutMs: number;
}): Promise<RemoteProbeResult> {
	const transport = new CodexWebSocketTransport({
		url: options.appUrl,
		requestTimeoutMs: options.timeoutMs,
	});
	transport.on("error", () => {});
	try {
		const remoteControl = await withTimeout(async () => {
			await initializeAppServerTransport(transport);
			return await transport.request<v2.RemoteControlStatusReadResponse>(
				"remoteControl/status/read",
			);
		}, options.timeoutMs, `app-server remote control probe timed out after ${
			options.timeoutMs
		}ms`);
		return {
			mode: "app-server",
			status: "connected",
			url: options.appUrl,
			remoteControl,
		};
	} catch (error) {
		return {
			mode: "app-server",
			status: "unavailable",
			url: options.appUrl,
			error: errorMessage(error),
		};
	} finally {
		transport.close();
	}
}

async function startTurnViaWorkspace(options: {
	prompt: string;
	threadId?: string;
	cwd?: string;
	workspaceUrl: string;
	timeoutMs: number;
	wait?: boolean;
	sandbox?: v2.SandboxMode;
	approvalPolicy?: v2.AskForApproval;
	permissions?: string;
	model?: string;
}): Promise<RemoteTurnStartResult> {
	const transport = new CodexWebSocketTransport({
		url: options.workspaceUrl,
		requestTimeoutMs: options.timeoutMs,
	});
	transport.on("error", () => {});
	try {
		return await withTimeout(async () => {
			await initializeWorkspaceTransport(transport);
			return await startTurnWithRequest(
				"workspace",
				options.workspaceUrl,
				options,
				async (method, params) =>
					await workspaceAppServerRequest(transport, method, params),
			);
		}, options.timeoutMs, `workspace remote turn start timed out after ${
			options.timeoutMs
		}ms`);
	} finally {
		transport.close();
	}
}

async function startTurnViaSshWorkspace(
	options: {
		prompt: string;
		threadId?: string;
		cwd?: string;
		workspaceUrl: string;
		timeoutMs: number;
		wait?: boolean;
		sandbox?: v2.SandboxMode;
		approvalPolicy?: v2.AskForApproval;
		permissions?: string;
		model?: string;
	} & SshRemoteProviderOptions,
): Promise<RemoteTurnStartResult> {
	const backend = await startSshWorkspaceBackend(options);
	try {
		return await startTurnViaWorkspace({
			...options,
			workspaceUrl: backend.workspaceUrl,
		});
	} finally {
		backend.close();
	}
}

async function startTurnViaAppServer(options: {
	prompt: string;
	threadId?: string;
	cwd?: string;
	appUrl: string;
	timeoutMs: number;
	wait?: boolean;
	sandbox?: v2.SandboxMode;
	approvalPolicy?: v2.AskForApproval;
	permissions?: string;
	model?: string;
}): Promise<RemoteTurnStartResult> {
	if (options.appUrl !== "stdio://") {
		return await startTurnViaAppServerWebSocket(options);
	}
	const client = appServerClient(options.appUrl, options.timeoutMs);
	return await startTurnViaAppServerClient(client, options, options.appUrl);
}

async function startTurnViaSshAppServer(
	options: {
		prompt: string;
		threadId?: string;
		cwd?: string;
		appUrl: string;
		timeoutMs: number;
		wait?: boolean;
		sandbox?: v2.SandboxMode;
		approvalPolicy?: v2.AskForApproval;
		permissions?: string;
		model?: string;
	} & SshRemoteProviderOptions,
): Promise<RemoteTurnStartResult> {
	const client = createSshAppServerClient(options, {
		name: "codex-flows-remote-control",
		title: "Codex Flows Remote Control",
	});
	return await startTurnViaAppServerClient(client, options, "ssh://app-server");
}

async function startTurnViaAppServerClient(
	client: CodexAppServerClient,
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
	url: string,
): Promise<RemoteTurnStartResult> {
	client.on("error", () => {});
	client.on("request", (message) => {
		client.respondError(
			message.id,
			-32603,
			"codex-flows remote control does not handle app-server requests",
		);
	});
	try {
		return await withTimeout(async () => {
			await client.connect();
			return await startTurnWithRequest(
				"app-server",
				url,
				options,
				async (method, params) => await client.request(method, params),
			);
		}, options.timeoutMs, `app-server remote turn start timed out after ${
			options.timeoutMs
		}ms`);
	} finally {
		client.close();
	}
}

async function startTurnViaAppServerWebSocket(options: {
	prompt: string;
	threadId?: string;
	cwd?: string;
	appUrl: string;
	timeoutMs: number;
	wait?: boolean;
	sandbox?: v2.SandboxMode;
	approvalPolicy?: v2.AskForApproval;
	permissions?: string;
	model?: string;
}): Promise<RemoteTurnStartResult> {
	const transport = new CodexWebSocketTransport({
		url: options.appUrl,
		requestTimeoutMs: options.timeoutMs,
	});
	transport.on("error", () => {});
	try {
		return await withTimeout(async () => {
			await initializeAppServerTransport(transport);
			return await startTurnWithRequest(
				"app-server",
				options.appUrl,
				options,
				async (method, params) => await transport.request(method, params),
			);
		}, options.timeoutMs, `app-server remote turn start timed out after ${
			options.timeoutMs
		}ms`);
	} finally {
		transport.close();
	}
}

function appServerClient(url: string, timeoutMs: number): CodexAppServerClient {
	return new CodexAppServerClient({
		...(url === "stdio://"
			? { transportOptions: { requestTimeoutMs: timeoutMs } }
			: {
					webSocketTransportOptions: {
						url,
						requestTimeoutMs: timeoutMs,
					},
				}),
		clientName: "codex-flows-remote-control",
		clientTitle: "Codex Flows Remote Control",
		clientVersion: "0.1.0",
	});
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
			approvalPolicy?: v2.AskForApproval;
			permissions?: string;
			model?: string;
		},
): v2.TurnStartParams {
	return compactUndefined({
		threadId,
		cwd: options.cwd,
		approvalPolicy: options.approvalPolicy,
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
	surface: "workspace" | "app-server",
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
	const threadId = options.threadId ??
		nestedId(
			threadResponse = await request("thread/start", threadStartParams(options)),
			"thread",
			"thread/start",
		);
	const turnResponse = await request("turn/start", turnStartParams(threadId, options));
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
		const response = await options.request<v2.ThreadTurnsListResponse>(
			"thread/turns/list",
			{
				threadId: options.threadId,
				limit: 50,
				sortDirection: "desc",
				itemsView: "summary",
			},
		);
		latestTurn = arrayValue(record(response).data)
			.map(record)
			.find((turn) => stringValue(turn.id) === options.turnId);
		const status = turnStatus(latestTurn?.status);
		if (status && status !== "inProgress") {
			const items = await readTurnItems(options);
			return {
				status,
				finalMessage: finalAgentMessage(items),
				error: turnError(latestTurn),
				durationMs: numberValue(latestTurn?.durationMs),
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

function turnError(turn: Record<string, unknown> | undefined): string | null {
	const error = record(turn?.error);
	return stringValue(error.message) ?? null;
}

async function initializeWorkspaceTransport(
	transport: CodexWebSocketTransport,
): Promise<void> {
	await transport.request(WORKSPACE_BACKEND_INITIALIZE_METHOD, {
		clientInfo: {
			name: "codex-flows-remote-control",
			title: "Codex Flows Remote Control",
			version: "0.1.0",
		},
		capabilities: {
			appServerPassThrough: true,
		},
	});
}

async function workspaceAppServerRequest<T = unknown>(
	transport: CodexWebSocketTransport,
	method: string,
	params?: unknown,
): Promise<T> {
	return await transport.request<T>(APP_SERVER_CALL_METHOD, { method, params });
}

async function initializeAppServerTransport(
	transport: CodexWebSocketTransport,
): Promise<void> {
	await transport.request("initialize", {
		clientInfo: {
			name: "codex-flows-remote-control",
			title: "Codex Flows Remote Control",
			version: "0.1.0",
		},
		capabilities: {
			experimentalApi: true,
		},
	});
	transport.notify("initialized");
}

function remoteRecommendation(
	workspace: RemoteProbeResult,
	appServer: RemoteProbeResult,
): RemoteStatusInfo["recommendation"] {
	if (workspace.status === "connected") {
		return {
			preferred: "workspace",
			nextCommand: "codex-flows remote turn start --via workspace --prompt \"...\"",
		};
	}
	if (appServer.status === "connected") {
		return {
			preferred: "app-server",
			nextCommand: "codex-flows remote turn start --via app --prompt \"...\"",
		};
	}
	return {
		preferred: "none",
		nextCommand: "codex-flows remote tunnel start --ssh <user@tailscale-host> --dry-run",
	};
}

function remoteControlLabel(info: RemoteStatusInfo): string {
	const remote = info.workspaceBackend.remoteControl ?? info.appServer.remoteControl;
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

function compactUndefined<T extends Record<string, unknown>>(input: T): T {
	return Object.fromEntries(
		Object.entries(input).filter((entry) => entry[1] !== undefined),
	) as T;
}

function envInteger(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
