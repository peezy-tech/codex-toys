import { describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	CodexToyboxClient,
	CodexToyboxProtocolServer,
	createWorkspaceDeferredRunMethods,
	createWorkspaceDelegationMethods,
	type CodexToyboxAppServer,
	type CodexToyboxPeer,
} from "../src/toybox/index.ts";
import { CodexEventEmitter } from "../src/app-server/events.ts";
import type {
	JsonRpcId,
	JsonRpcNotification,
	JsonRpcResponse,
} from "../src/app-server/rpc.ts";

describe("Codex toybox protocol", () => {
	test("server proxies app.call without interpreting native app-server methods", async () => {
		const appServer = new FakeAppServer();
		const server = new CodexToyboxProtocolServer({ appServer });
		const peer = new MemoryPeer();
		server.addPeer(peer);

		await server.handleMessage(peer, JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "app.call",
			params: {
				method: "thread/list",
				params: { limit: 2 },
			},
		}));

		expect(appServer.requests).toEqual([
			{ method: "thread/list", params: { limit: 2 } },
		]);
		expect(peer.response(1)?.result).toEqual({
			method: "thread/list",
			params: { limit: 2 },
		});
	});

	test("server handles registered workspace methods without forwarding them", async () => {
		const appServer = new FakeAppServer();
		const server = new CodexToyboxProtocolServer({
			appServer,
			methods: {
				"delegation.list": () => ({ delegations: [] }),
			},
		});
		const peer = new MemoryPeer();
		server.addPeer(peer);

		await server.handleMessage(peer, JSON.stringify({
			jsonrpc: "2.0",
			id: "delegation",
			method: "delegation.list",
			params: {},
		}));

		expect(appServer.requests).toEqual([]);
		expect(peer.response("delegation")?.result).toEqual({ delegations: [] });
	});

	test("unknown toybox methods return method not found", async () => {
		const appServer = new FakeAppServer();
		const server = new CodexToyboxProtocolServer({ appServer });
		const peer = new MemoryPeer();
		server.addPeer(peer);

		await server.handleMessage(peer, JSON.stringify({
			jsonrpc: "2.0",
			id: "delegation",
			method: "delegation.start",
			params: { prompt: "do work" },
		}));

		expect(appServer.requests).toEqual([]);
		expect(peer.response("delegation")?.error?.code).toBe(-32601);
		expect(peer.notifications("toybox.event")).toContainEqual(
			expect.objectContaining({
				method: "toybox.event",
				params: {
					event: expect.objectContaining({
						type: "unsupportedToyboxMethod",
						method: "delegation.start",
					}),
				},
			}),
		);
	});

	test("server proxies app.notify notifications without a response", async () => {
		const appServer = new FakeAppServer();
		const server = new CodexToyboxProtocolServer({ appServer });
		const peer = new MemoryPeer();

		await server.handleMessage(peer, JSON.stringify({
			jsonrpc: "2.0",
			method: "app.notify",
			params: {
				method: "initialized",
				params: { ok: true },
			},
		}));

		expect(appServer.notifications).toEqual([
			{ method: "initialized", params: { ok: true } },
		]);
		expect(peer.messages).toEqual([]);
	});

	test("client uses app.call for native helpers and unwraps app-server notifications", async () => {
		const transport = new FakeToyboxTransport();
		const client = new CodexToyboxClient({
			transport,
			clientName: "test-web",
			clientTitle: "Test Web",
			clientVersion: "0.1.0",
		});
		const notifications: JsonRpcNotification[] = [];
		client.on("notification", (message) => notifications.push(message));

		await client.connect();
		await client.listThreads({ limit: 5, sourceKinds: [] });
		client.notify("initialized", { ok: true });
		transport.emit("notification", {
			jsonrpc: "2.0",
			method: "app.notification",
			params: {
				message: {
					jsonrpc: "2.0",
					method: "turn/completed",
					params: { threadId: "thread-1" },
				},
			},
		});

		expect(transport.requests).toEqual([
			{
				method: "toybox.initialize",
				params: {
					clientInfo: {
						name: "test-web",
						title: "Test Web",
						version: "0.1.0",
					},
					capabilities: {
						appPassThrough: true,
					},
				},
			},
			{
				method: "app.call",
				params: {
					method: "thread/list",
					params: { limit: 5, sourceKinds: [] },
				},
			},
			{
				method: "app.notify",
				params: {
					method: "initialized",
					params: { ok: true },
				},
			},
		]);
		expect(notifications).toEqual([
			{
				jsonrpc: "2.0",
				method: "turn/completed",
				params: { threadId: "thread-1" },
			},
		]);
	});

	test("delegation methods resolve @ targets and persist records", async () => {
		const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-toys-delegation-"));
		const target = path.join(workspaceRoot, "workspaces", "trading");
		await mkdir(target, { recursive: true });
		const statePath = path.join(workspaceRoot, ".codex", "workspace", "local", "delegations.json");
		const appServer = new FakeDelegationAppServer();
		const methods = createWorkspaceDelegationMethods({
			appServer,
			workspaceRoot,
			statePath,
			now: () => new Date("2026-05-29T00:00:00.000Z"),
		});

		const start = await methods["delegation.start"]!({
			cwd: "@/workspaces/trading",
			prompt: "inspect trading workspace",
			title: "Trading check",
			sandbox: "danger-full-access",
		}, jsonRpcRequest("start", "delegation.start")) as {
			delegation: { id: string; cwd: string; workspaceKey?: string; metadata?: Record<string, unknown> };
			turnId: string;
		};

		expect(start.turnId).toBe("turn-1");
		expect(start.delegation.cwd).toBe(target);
		expect(start.delegation.workspaceKey).toBe("@/workspaces/trading");
		expect(start.delegation.metadata).toMatchObject({
			workspaceRoot,
			requestedCwd: "@/workspaces/trading",
		});
		expect(appServer.requests.map((entry) => entry.method)).toEqual([
			"thread/start",
			"thread/name/set",
			"turn/start",
		]);
		expect(appServer.requests[0]?.params).toMatchObject({
			cwd: target,
			sandbox: "danger-full-access",
		});

		const list = await methods["delegation.list"]!(
			{},
			jsonRpcRequest("list", "delegation.list"),
		) as {
			delegations: unknown[];
			targets: Array<{ id: string; cwd: string; kind: string }>;
		};
		expect(list.delegations).toHaveLength(1);
		expect(list.targets).toContainEqual({
			id: "@/workspaces/trading",
			cwd: target,
			label: "trading",
			kind: "workspace",
			source: "discovered",
			exists: true,
		});

		const reloaded = createWorkspaceDelegationMethods({
			appServer: new FakeDelegationAppServer(),
			workspaceRoot,
			statePath,
		});
		const persisted = await reloaded["delegation.list"]!(
			{ includeTargets: false },
			jsonRpcRequest("persisted", "delegation.list"),
		) as { delegations: unknown[]; targets?: unknown[] };
		expect(persisted.delegations).toHaveLength(1);
		expect(persisted.targets).toBeUndefined();

		await expect(methods["delegation.start"]!(
			{ cwd: target, prompt: "absolute path without gate" },
			jsonRpcRequest("absolute", "delegation.start"),
		)).rejects.toThrow(/Absolute delegation cwd requires/);
	});

	test("deferred run methods persist mode-scoped intents", async () => {
		const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-toys-deferred-"));
		await mkdir(path.join(workspaceRoot, ".codex"), { recursive: true });
		const methods = createWorkspaceDeferredRunMethods({
			workspaceRoot,
			appRequest: async () => ({ ok: true }),
			workspaceRequest: async () => ({ ok: true }),
		});

		const created = await methods["deferred.create"]!(
			{
				target: {
					kind: "turn",
					prompt: "review later",
				},
			},
			jsonRpcRequest("create", "deferred.create"),
		) as { intent: { id: string; status: string } };
		const listed = await methods["deferred.list"]!(
			{},
			jsonRpcRequest("list", "deferred.list"),
		) as { intents: Array<{ id: string; status: string }> };
		const pruned = await methods["deferred.prune"]!(
			{
				olderThanDays: 1,
				dryRun: true,
			},
			jsonRpcRequest("prune", "deferred.prune"),
		) as { pruned: number };

		expect(created.intent.status).toBe("pending");
		expect(listed.intents).toContainEqual(expect.objectContaining({
			id: created.intent.id,
			status: "pending",
		}));
		expect(pruned.pruned).toBe(0);
	});
});

