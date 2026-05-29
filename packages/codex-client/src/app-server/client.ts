import type { v2 } from "./generated/index.ts";
import { CodexEventEmitter } from "./events.ts";
import type { JsonRpcId } from "./rpc.ts";
import {
	CodexStdioTransport,
	type CodexStdioTransportOptions,
} from "./stdio-transport.ts";

export type CodexAppServerTransport = CodexEventEmitter & {
	readonly requestTimeoutMs: number;
	start(): void;
	close(): void;
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
	notify(method: string, params?: unknown): void;
	respond(id: JsonRpcId, result: unknown): void;
	respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void;
};

export type CodexAppServerClientOptions = {
	transport?: CodexAppServerTransport;
	transportOptions?: CodexStdioTransportOptions;
	clientName?: string;
	clientTitle?: string;
	clientVersion?: string;
};

export class CodexAppServerClient extends CodexEventEmitter {
	readonly transport: CodexAppServerTransport;
	#clientName: string;
	#clientTitle: string | null;
	#clientVersion: string;
	#connected = false;

	constructor(options: CodexAppServerClientOptions = {}) {
		super();
		this.transport =
			options.transport ?? defaultTransport(options);
		this.#clientName = options.clientName ?? "@peezy.tech/codex-flows";
		this.#clientTitle = options.clientTitle ?? "Codex Client";
		this.#clientVersion = options.clientVersion ?? "0.1.0";

		this.transport.on("notification", (message) =>
			this.emit("notification", message),
		);
		this.transport.on("request", (message) => this.emit("request", message));
		this.transport.on("stderr", (line) => this.emit("stderr", line));
		this.transport.on("close", (code, signal) =>
			this.emit("close", code, signal),
		);
		this.transport.on("error", (error) => this.emit("error", error));
	}

	async connect(): Promise<void> {
		if (this.#connected) {
			return;
		}
		this.transport.start();
		await this.request("initialize", {
			clientInfo: {
				name: this.#clientName,
				title: this.#clientTitle,
				version: this.#clientVersion,
			},
			capabilities: {
				experimentalApi: true,
			},
		});
		this.transport.notify("initialized");
		this.#connected = true;
	}

	close(): void {
		this.#connected = false;
		this.transport.close();
	}

	request<T = unknown>(method: string, params?: unknown): Promise<T> {
		return this.transport.request<T>(method, params);
	}

	notify(method: string, params?: unknown): void {
		this.transport.notify(method, params);
	}

	respond(id: JsonRpcId, result: unknown): void {
		this.transport.respond(id, result);
	}

	respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
		this.transport.respondError(id, code, message, data);
	}

	startThread(
		params: v2.ThreadStartParams,
	): Promise<v2.ThreadStartResponse> {
		return this.request<v2.ThreadStartResponse>("thread/start", params);
	}

	resumeThread(
		params: v2.ThreadResumeParams,
	): Promise<v2.ThreadResumeResponse> {
		return this.request<v2.ThreadResumeResponse>("thread/resume", params);
	}

	forkThread(
		params: v2.ThreadForkParams,
	): Promise<v2.ThreadForkResponse> {
		return this.request<v2.ThreadForkResponse>("thread/fork", params);
	}

	listThreads(params: v2.ThreadListParams): Promise<v2.ThreadListResponse> {
		return this.request<v2.ThreadListResponse>("thread/list", params);
	}

	readThread(params: v2.ThreadReadParams): Promise<v2.ThreadReadResponse> {
		return this.request<v2.ThreadReadResponse>("thread/read", params);
	}

	injectThreadItems(
		params: v2.ThreadInjectItemsParams,
	): Promise<v2.ThreadInjectItemsResponse> {
		return this.request<v2.ThreadInjectItemsResponse>("thread/inject_items", params);
	}

	listThreadTurns(
		params: v2.ThreadTurnsListParams,
	): Promise<v2.ThreadTurnsListResponse> {
		return this.request<v2.ThreadTurnsListResponse>("thread/turns/list", params);
	}

	listThreadTurnItems(
		params: v2.ThreadTurnsItemsListParams,
	): Promise<v2.ThreadTurnsItemsListResponse> {
		return this.request<v2.ThreadTurnsItemsListResponse>(
			"thread/turns/items/list",
			params,
		);
	}

	setThreadName(params: v2.ThreadSetNameParams): Promise<v2.ThreadSetNameResponse> {
		return this.request<v2.ThreadSetNameResponse>("thread/name/set", params);
	}

	startTurn(params: v2.TurnStartParams): Promise<v2.TurnStartResponse> {
		return this.request<v2.TurnStartResponse>("turn/start", params);
	}

	steerTurn(params: v2.TurnSteerParams): Promise<v2.TurnSteerResponse> {
		return this.request<v2.TurnSteerResponse>("turn/steer", params);
	}

	interruptTurn(
		params: v2.TurnInterruptParams,
	): Promise<v2.TurnInterruptResponse> {
		return this.request<v2.TurnInterruptResponse>("turn/interrupt", params);
	}

	commandExec(params: v2.CommandExecParams): Promise<v2.CommandExecResponse> {
		return this.request<v2.CommandExecResponse>("command/exec", params);
	}

	commandExecWrite(
		params: v2.CommandExecWriteParams,
	): Promise<v2.CommandExecWriteResponse> {
		return this.request<v2.CommandExecWriteResponse>("command/exec/write", params);
	}

	commandExecTerminate(
		params: v2.CommandExecTerminateParams,
	): Promise<v2.CommandExecTerminateResponse> {
		return this.request<v2.CommandExecTerminateResponse>(
			"command/exec/terminate",
			params,
		);
	}

	setThreadGoal(
		params: v2.ThreadGoalSetParams,
	): Promise<v2.ThreadGoalSetResponse> {
		return this.request<v2.ThreadGoalSetResponse>("thread/goal/set", params);
	}

	getThreadGoal(
		params: v2.ThreadGoalGetParams,
	): Promise<v2.ThreadGoalGetResponse> {
		return this.request<v2.ThreadGoalGetResponse>("thread/goal/get", params);
	}

	clearThreadGoal(
		params: v2.ThreadGoalClearParams,
	): Promise<v2.ThreadGoalClearResponse> {
		return this.request<v2.ThreadGoalClearResponse>("thread/goal/clear", params);
	}

	listPlugins(params: v2.PluginListParams): Promise<v2.PluginListResponse> {
		return this.request<v2.PluginListResponse>("plugin/list", params);
	}

	installedPlugins(
		params: v2.PluginInstalledParams,
	): Promise<v2.PluginInstalledResponse> {
		return this.request<v2.PluginInstalledResponse>("plugin/installed", params);
	}

	readPlugin(params: v2.PluginReadParams): Promise<v2.PluginReadResponse> {
		return this.request<v2.PluginReadResponse>("plugin/read", params);
	}

	listPluginShares(): Promise<v2.PluginShareListResponse> {
		return this.request<v2.PluginShareListResponse>("plugin/share/list", {});
	}

	updatePluginShareTargets(
		params: v2.PluginShareUpdateTargetsParams,
	): Promise<v2.PluginShareUpdateTargetsResponse> {
		return this.request<v2.PluginShareUpdateTargetsResponse>(
			"plugin/share/updateTargets",
			params,
		);
	}

	readPluginSkill(
		params: v2.PluginSkillReadParams,
	): Promise<v2.PluginSkillReadResponse> {
		return this.request<v2.PluginSkillReadResponse>("plugin/skill/read", params);
	}

	getAccountRateLimits(): Promise<v2.GetAccountRateLimitsResponse> {
		return this.request<v2.GetAccountRateLimitsResponse>("account/rateLimits/read");
	}

	getAccount(
		params: v2.GetAccountParams = { refreshToken: false },
	): Promise<v2.GetAccountResponse> {
		return this.request<v2.GetAccountResponse>("account/read", params);
	}

}

function defaultTransport(
	options: CodexAppServerClientOptions,
): CodexAppServerTransport {
	return new CodexStdioTransport(options.transportOptions);
}
