import { CodexEventEmitter } from "@codex-toys/bridge/app-server/events";
import {
	isJsonRpcNotification,
	isJsonRpcRequest,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
} from "@codex-toys/bridge/rpc";
import {
	APP_CALL_METHOD,
	APP_NOTIFICATION_METHOD,
	APP_NOTIFY_METHOD,
	APP_REQUEST_METHOD,
	APP_RESPOND_ERROR_METHOD,
	APP_RESPOND_METHOD,
	TOYBOX_EVENT_METHOD,
	TOYBOX_INITIALIZE_METHOD,
	appCallParams,
	appNotifyParams,
	appRespondErrorParams,
	appRespondParams,
	isToyboxOwnedMethod,
	type ToyboxEvent,
	type ToyboxInitializeResponse,
	type ToyboxMethodMetadata,
} from "./protocol.ts";

export type ToyboxMethodHandler = (
	params: unknown,
	request: JsonRpcRequest,
) => unknown | Promise<unknown>;

export type CodexToyboxAppServer = CodexEventEmitter & {
	connect?(): Promise<void>;
	close?(): void;
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
	notify(method: string, params?: unknown): void;
	respond(id: JsonRpcId, result: unknown): void;
	respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void;
};

export type CodexToyboxPeer = {
	send(message: string): void;
};

export type CodexToyboxProtocolServerOptions = {
	appServer: CodexToyboxAppServer;
	now?: () => Date;
	serverName?: string;
	serverVersion?: string;
	toyboxMethods?: string[];
	toyboxMethodMetadata?: ToyboxMethodMetadata[];
	methods?: Record<string, ToyboxMethodHandler>;
};

export class CodexToyboxProtocolServer {
	readonly appServer: CodexToyboxAppServer;
	#peers = new Set<CodexToyboxPeer>();
	#now: () => Date;
	#serverName: string;
	#serverVersion: string;
	#toyboxMethods: string[];
	#toyboxMethodMetadata: ToyboxMethodMetadata[];
	#methods: Map<string, ToyboxMethodHandler>;

	constructor(options: CodexToyboxProtocolServerOptions) {
		this.appServer = options.appServer;
		this.#now = options.now ?? (() => new Date());
		this.#serverName = options.serverName ?? "codex-toys-toybox";
		this.#serverVersion = options.serverVersion ?? "0.1.0";
		this.#methods = new Map(Object.entries(options.methods ?? {}));
		this.#toyboxMethods = options.toyboxMethods ??
			[...this.#methods.keys()].sort();
		const metadata = new Map<string, ToyboxMethodMetadata>();
		for (const entry of options.toyboxMethodMetadata ?? []) {
			metadata.set(entry.name, entry);
		}
		for (const name of this.#toyboxMethods) {
			if (!metadata.has(name)) {
				metadata.set(name, { name });
			}
		}
		this.#toyboxMethodMetadata = [...metadata.values()]
			.sort((left, right) => left.name.localeCompare(right.name));

		this.appServer.on("notification", (message) => {
			this.broadcastNotification(APP_NOTIFICATION_METHOD, { message });
		});
		this.appServer.on("request", (message) => {
			this.broadcastNotification(APP_REQUEST_METHOD, { message });
		});
		this.appServer.on("error", (error) => {
			this.broadcastToyboxEvent({
				type: "appServer.error",
				at: this.#now().toISOString(),
				message: errorMessage(error),
			});
		});
		this.appServer.on("close", (code, reason) => {
			this.broadcastToyboxEvent({
				type: "appServer.closed",
				at: this.#now().toISOString(),
				code: typeof code === "number" ? code : null,
				reason: typeof reason === "string" ? reason : null,
			});
		});
	}

	addPeer(peer: CodexToyboxPeer): void {
		this.#peers.add(peer);
		this.sendToyboxEvent(peer, {
			type: "connected",
			at: this.#now().toISOString(),
		});
	}

	removePeer(peer: CodexToyboxPeer): void {
		this.#peers.delete(peer);
	}

	async handleMessage(peer: CodexToyboxPeer, data: string): Promise<void> {
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

	broadcastToyboxEvent(event: ToyboxEvent): void {
		this.broadcastNotification(TOYBOX_EVENT_METHOD, { event });
	}

	sendToyboxEvent(peer: CodexToyboxPeer, event: ToyboxEvent): void {
		peer.send(JSON.stringify({
			jsonrpc: "2.0",
			method: TOYBOX_EVENT_METHOD,
			params: { event },
		} satisfies JsonRpcNotification));
	}

	async #handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
		try {
			if (request.method === TOYBOX_INITIALIZE_METHOD) {
				return successResponse(request.id, this.#initializeResponse());
			}
			const toyboxMethod = this.#methods.get(request.method);
			if (toyboxMethod) {
				const result = await toyboxMethod(request.params, request);
				return successResponse(request.id, result ?? { ok: true });
			}
			if (request.method === APP_CALL_METHOD) {
				const params = appCallParams(request.params);
				if (!params) {
					return errorResponse(request.id, -32602, "Invalid app.call params");
				}
				const result = await this.appServer.request(params.method, params.params);
				return successResponse(request.id, result);
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
					return errorResponse(
						request.id,
						-32602,
						"Invalid app.respondError params",
					);
				}
				this.appServer.respondError(
					params.id,
					params.code,
					params.message,
					params.data,
				);
				return successResponse(request.id, { ok: true });
			}
			if (isToyboxOwnedMethod(request.method)) {
				this.broadcastToyboxEvent({
					type: "unsupportedToyboxMethod",
					at: this.#now().toISOString(),
					method: request.method,
				});
				return errorResponse(
					request.id,
					-32601,
					`Toybox method is not implemented: ${request.method}`,
				);
			}
			return errorResponse(request.id, -32601, `Unknown toybox method: ${request.method}`);
		} catch (error) {
			return errorResponse(request.id, -32603, errorMessage(error));
		}
	}

	async #handleNotification(notification: JsonRpcNotification): Promise<void> {
		try {
			if (notification.method === APP_NOTIFY_METHOD) {
				const params = appNotifyParams(notification.params);
				if (!params) {
					this.broadcastToyboxEvent({
						type: "appServer.error",
						at: this.#now().toISOString(),
						message: "Invalid app.notify params",
					});
					return;
				}
				this.appServer.notify(params.method, params.params);
				return;
			}
			if (isToyboxOwnedMethod(notification.method)) {
				this.broadcastToyboxEvent({
					type: "unsupportedToyboxMethod",
					at: this.#now().toISOString(),
					method: notification.method,
				});
			}
		} catch (error) {
			this.broadcastToyboxEvent({
				type: "appServer.error",
				at: this.#now().toISOString(),
				message: errorMessage(error),
			});
		}
	}

	#initializeResponse(): ToyboxInitializeResponse {
		return {
			ok: true,
			serverInfo: {
				name: this.#serverName,
				version: this.#serverVersion,
			},
			capabilities: {
				appPassThrough: true,
				toyboxMethods: this.#toyboxMethods,
				toyboxMethodMetadata: this.#toyboxMethodMetadata,
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
	return { jsonrpc: "2.0", id: id ?? 0, error: { code, message, data } };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type { JsonRpcMessage };
