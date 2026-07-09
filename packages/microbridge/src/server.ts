import { CodexEventEmitter } from "@codex-appkit/app-server/events";
import {
	isJsonRpcNotification,
	isJsonRpcRequest,
	type JsonRpcId,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
} from "@codex-appkit/app-server/rpc";
import {
	APP_CALL_METHOD,
	APP_NOTIFICATION_METHOD,
	APP_NOTIFY_METHOD,
	APP_REQUEST_METHOD,
	APP_RESPOND_ERROR_METHOD,
	APP_RESPOND_METHOD,
	MICROBRIDGE_EVENT_METHOD,
	MICROBRIDGE_INITIALIZE_METHOD,
	appCallParams,
	appNotifyParams,
	appRespondErrorParams,
	appRespondParams,
	type MicrobridgeEvent,
	type MicrobridgeInitializeResponse,
	type MicrobridgeMethodMetadata,
} from "./protocol.ts";

export type MicrobridgeMethodHandler = (
	params: unknown,
	request: JsonRpcRequest,
) => unknown | Promise<unknown>;

export type MicrobridgeAppServer = CodexEventEmitter & {
	connect?(): Promise<void>;
	close?(): void;
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
	notify(method: string, params?: unknown): void;
	respond(id: JsonRpcId, result: unknown): void;
	respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void;
};

export type MicrobridgePeer = {
	send(message: string): void;
};

export type MicrobridgeProtocolServerOptions = {
	appServer: MicrobridgeAppServer;
	now?: () => Date;
	serverName?: string;
	serverVersion?: string;
	methods?: Record<string, MicrobridgeMethodHandler>;
	methodMetadata?: MicrobridgeMethodMetadata[];
};

export class MicrobridgeProtocolServer {
	readonly appServer: MicrobridgeAppServer;
	#peers = new Set<MicrobridgePeer>();
	#now: () => Date;
	#serverName: string;
	#serverVersion: string;
	#methods: Map<string, MicrobridgeMethodHandler>;
	#methodMetadata: MicrobridgeMethodMetadata[];

	constructor(options: MicrobridgeProtocolServerOptions) {
		this.appServer = options.appServer;
		this.#now = options.now ?? (() => new Date());
		this.#serverName = options.serverName ?? "codex-appkit-microbridge";
		this.#serverVersion = options.serverVersion ?? "0.1.0";
		this.#methods = new Map(Object.entries(options.methods ?? {}));
		const metadata = new Map<string, MicrobridgeMethodMetadata>();
		for (const entry of options.methodMetadata ?? []) {
			metadata.set(entry.name, entry);
		}
		for (const name of this.#methods.keys()) {
			if (!metadata.has(name)) {
				metadata.set(name, { name });
			}
		}
		this.#methodMetadata = [...metadata.values()]
			.sort((left, right) => left.name.localeCompare(right.name));

		this.appServer.on("notification", (message) => {
			this.broadcastNotification(APP_NOTIFICATION_METHOD, { message });
		});
		this.appServer.on("request", (message) => {
			this.broadcastNotification(APP_REQUEST_METHOD, { message });
		});
		this.appServer.on("error", (error) => {
			this.broadcastMicrobridgeEvent({
				type: "appServer.error",
				at: this.#now().toISOString(),
				message: errorMessage(error),
			});
		});
		this.appServer.on("close", (code, reason) => {
			this.broadcastMicrobridgeEvent({
				type: "appServer.closed",
				at: this.#now().toISOString(),
				code: typeof code === "number" ? code : null,
				reason: typeof reason === "string" ? reason : null,
			});
		});
	}

	addPeer(peer: MicrobridgePeer): void {
		this.#peers.add(peer);
		this.sendMicrobridgeEvent(peer, {
			type: "connected",
			at: this.#now().toISOString(),
		});
	}

	removePeer(peer: MicrobridgePeer): void {
		this.#peers.delete(peer);
	}