class FakeAppServer extends CodexEventEmitter implements CodexToyboxAppServer {
	requests: Array<{ method: string; params?: unknown }> = [];
	notifications: Array<{ method: string; params?: unknown }> = [];
	responses: Array<{ id: JsonRpcId; result: unknown }> = [];
	responseErrors: Array<{
		id: JsonRpcId;
		code: number;
		message: string;
		data?: unknown;
	}> = [];

	async request<T = unknown>(method: string, params?: unknown): Promise<T> {
		this.requests.push({ method, params });
		return { method, params } as T;
	}

	notify(method: string, params?: unknown): void {
		this.notifications.push({ method, params });
	}

	respond(id: JsonRpcId, result: unknown): void {
		this.responses.push({ id, result });
	}

	respondError(
		id: JsonRpcId,
		code: number,
		message: string,
		data?: unknown,
	): void {
		this.responseErrors.push({ id, code, message, data });
	}
}

class MemoryPeer implements CodexToyboxPeer {
	messages: unknown[] = [];

	send(message: string): void {
		this.messages.push(JSON.parse(message) as unknown);
	}

	response(id: JsonRpcId): JsonRpcResponse | undefined {
		return this.messages.find((message): message is JsonRpcResponse =>
			isRecord(message) && message.id === id
		);
	}

