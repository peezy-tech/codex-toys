import { describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	CodexToyboxClient,
	CodexToyboxProtocolServer,
	type CodexToyboxAppServer,
	type CodexToyboxPeer,
} from "@codex-toys/toybox";
import { CodexEventEmitter } from "@codex-toys/bridge/app-server/events";
import {
	collectHostOverview,
	createHostOverviewMethods,
	createWorkbenchDispatchRunMethods,
	createWorkbenchDelegationMethods,
	createWorkbenchOverviewMethods,
	type HostOverviewCommandResult,
	WORKBENCH_OVERVIEW_METHOD,
} from "@codex-toys/workbench";
import type {
	JsonRpcId,
	JsonRpcNotification,
	JsonRpcResponse,
} from "@codex-toys/bridge/rpc";

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

	test("server handles registered workbench methods without forwarding them", async () => {
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

	test("host overview method returns bounded dashboard sections", async () => {
		const result = await collectHostOverview({
			now: () => new Date("2026-05-30T00:00:00.000Z"),
			packageVersion: "0.140.2",
			homedir: () => "/home/test",
			totalmem: () => 1_000,
			freemem: () => 250,
			uptime: () => 42,
			platform: () => "linux",
			arch: () => "x64",
			statfs: async () => ({
				bsize: 10,
				blocks: 100,
				bfree: 40,
				bavail: 30,
			}),
			runCommand: async (command) => {
				if (command === "docker") {
					return shellResult({
						stdout: JSON.stringify({
							ServerVersion: "26.0.0",
							Containers: 3,
							ContainersRunning: 1,
							Images: 8,
						}),
					});
				}
				if (command === "systemctl") {
					return shellResult({ stdout: "failed.service loaded failed failed Example failure\n" });
				}
				if (command === "tailscale") {
					return shellResult({
						stdout: JSON.stringify({
							BackendState: "Running",
							Self: { Online: true },
							Health: [],
						}),
					});
				}
				if (command === "codex") {
					return shellResult({ stdout: "codex-cli 1.2.3\n" });
				}
				return shellResult({ code: 127, error: `${command} not found` });
			},
			toyboxServerInfo: { name: "codex-toys-toybox", version: "0.1.0" },
		});

		expect(result).toMatchObject({
			ok: true,
			status: "degraded",
			generatedAt: "2026-05-30T00:00:00.000Z",
			disk: {
				status: "ok",
				filesystems: [
					expect.objectContaining({
						path: "/",
						totalBytes: 1_000,
						availableBytes: 300,
						usedPercent: 60,
					}),
					expect.objectContaining({ path: "/home/test" }),
				],
			},
			memory: {
				status: "ok",
				totalBytes: 1_000,
				freeBytes: 250,
				usedPercent: 75,
			},
			docker: {
				status: "ok",
				serverVersion: "26.0.0",
				running: 1,
			},
			systemd: {
				status: "degraded",
				failedUnits: [expect.objectContaining({ unit: "failed.service" })],
			},
			tailscale: {
				status: "ok",
				backendState: "Running",
				online: true,
			},
			versions: {
				toybox: { name: "codex-toys-toybox", version: "0.1.0" },
				packages: expect.arrayContaining([
					expect.objectContaining({ name: "codex-toys", version: "0.140.2" }),
					expect.objectContaining({ name: "codex-cli", version: "codex-cli 1.2.3" }),
				]),
			},
		});

		const methods = createHostOverviewMethods({
			packageVersion: "0.140.2",
			runCommand: async () => shellResult({ code: 127, error: "not found" }),
		});
		expect(await methods["host.overview"]!({}, jsonRpcRequest("host", "host.overview")))
			.toMatchObject({ ok: true, disk: { status: "ok" } });
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
		const workbenchRoot = await mkdtemp(path.join(os.tmpdir(), "codex-toys-delegation-"));
		const target = path.join(workbenchRoot, "workbenches", "trading");
		await mkdir(target, { recursive: true });
		const statePath = path.join(workbenchRoot, ".codex", "workbench", "local", "delegations.json");
		const appServer = new FakeDelegationAppServer();
		const methods = createWorkbenchDelegationMethods({
			appServer,
			workbenchRoot,
			statePath,
			now: () => new Date("2026-05-29T00:00:00.000Z"),
		});

		const start = await methods["delegation.start"]!({
			cwd: "@/workbenches/trading",
			prompt: "inspect trading workbench",
			title: "Trading check",
			sandbox: "danger-full-access",
		}, jsonRpcRequest("start", "delegation.start")) as {
			delegation: { id: string; cwd: string; workbenchKey?: string; metadata?: Record<string, unknown> };
			turnId: string;
		};

		expect(start.turnId).toBe("turn-1");
		expect(start.delegation.cwd).toBe(target);
		expect(start.delegation.workbenchKey).toBe("@/workbenches/trading");
		expect(start.delegation.metadata).toMatchObject({
			workbenchRoot,
			requestedCwd: "@/workbenches/trading",
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
			id: "@/workbenches/trading",
			cwd: target,
			label: "trading",
			kind: "workbench",
			source: "discovered",
			exists: true,
		});

		const reloaded = createWorkbenchDelegationMethods({
			appServer: new FakeDelegationAppServer(),
			workbenchRoot,
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

	test("dispatch run methods persist mode-scoped intents", async () => {
		const workbenchRoot = await mkdtemp(path.join(os.tmpdir(), "codex-toys-dispatch-"));
		await mkdir(path.join(workbenchRoot, ".codex"), { recursive: true });
		const methods = createWorkbenchDispatchRunMethods({
			workbenchRoot,
			appRequest: async () => ({ ok: true }),
			workbenchRequest: async () => ({ ok: true }),
		});

		const created = await methods["dispatch.create"]!(
			{
				target: {
					kind: "turn",
					prompt: "review later",
				},
			},
			jsonRpcRequest("create", "dispatch.create"),
		) as { intent: { id: string; status: string } };
		const listed = await methods["dispatch.list"]!(
			{},
			jsonRpcRequest("list", "dispatch.list"),
		) as { intents: Array<{ id: string; status: string }> };
		const read = await methods["dispatch.read"]!(
			{
				id: created.intent.id,
				includeOutput: true,
			},
			jsonRpcRequest("read", "dispatch.read"),
		) as { intent: { id: string }; attempts: unknown[]; outputs: unknown[] };
			const collected = await methods["dispatch.collect"]!(
				{
					cursor: "operator",
				},
				jsonRpcRequest("collect", "dispatch.collect"),
			) as { cursor: string; intents: unknown[] };
			const queuedPrompt = await methods["promptQueue.enqueue"]!(
				{
					prompt: "queue this for later",
					queue: "night",
					title: "later",
					effort: "low",
					runAt: "2100-01-01T00:00:00.000Z",
				},
				jsonRpcRequest("prompt-enqueue", "promptQueue.enqueue"),
			) as { intent: { id: string; status: string; source: { kind: string; queue: string }; target: { effort: string } } };
			const queuedPrompts = await methods["promptQueue.list"]!(
				{ queue: "night" },
				jsonRpcRequest("prompt-list", "promptQueue.list"),
			) as { intents: Array<{ id: string; source: { queue: string } }> };
			const promptRead = await methods["promptQueue.read"]!(
				{ id: queuedPrompt.intent.id },
				jsonRpcRequest("prompt-read", "promptQueue.read"),
			) as { intent: { id: string; source: { kind: string; queue: string } } };
			const promptCollect = await methods["promptQueue.collect"]!(
				{ queue: "night" },
				jsonRpcRequest("prompt-collect", "promptQueue.collect"),
			) as { cursor: string; intents: unknown[] };
			const handoff = await methods["localHandoff.enqueue"]!(
				{
					prompt: "run this locally",
					queue: "local",
					title: "browser smoke",
					targetHost: "local-controller",
					requiredCapabilities: ["browser"],
					runAt: "2000-01-01T00:00:00.000Z",
				},
				jsonRpcRequest("handoff-enqueue", "localHandoff.enqueue"),
			) as { intent: { id: string; status: string; source: { kind: string; queue: string; targetHost: string } } };
			const handoffs = await methods["localHandoff.list"]!(
				{ queue: "local" },
				jsonRpcRequest("handoff-list", "localHandoff.list"),
			) as { intents: Array<{ id: string; source: { queue: string } }> };
			const handoffRead = await methods["localHandoff.read"]!(
				{ id: handoff.intent.id },
				jsonRpcRequest("handoff-read", "localHandoff.read"),
			) as { intent: { id: string; source: { kind: string; queue: string } } };
			const handoffCollect = await methods["localHandoff.collect"]!(
				{ queue: "local" },
				jsonRpcRequest("handoff-collect", "localHandoff.collect"),
			) as { cursor: string; intents: unknown[] };
			const handoffBlocked = await methods["localHandoff.drain"]!(
				{},
				jsonRpcRequest("handoff-blocked", "localHandoff.drain"),
			) as { executions: unknown[] };
			const due = await methods["dispatch.runDue"]!(
				{},
				jsonRpcRequest("run", "dispatch.runDue"),
			) as { executions: Array<{ intent: { id: string; status: string } }> };
			const handoffMaterialized = await methods["localHandoff.drain"]!(
				{
					capabilities: ["browser"],
					action: "materialize",
					promptQueue: "local-followups",
				},
				jsonRpcRequest("handoff-drain", "localHandoff.drain"),
			) as { action: string; executions: Array<{ output: { localHandoff: { handoffIntentId: string; promptIntentId: string; queue: string } } }> };
		const retried = await methods["dispatch.retry"]!(
			{
				id: created.intent.id,
				runAt: "2100-01-01T00:00:00.000Z",
			},
			jsonRpcRequest("retry", "dispatch.retry"),
		) as { intent: { id: string; status: string; runAt: string }; originalIntent: { id: string; status: string } };
		const oldRead = await methods["dispatch.read"]!(
			{
				id: created.intent.id,
				includeOutput: true,
			},
			jsonRpcRequest("old-read", "dispatch.read"),
		) as { intent: { id: string; status: string }; attempts: unknown[]; outputs: unknown[] };
		const pruned = await methods["dispatch.prune"]!(
			{
				olderThanDays: 1,
				dryRun: true,
			},
			jsonRpcRequest("prune", "dispatch.prune"),
		) as { pruned: number };

		expect(created.intent.status).toBe("pending");
		expect(listed.intents).toContainEqual(expect.objectContaining({
			id: created.intent.id,
			status: "pending",
		}));
		expect(read).toMatchObject({
			intent: { id: created.intent.id },
			attempts: [],
			outputs: [],
		});
			expect(collected).toMatchObject({
				cursor: "operator",
				intents: [],
			});
			expect(queuedPrompt).toMatchObject({
				intent: {
					status: "pending",
					source: {
						kind: "prompt-queue",
						queue: "night",
					},
					target: {
						effort: "low",
					},
				},
			});
			expect(queuedPrompts.intents.map((intent) => intent.id)).toEqual([queuedPrompt.intent.id]);
			expect(promptRead.intent.source).toMatchObject({ kind: "prompt-queue", queue: "night" });
			expect(promptCollect).toMatchObject({ cursor: "prompt-queue", intents: [] });
			expect(handoff).toMatchObject({
				intent: {
					status: "pending",
					source: {
						kind: "local-handoff",
						queue: "local",
						targetHost: "local-controller",
					},
				},
			});
			expect(handoffs.intents.map((intent) => intent.id)).toEqual([handoff.intent.id]);
			expect(handoffRead.intent.source).toMatchObject({ kind: "local-handoff", queue: "local" });
			expect(handoffCollect).toMatchObject({ cursor: "local-handoff", intents: [] });
			expect(handoffBlocked.executions).toEqual([]);
			expect(due.executions[0]?.intent).toMatchObject({
				id: created.intent.id,
				status: "failed",
		});
			expect(due.executions.map((execution) => execution.intent.id)).not.toContain(handoff.intent.id);
			expect(handoffMaterialized).toMatchObject({
				action: "materialize",
				executions: [{
					output: {
						localHandoff: {
							handoffIntentId: handoff.intent.id,
							queue: "local-followups",
						},
					},
				}],
			});
		expect(retried).toMatchObject({
			intent: {
				status: "pending",
				runAt: "2100-01-01T00:00:00.000Z",
			},
			originalIntent: {
				id: created.intent.id,
				status: "failed",
			},
		});
		expect(retried.intent.id).not.toBe(created.intent.id);
		expect(oldRead).toMatchObject({
			intent: {
				id: created.intent.id,
				status: "failed",
			},
			attempts: [expect.any(Object)],
			outputs: [expect.any(Object)],
		});
		expect(pruned.pruned).toBe(0);
	});

	test("workbench overview method returns bounded workbench status", async () => {
		const workbenchRoot = await mkdtemp(path.join(os.tmpdir(), "codex-toys-overview-"));
		await mkdir(path.join(workbenchRoot, ".codex"), { recursive: true });
		await writeFile(path.join(workbenchRoot, ".codex", "workbench.toml"), [
			"[workbench]",
			"name = \"overview\"",
			"",
			"[[workbench.tasks]]",
			"id = \"hello\"",
			"enabled = true",
			"kind = \"command\"",
			"command = [\"node\", \"--version\"]",
		].join("\n"));
		const appServer = new FakeAppServer();
		const methods = createWorkbenchOverviewMethods({
			workbenchRoot,
			appRequest: async (method, params) => await appServer.request(method, params),
			toybox: {
				transport: "local",
				status: "connected",
				url: "toybox://local",
				server: { name: "test-toybox", version: "0.1.0" },
			},
			now: () => new Date("2026-05-30T12:00:00.000Z"),
		});

		const overview = await methods[WORKBENCH_OVERVIEW_METHOD]!(
			{},
			jsonRpcRequest("overview", WORKBENCH_OVERVIEW_METHOD),
		) as {
			generatedAt: string;
			workbench: { repoRoot: string; config: { exists: boolean } };
			fetch: { package: string; toybox: { status: string } };
			dispatch: { summary: { total: number }; intents: unknown[] };
			threads: { ok: boolean; total: number };
			health: { checks: Array<{ name: string; ok: boolean }> };
		};

		expect(overview.generatedAt).toBe("2026-05-30T12:00:00.000Z");
		expect(overview.workbench.repoRoot).toBe(workbenchRoot);
		expect(overview.workbench.config.exists).toBe(true);
		expect(overview.fetch.package).toBe("codex-toys");
		expect(overview.fetch.toybox.status).toBe("connected");
		expect(overview.dispatch.summary.total).toBe(0);
		expect(overview.dispatch.intents).toEqual([]);
		expect(overview.threads).toMatchObject({ ok: true, total: 0 });
		expect(overview.health.checks.map((check) => check.name)).toContain("workbench-config");
		expect(appServer.requests).toContainEqual({
			method: "thread/list",
			params: expect.objectContaining({ cwd: workbenchRoot, limit: 10 }),
		});
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

function shellResult(
	overrides: Partial<HostOverviewCommandResult> = {},
): HostOverviewCommandResult {
	return {
		code: 0,
		signal: null,
		stdout: "",
		stderr: "",
		...overrides,
	};
}
