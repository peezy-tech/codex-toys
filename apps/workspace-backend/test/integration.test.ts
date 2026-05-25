import { expect, test } from "vite-plus/test";
import http from "node:http";
import { WebSocketServer, type RawData, type WebSocket as WsSocket } from "ws";
import { CodexEventEmitter } from "@peezy.tech/codex-flows";
import {
	CodexWorkspaceBackendProtocolServer,
	type CodexWorkspaceBackendAppServer,
	type CodexWorkspaceBackendPeer,
} from "@peezy.tech/codex-flows/workspace-backend";

test("networked local workspace backend serves control WebSocket", async () => {
	const appServer = new FakeAppServer();
	const workspaceBackend = new CodexWorkspaceBackendProtocolServer({
		appServer,
		methods: {
			"delegation.list": () => ({ delegations: [] }),
		},
	});
	const peers = new WeakMap<WsSocket, CodexWorkspaceBackendPeer>();
	const server = http.createServer((_request, response) => {
		response.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
		response.end("workspace backend");
	});
	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		wss.handleUpgrade(request, socket, head, (webSocket) => {
			wss.emit("connection", webSocket, request);
		});
	});
	wss.on("connection", (socket) => {
		const peer: CodexWorkspaceBackendPeer = {
			send: (message) => socket.send(message),
		};
		peers.set(socket, peer);
		workspaceBackend.addPeer(peer);
		socket.on("message", (message) => {
			const peer = peers.get(socket);
			if (!peer) {
				return;
			}
			void workspaceBackend.handleMessage(peer, websocketMessageToString(message));
		});
		socket.on("close", () => {
			const peer = peers.get(socket);
			if (peer) {
				workspaceBackend.removePeer(peer);
				peers.delete(socket);
			}
		});
	});
	await listen(server);
	const port = serverPort(server);

	try {
		const root = await fetch(`http://127.0.0.1:${port}/`);
		expect(root.status).toBe(426);

		const responses = await websocketRequests(
			`ws://127.0.0.1:${port}/__codex-workspace-backend`,
			[
				{
					jsonrpc: "2.0",
					id: "initialize",
					method: "workspace.initialize",
					params: {
						clientInfo: { name: "test", title: "Test", version: "0.1.0" },
						capabilities: { appServerPassThrough: true },
					},
				},
				{
					jsonrpc: "2.0",
					id: "threads",
					method: "appServer.call",
					params: { method: "thread/list", params: { limit: 1 } },
				},
				{
					jsonrpc: "2.0",
					id: "delegations",
					method: "delegation.list",
					params: {},
				},
			],
		);

		expect(responses.get("initialize")?.result).toMatchObject({
			ok: true,
			capabilities: {
				appServerPassThrough: true,
				workspaceMethods: ["delegation.list"],
			},
		});
		expect(responses.get("threads")?.result).toEqual({ threads: [] });
		expect(appServer.requests).toEqual([
			{ method: "thread/list", params: { limit: 1 } },
		]);
		expect(responses.get("delegations")?.result).toEqual({ delegations: [] });
	} finally {
		wss.close();
		await closeServer(server);
	}
});

class FakeAppServer extends CodexEventEmitter implements CodexWorkspaceBackendAppServer {
	requests: Array<{ method: string; params?: unknown }> = [];

	async request<T = unknown>(method: string, params?: unknown): Promise<T> {
		this.requests.push({ method, params });
		return { threads: [] } as T;
	}

	notify(): void {}

	respond(): void {}

	respondError(): void {}
}

type RpcResponse = {
	id: string | number;
	result?: unknown;
	error?: { code: number; message: string };
};

function websocketRequests(
	url: string,
	requests: Array<Record<string, unknown>>,
): Promise<Map<string | number, RpcResponse>> {
	return new Promise((resolve, reject) => {
		const responses = new Map<string | number, RpcResponse>();
		const socket = new WebSocket(url);
		const timeout = setTimeout(() => {
			socket.close();
			reject(new Error("Timed out waiting for WebSocket responses."));
		}, 2000);
		socket.addEventListener("open", () => {
			for (const request of requests) {
				socket.send(JSON.stringify(request));
			}
		});
		socket.addEventListener("message", (event) => {
			const parsed = JSON.parse(String(event.data)) as unknown;
			if (!isRpcResponse(parsed)) {
				return;
			}
			responses.set(parsed.id, parsed);
			if (responses.size === requests.length) {
				clearTimeout(timeout);
				socket.close();
				resolve(responses);
			}
		});
		socket.addEventListener("error", () => {
			clearTimeout(timeout);
			reject(new Error("WebSocket request failed."));
		});
	});
}

function websocketMessageToString(message: RawData): string {
	if (Array.isArray(message)) {
		return Buffer.concat(message).toString("utf8");
	}
	return typeof message === "string" ? message : message.toString("utf8");
}

function listen(server: http.Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeServer(server: http.Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	});
}

function serverPort(server: http.Server): number {
	const address = server.address();
	if (typeof address !== "object" || !address) {
		throw new Error("server is not listening");
	}
	return address.port;
}

function isRpcResponse(value: unknown): value is RpcResponse {
	return Boolean(
		value &&
			typeof value === "object" &&
			"id" in value &&
			(typeof (value as { id: unknown }).id === "string" ||
				typeof (value as { id: unknown }).id === "number"),
	);
}
