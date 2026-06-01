import type { v2 } from "@codex-toys/bridge/generated";
import { CodexEventEmitter } from "@codex-toys/bridge/app-server/events";
import type { JsonRpcId } from "@codex-toys/bridge/rpc";
import {
	APP_CALL_METHOD,
	APP_NOTIFICATION_METHOD,
	APP_NOTIFY_METHOD,
	APP_REQUEST_METHOD,
	APP_RESPOND_ERROR_METHOD,
	APP_RESPOND_METHOD,
	TOYBOX_EVENT_METHOD,
	TOYBOX_INITIALIZE_METHOD,
	appNotificationParams,
	appRequestParams,
	toyboxEventParams,
	type ToyboxEvent,
	type ToyboxInitializeResponse,
} from "./protocol.ts";

export type CodexToyboxTransport = CodexEventEmitter & {
	readonly requestTimeoutMs: number;
	start(): void;
	close(): void;
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
	notify(method: string, params?: unknown): void;
};

export type CodexToyboxClientOptions = {
	transport: CodexToyboxTransport;
	clientName?: string;
	clientTitle?: string;
	clientVersion?: string;
};

export class CodexToyboxClient extends CodexEventEmitter {
	readonly transport: CodexToyboxTransport;
	#clientName: string;
	#clientTitle: string | null;
	#clientVersion: string;
	#connected = false;

	constructor(options: CodexToyboxClientOptions) {
		super();
		this.transport = options.transport;
		this.#clientName = options.clientName ?? "codex-toybox-client";
		this.#clientTitle = options.clientTitle ?? "Codex Toybox Client";
		this.#clientVersion = options.clientVersion ?? "0.1.0";

		this.transport.on("notification", (message) => {
			if (message.method === APP_NOTIFICATION_METHOD) {
				const params = appNotificationParams(message.params);
				if (params) {
					this.emit("notification", params.message);
				}
				return;
			}
			if (message.method === APP_REQUEST_METHOD) {
				const params = appRequestParams(message.params);
				if (params) {
					this.emit("request", params.message);
				}
				return;
			}
			if (message.method === TOYBOX_EVENT_METHOD) {
				const params = toyboxEventParams(message.params);
				if (params) {
					this.emit("toyboxEvent", params.event);
				}
				return;
			}
			this.emit("notification", message);
		});
		this.transport.on("close", (code, reason) => this.emit("close", code, reason));
		this.transport.on("error", (error) => this.emit("error", error));
	}

	async connect(): Promise<void> {
		if (this.#connected) {
			return;
		}
		this.transport.start();
		await this.transport.request<ToyboxInitializeResponse>(
			TOYBOX_INITIALIZE_METHOD,
			{
				clientInfo: {
					name: this.#clientName,
					title: this.#clientTitle,
					version: this.#clientVersion,
				},
				capabilities: {
					appPassThrough: true,
				},
			},
		);
		this.#connected = true;
	}

	close(): void {
		this.#connected = false;
		this.transport.close();
	}

	request<T = unknown>(method: string, params?: unknown): Promise<T> {
		return this.transport.request<T>(APP_CALL_METHOD, { method, params });
	}

	notify(method: string, params?: unknown): void {
		this.transport.notify(APP_NOTIFY_METHOD, { method, params });
	}

	respond(id: JsonRpcId, result: unknown): void {
		void this.transport.request(APP_RESPOND_METHOD, { id, result })
			.catch((error: unknown) => this.emit("error", error));
	}

	respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
		void this.transport.request(APP_RESPOND_ERROR_METHOD, {
			id,
			code,
			message,
			data,
		}).catch((error: unknown) => this.emit("error", error));
	}

	workbenchRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
		return this.transport.request<T>(method, params);
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

	getAccount(
		params: v2.GetAccountParams = { refreshToken: false },
	): Promise<v2.GetAccountResponse> {
		return this.request<v2.GetAccountResponse>("account/read", params);
	}
}

export type { ToyboxEvent };