	async handleMessage(peer: MicrobridgePeer, data: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(data) as unknown;
		} catch {
			peer.send(JSON.stringify(errorResponse(null, -32700, "Parse error")));
			return;
		}
		if (isJsonRpcNotification(parsed)) {
			await this.#handleNotification(parsed);
			return;
		}
		if (!isJsonRpcRequest(parsed)) {
			peer.send(JSON.stringify(errorResponse(null, -32600, "Invalid request")));
			return;
		}
		const response = await this.#handleRequest(parsed);
		peer.send(JSON.stringify(response));
	}

	broadcastNotification(method: string, params?: unknown): void {
		const message: JsonRpcNotification = { jsonrpc: "2.0", method, params };
		const data = JSON.stringify(message);
		for (const peer of this.#peers) {
			peer.send(data);
		}
	}

	broadcastMicrobridgeEvent(event: MicrobridgeEvent): void {
		this.broadcastNotification(MICROBRIDGE_EVENT_METHOD, { event });
	}

	sendMicrobridgeEvent(peer: MicrobridgePeer, event: MicrobridgeEvent): void {
		peer.send(JSON.stringify({
			jsonrpc: "2.0",
			method: MICROBRIDGE_EVENT_METHOD,
			params: { event },
		} satisfies JsonRpcNotification));
	}

	async #handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
		try {
			if (request.method === MICROBRIDGE_INITIALIZE_METHOD) {
				return successResponse(request.id, this.#initializeResponse());
			}
			const method = this.#methods.get(request.method);
			if (method) {
				const result = await method(request.params, request);
				return successResponse(request.id, result ?? { ok: true });
			}
			if (request.method === APP_CALL_METHOD) {
				const params = appCallParams(request.params);
				if (!params) {
					return errorResponse(request.id, -32602, "Invalid app.call params");
				}
				return successResponse(
					request.id,
					await this.appServer.request(params.method, params.params),
				);
			}
			if (request.method === APP_NOTIFY_METHOD) {
				const params = appNotifyParams(request.params);
				if (!params) {
					return errorResponse(request.id, -32602, "Invalid app.notify params");
				}
				this.appServer.notify(params.method, params.params);
				return successResponse(request.id, { ok: true });
			}
			if (request.method === APP_RESPOND_METHOD) {
				const params = appRespondParams(request.params);
				if (!params) {
					return errorResponse(request.id, -32602, "Invalid app.respond params");
				}
				this.appServer.respond(params.id, params.result);
				return successResponse(request.id, { ok: true });
			}
			if (request.method === APP_RESPOND_ERROR_METHOD) {
				const params = appRespondErrorParams(request.params);
				if (!params) {
					return errorResponse(request.id, -32602, "Invalid app.respondError params");
				}
				this.appServer.respondError(params.id, params.code, params.message, params.data);
				return successResponse(request.id, { ok: true });
			}
			this.broadcastMicrobridgeEvent({
				type: "unsupportedMethod",
				at: this.#now().toISOString(),
				method: request.method,
			});
			return errorResponse(request.id, -32601, `Unknown microbridge method: ${request.method}`);
		} catch (error) {
			return errorResponse(request.id, -32603, errorMessage(error));
		}
	}

	async #handleNotification(notification: JsonRpcNotification): Promise<void> {
		try {
			if (notification.method === APP_NOTIFY_METHOD) {
				const params = appNotifyParams(notification.params);
				if (params) {
					this.appServer.notify(params.method, params.params);
				}
			}
		} catch (error) {
			this.broadcastMicrobridgeEvent({
				type: "appServer.error",
				at: this.#now().toISOString(),
				message: errorMessage(error),
			});
		}
	}

	#initializeResponse(): MicrobridgeInitializeResponse {
		return {
			ok: true,
			serverInfo: {
				name: this.#serverName,
				version: this.#serverVersion,
			},
			capabilities: {
				appPassThrough: true,
				methods: [...this.#methods.keys()].sort(),
				methodMetadata: this.#methodMetadata,
			},
		};
	}
}

function successResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

function errorResponse(
	id: JsonRpcId | null,
	code: number,
	message: string,
	data?: unknown,
): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id: id ?? 0,
		error: { code, message, data },
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