	notifications(method: string): JsonRpcNotification[] {
		return this.messages.filter((message): message is JsonRpcNotification =>
			isRecord(message) && !("id" in message) && message.method === method
		);
	}
}

class FakeToyboxTransport extends CodexEventEmitter {
	readonly requestTimeoutMs = 60_000;
	requests: Array<{ method: string; params?: unknown }> = [];
	started = false;

	start(): void {
		this.started = true;
	}

	close(): void {
		this.started = false;
	}

	async request<T = unknown>(method: string, params?: unknown): Promise<T> {
		this.requests.push({ method, params });
		if (method === "toybox.initialize") {
			return {
				ok: true,
				serverInfo: { name: "fake", version: "0.1.0" },
				capabilities: {
					appPassThrough: true,
					toyboxMethods: [],
				},
			} as T;
		}
		return {} as T;
	}

	notify(method: string, params?: unknown): void {
		this.requests.push({ method, params });
	}
}

class FakeDelegationAppServer {
	requests: Array<{ method: string; params?: Record<string, unknown> }> = [];

	async request<T = unknown>(method: string, params?: unknown): Promise<T> {
		this.requests.push({ method, params: isRecord(params) ? params : undefined });
		if (method === "thread/start") {
			return { thread: { id: "thread-1", cwd: isRecord(params) ? params.cwd : undefined } } as T;
		}
		if (method === "thread/name/set") {
			return {} as T;
		}
		if (method === "turn/start") {
			return { turn: { id: "turn-1", status: "inProgress" } } as T;
		}
		if (method === "thread/read") {
			return {
				thread: {
					turns: [
						{
							id: "turn-1",
							status: "completed",
							items: [
								{
									type: "agentMessage",
									phase: "final_answer",
									text: "done",
								},
							],
						},
					],
				},
			} as T;
		}
		throw new Error(`Unexpected app-server method: ${method}`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRpcRequest(id: JsonRpcId, method: string) {
	return {
		jsonrpc: "2.0" as const,
		id,
		method,
		params: {},
	};
}
