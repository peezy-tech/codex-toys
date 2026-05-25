import { CodexEventEmitter } from "./events.ts";
import {
	type JsonRpcId,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	requireJsonRpcResult,
} from "./rpc.ts";

type PendingRequest = {
	resolve: (value: JsonRpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export type CodexWebSocketTransportOptions = {
	url: string;
	requestTimeoutMs?: number;
};

export class CodexWebSocketTransport extends CodexEventEmitter {
	readonly requestTimeoutMs: number;
	#url: string;
	#socket: WebSocket | undefined;
	#connecting: Promise<void> | undefined;
	#nextRequestId = 1;
	#pending = new Map<JsonRpcId, PendingRequest>();

	constructor(options: CodexWebSocketTransportOptions) {
		super();
		this.#url = options.url;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
	}

	get running(): boolean {
		return this.#socket?.readyState === WebSocket.OPEN;
	}

	start(): void {
		void this.#connect().catch(() => {
			// The transport emits connection errors; this marks eager starts as handled.
		});
	}

	close(): void {
		const socket = this.#socket;
		this.#socket = undefined;
		this.#connecting = undefined;
		if (socket && socket.readyState < WebSocket.CLOSING) {
			socket.close();
		}
		this.#rejectAll(new Error("codex app-server transport closed"));
	}

	async request<T = unknown>(method: string, params?: unknown): Promise<T> {
		await this.#connect();
		const id = this.#nextRequestId++;
		const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`JSON-RPC request timed out: ${method}`));
			}, this.requestTimeoutMs);
			this.#pending.set(id, { resolve, reject, timer });
			this.#write({ jsonrpc: "2.0", id, method, params });
		});
		return requireJsonRpcResult<T>(response);
	}

	notify(method: string, params?: unknown): void {
		void this.#connect().then(() => {
			this.#write({ jsonrpc: "2.0", method, params });
		}).catch((error: unknown) => this.emit("error", error));
	}

	respond(id: JsonRpcId, result: unknown): void {
		void this.#connect().then(() => {
			this.#write({ jsonrpc: "2.0", id, result });
		}).catch((error: unknown) => this.emit("error", error));
	}

	respondError(
		id: JsonRpcId,
		code: number,
		message: string,
		data?: unknown,
	): void {
		void this.#connect().then(() => {
			this.#write({ jsonrpc: "2.0", id, error: { code, message, data } });
		}).catch((error: unknown) => this.emit("error", error));
	}

	async #connect(): Promise<void> {
		if (this.running) {
			return;
		}
		if (this.#connecting) {
			return this.#connecting;
		}
		this.#connecting = new Promise((resolve, reject) => {
			const socket = new WebSocket(this.#url);
			this.#socket = socket;
			socket.addEventListener("open", () => {
				this.#connecting = undefined;
				resolve();
			});
			socket.addEventListener("message", (event) => {
				this.#handleMessage(String(event.data));
			});
			socket.addEventListener("error", () => {
				const error = new Error(`codex app-server websocket error: ${this.#url}`);
				this.#connecting = undefined;
				this.#rejectAll(error);
				this.emit("error", error);
				reject(error);
			});
			socket.addEventListener("close", (event) => {
				this.#socket = undefined;
				this.#connecting = undefined;
				this.#rejectAll(
					new Error(`codex app-server websocket closed: ${event.code}`),
				);
				this.emit("close", event.code, event.reason);
			});
		});
		return this.#connecting;
	}

	#write(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
		const socket = this.#socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			throw new Error("codex app-server transport is not running");
		}
		socket.send(JSON.stringify(message));
	}

	#handleMessage(data: string): void {
		let message: unknown;
		try {
			message = JSON.parse(data) as unknown;
		} catch (error) {
			this.emit(
				"error",
				new Error(`Failed to parse app-server JSON-RPC message: ${String(error)}`),
			);
			return;
		}

		if (isJsonRpcResponse(message)) {
			const pending = this.#pending.get(message.id);
			if (pending) {
				clearTimeout(pending.timer);
				this.#pending.delete(message.id);
				pending.resolve(message);
			}
			return;
		}

		if (isJsonRpcRequest(message)) {
			this.emit("request", message);
			return;
		}

		if (isJsonRpcNotification(message)) {
			this.emit("notification", message);
			return;
		}

		this.emit("error", new Error("Received malformed JSON-RPC message"));
	}

	#rejectAll(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}
}
