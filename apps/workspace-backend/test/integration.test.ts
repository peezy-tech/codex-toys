import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	CodexWorkspaceBackendProtocolServer,
	type CodexWorkspaceBackendAppServer,
	type CodexWorkspaceBackendPeer,
} from "@peezy.tech/codex-flows/workspace-backend";
import { CodexEventEmitter } from "../../../packages/codex-client/src/app-server/events.ts";
import { readConfig } from "../src/flow/config.ts";
import { WorkspaceFlowCapability } from "../src/flow/server.ts";

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
			bunCommand: process.execPath,
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
	const peers = new WeakMap<Bun.ServerWebSocket<unknown>, CodexWorkspaceBackendPeer>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, bunServer) {
			if (bunServer.upgrade(request)) {
				return undefined;
			}
			return await flow.handleHttp(request) ??
				new Response("workspace backend", { status: 426 });
		},
		websocket: {
			open(socket) {
				const peer: CodexWorkspaceBackendPeer = {
					send: (message) => socket.send(message),
				};
				peers.set(socket, peer);
				workspaceBackend.addPeer(peer);
			},
			message(socket, message) {
				const peer = peers.get(socket);
				if (!peer) {
					return;
				}
				void workspaceBackend.handleMessage(peer, websocketMessageToString(message));
			},
			close(socket) {
				const peer = peers.get(socket);
				if (peer) {
					workspaceBackend.removePeer(peer);
					peers.delete(socket);
				}
			},
		},
	});

	try {
		const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ ok: true });

		const responses = await websocketRequests(
			`ws://127.0.0.1:${server.port}/__codex-workspace-backend`,
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
		server.stop(true);
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

function websocketMessageToString(message: string | Buffer): string {
	return typeof message === "string" ? message : message.toString("utf8");
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
