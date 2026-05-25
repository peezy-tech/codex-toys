import { CodexEventEmitter } from "../app-server/events.ts";
import {
	isJsonRpcNotification,
	isJsonRpcRequest,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
} from "../app-server/rpc.ts";
import {
	APP_SERVER_CALL_METHOD,
	APP_SERVER_NOTIFICATION_METHOD,
	APP_SERVER_NOTIFY_METHOD,
	APP_SERVER_REQUEST_METHOD,
	APP_SERVER_RESPOND_ERROR_METHOD,
	APP_SERVER_RESPOND_METHOD,
	WORKSPACE_BACKEND_EVENT_METHOD,
	WORKSPACE_BACKEND_INITIALIZE_METHOD,
	appServerCallParams,
	appServerNotifyParams,
	appServerRespondErrorParams,
	appServerRespondParams,
	isWorkspaceBackendOwnedMethod,
	type WorkspaceBackendEvent,
	type WorkspaceBackendInitializeResponse,
} from "./protocol.ts";

export type WorkspaceBackendMethodHandler = (
	params: unknown,
	request: JsonRpcRequest,
) => unknown | Promise<unknown>;

export type CodexWorkspaceBackendAppServer = CodexEventEmitter & {
	connect?(): Promise<void>;
	close?(): void;
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
	notify(method: string, params?: unknown): void;
	respond(id: JsonRpcId, result: unknown): void;
	respondError(id: JsonRpcId, code: number, message: string, data?: unknown): void;
};

export type CodexWorkspaceBackendPeer = {
	send(message: string): void;
};

export type CodexWorkspaceBackendProtocolServerOptions = {
	appServer: CodexWorkspaceBackendAppServer;
	now?: () => Date;
	serverName?: string;
	serverVersion?: string;
	workspaceMethods?: string[];
	methods?: Record<string, WorkspaceBackendMethodHandler>;
};

export class CodexWorkspaceBackendProtocolServer {
	readonly appServer: CodexWorkspaceBackendAppServer;
	#peers = new Set<CodexWorkspaceBackendPeer>();
	#now: () => Date;
	#serverName: string;
	#serverVersion: string;
	#workspaceMethods: string[];
	#methods: Map<string, WorkspaceBackendMethodHandler>;

