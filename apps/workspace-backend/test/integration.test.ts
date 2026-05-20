import { expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type RawData, type WebSocket as WsSocket } from "ws";
import {
	CodexWorkspaceBackendProtocolServer,
	type CodexWorkspaceBackendAppServer,
	type CodexWorkspaceBackendPeer,
} from "@peezy.tech/codex-flows/workspace-backend";
import { CodexEventEmitter } from "../../../packages/codex-client/src/app-server/events.ts";
import { readConfig } from "../src/flow/config.ts";
import { handleNodeHttpRequest, WorkspaceFlowCapability } from "../src/flow/server.ts";

test("networked local workspace backend serves control WebSocket and flow HTTP routes", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "workspace-backend-"));
	const appServer = new FakeAppServer();
	const flow = new WorkspaceFlowCapability({
		config: readConfig({}, {
			cwd: directory,
			dataDir: path.join(directory, ".codex", "flow-backend"),
			host: "127.0.0.1",
			port: 0,
			executor: "direct",
			nodeCommand: process.execPath,
		}),
		env: {},
	});
	const workspaceBackend = new CodexWorkspaceBackendProtocolServer({
		appServer,
		flowInspection: true,
		methods: {
			"flow.listEvents": () => flow.listEvents(),
		},
	});
	const peers = new WeakMap<WsSocket, CodexWorkspaceBackendPeer>();
	const server = http.createServer((request, response) => {
		void handleNodeHttpRequest(request, response, flow.config, async (webRequest) =>
			await flow.handleHttp(webRequest) ??
				new Response("workspace backend", { status: 426 }),
		);
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
		const health = await fetch(`http://127.0.0.1:${port}/healthz`);
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ ok: true });

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
					id: "events",
					method: "flow.listEvents",
					params: {},
				},
			],
		);

		expect(responses.get("initialize")?.result).toMatchObject({
			ok: true,
			capabilities: {
				appServerPassThrough: true,
				flowInspection: true,
				workspaceMethods: ["flow.listEvents"],
			},
		});
		expect(responses.get("threads")?.result).toEqual({ threads: [] });
		expect(appServer.requests).toEqual([
			{ method: "thread/list", params: { limit: 1 } },
		]);
		expect(responses.get("events")?.result).toEqual({ events: [] });
	} finally {
		wss.close();
		await closeServer(server);
		flow.close();
		await rm(directory, { recursive: true, force: true });
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
