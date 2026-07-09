import type { v2 } from "@codex-appkit/app-server/generated";
import { CodexEventEmitter } from "@codex-appkit/app-server/events";
import type { JsonRpcId } from "@codex-appkit/app-server/rpc";
import {
	APP_CALL_METHOD,
	APP_NOTIFICATION_METHOD,
	APP_NOTIFY_METHOD,
	APP_REQUEST_METHOD,
	APP_RESPOND_ERROR_METHOD,
	APP_RESPOND_METHOD,
	MICROBRIDGE_EVENT_METHOD,
	MICROBRIDGE_INITIALIZE_METHOD,
	appNotificationParams,
	appRequestParams,
	microbridgeEventParams,
	type MicrobridgeEvent,
	type MicrobridgeInitializeResponse,
} from "./protocol.ts";

export type MicrobridgeTransport = CodexEventEmitter & {
	readonly requestTimeoutMs: number;
	start(): void;
	close(): void;
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
	notify(method: string, params?: unknown): void;
};

export type MicrobridgeClientOptions = {
	transport: MicrobridgeTransport;
	clientName?: string;
	clientTitle?: string;
	clientVersion?: string;
};

export class MicrobridgeClient extends CodexEventEmitter {
	readonly transport: MicrobridgeTransport;
	#clientName: string;
	#clientTitle: string | null;
	#clientVersion: string;
	#connected = false;

	constructor(options: MicrobridgeClientOptions) {
		super();
		this.transport = options.transport;
		this.#clientName = options.clientName ?? "codex-appkit-client";
		this.#clientTitle = options.clientTitle ?? "Codex AppKit Client";
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
			if (message.method === MICROBRIDGE_EVENT_METHOD) {
				const params = microbridgeEventParams(message.params);
				if (params) {
					this.emit("microbridgeEvent", params.event);
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
		await this.transport.request<MicrobridgeInitializeResponse>(
			MICROBRIDGE_INITIALIZE_METHOD,
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

	startThread(params: v2.ThreadStartParams): Promise<v2.ThreadStartResponse> {
		return this.request<v2.ThreadStartResponse>("thread/start", params);
	}

	listThreads(params: v2.ThreadListParams): Promise<v2.ThreadListResponse> {
		return this.request<v2.ThreadListResponse>("thread/list", params);
	}

	readThread(params: v2.ThreadReadParams): Promise<v2.ThreadReadResponse> {
		return this.request<v2.ThreadReadResponse>("thread/read", params);
	}

	startTurn(params: v2.TurnStartParams): Promise<v2.TurnStartResponse> {
		return this.request<v2.TurnStartResponse>("turn/start", params);
	}
}

export type { MicrobridgeEvent };