	constructor(options: CodexWorkspaceBackendProtocolServerOptions) {
		this.appServer = options.appServer;
		this.#now = options.now ?? (() => new Date());
		this.#serverName = options.serverName ?? "codex-workspace-backend-local";
		this.#serverVersion = options.serverVersion ?? "0.1.0";
		this.#methods = new Map(Object.entries(options.methods ?? {}));
		this.#workspaceMethods = options.workspaceMethods ??
			[...this.#methods.keys()].sort();

		this.appServer.on("notification", (message) => {
			this.broadcastNotification(APP_SERVER_NOTIFICATION_METHOD, { message });
		});
		this.appServer.on("request", (message) => {
			this.broadcastNotification(APP_SERVER_REQUEST_METHOD, { message });
		});
		this.appServer.on("error", (error) => {
			this.broadcastWorkspaceBackendEvent({
				type: "appServer.error",
				at: this.#now().toISOString(),
				message: errorMessage(error),
			});
		});
		this.appServer.on("close", (code, reason) => {
			this.broadcastWorkspaceBackendEvent({
				type: "appServer.closed",
				at: this.#now().toISOString(),
				code: typeof code === "number" ? code : null,
				reason: typeof reason === "string" ? reason : null,
			});
		});
	}

	addPeer(peer: CodexWorkspaceBackendPeer): void {
		this.#peers.add(peer);
		this.sendWorkspaceBackendEvent(peer, {
			type: "connected",
			at: this.#now().toISOString(),
		});
	}

	removePeer(peer: CodexWorkspaceBackendPeer): void {
		this.#peers.delete(peer);
	}

	async handleMessage(peer: CodexWorkspaceBackendPeer, data: string): Promise<void> {
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

	broadcastWorkspaceBackendEvent(event: WorkspaceBackendEvent): void {
		this.broadcastNotification(WORKSPACE_BACKEND_EVENT_METHOD, { event });
	}

	sendWorkspaceBackendEvent(peer: CodexWorkspaceBackendPeer, event: WorkspaceBackendEvent): void {
		peer.send(JSON.stringify({
			jsonrpc: "2.0",
			method: WORKSPACE_BACKEND_EVENT_METHOD,
			params: { event },
		} satisfies JsonRpcNotification));
	}

	async #handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
		try {
			if (request.method === WORKSPACE_BACKEND_INITIALIZE_METHOD) {
				return successResponse(request.id, this.#initializeResponse());
			}
			const workspaceMethod = this.#methods.get(request.method);
			if (workspaceMethod) {
				const result = await workspaceMethod(request.params, request);
				return successResponse(request.id, result ?? { ok: true });
			}
			if (request.method === APP_SERVER_CALL_METHOD) {
				const params = appServerCallParams(request.params);
				if (!params) {
					return errorResponse(request.id, -32602, "Invalid appServer.call params");
				}
				const result = await this.appServer.request(params.method, params.params);
				return successResponse(request.id, result);
			}
			if (request.method === APP_SERVER_NOTIFY_METHOD) {
				const params = appServerNotifyParams(request.params);
				if (!params) {
					return errorResponse(request.id, -32602, "Invalid appServer.notify params");
				}
				this.appServer.notify(params.method, params.params);
				return successResponse(request.id, { ok: true });
			}
			if (request.method === APP_SERVER_RESPOND_METHOD) {
				const params = appServerRespondParams(request.params);
				if (!params) {
					return errorResponse(request.id, -32602, "Invalid appServer.respond params");
				}
				this.appServer.respond(params.id, params.result);
				return successResponse(request.id, { ok: true });
			}
			if (request.method === APP_SERVER_RESPOND_ERROR_METHOD) {
				const params = appServerRespondErrorParams(request.params);
				if (!params) {
					return errorResponse(
						request.id,
						-32602,
						"Invalid appServer.respondError params",
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
			if (isWorkspaceBackendOwnedMethod(request.method)) {
				this.broadcastWorkspaceBackendEvent({
					type: "unsupportedWorkspaceBackendMethod",
					at: this.#now().toISOString(),
					method: request.method,
				});
				return errorResponse(
					request.id,
					-32601,
					`Workspace backend method is not implemented: ${request.method}`,
				);
			}
			return errorResponse(request.id, -32601, `Unknown workspace backend method: ${request.method}`);
		} catch (error) {
			return errorResponse(request.id, -32603, errorMessage(error));
		}
	}

	async #handleNotification(notification: JsonRpcNotification): Promise<void> {
		try {
			if (notification.method === APP_SERVER_NOTIFY_METHOD) {
				const params = appServerNotifyParams(notification.params);
				if (!params) {
					this.broadcastWorkspaceBackendEvent({
						type: "appServer.error",
						at: this.#now().toISOString(),
						message: "Invalid appServer.notify params",
					});
					return;
				}
				this.appServer.notify(params.method, params.params);
				return;
			}
			if (isWorkspaceBackendOwnedMethod(notification.method)) {
				this.broadcastWorkspaceBackendEvent({
					type: "unsupportedWorkspaceBackendMethod",
					at: this.#now().toISOString(),
					method: notification.method,
				});
			}
		} catch (error) {
			this.broadcastWorkspaceBackendEvent({
				type: "appServer.error",
				at: this.#now().toISOString(),
				message: errorMessage(error),
			});
		}
	}

	#initializeResponse(): WorkspaceBackendInitializeResponse {
		return {
			ok: true,
			serverInfo: {
				name: this.#serverName,
				version: this.#serverVersion,
			},
			capabilities: {
				appServerPassThrough: true,
				workspaceMethods: this.#workspaceMethods,
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
