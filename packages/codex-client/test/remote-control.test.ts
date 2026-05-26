import { describe, expect, test } from "vite-plus/test";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import {
	collectRemoteStatusInfo,
	createRemoteTunnelPlan,
	startRemoteTurn,
} from "../src/cli/remote-control.ts";

describe("remote control operator", () => {
	test("plans an SSH tunnel from a local Codex App to a remote backend", () => {
		const plan = createRemoteTunnelPlan({
			sshTarget: "peezy@vps-tailnet",
			localPort: 4596,
			remoteHost: "127.0.0.1",
			remotePort: 3586,
			dryRun: true,
		});
		expect(plan).toMatchObject({
			workspaceUrl: "ws://127.0.0.1:4596",
			command: [
				"ssh",
				"-N",
				"-L",
				"4596:127.0.0.1:3586",
				"peezy@vps-tailnet",
			],
		});
	});

	test("reports no backend as an unavailable but valid status", async () => {
		const workspacePort = await unusedPort();
		const appPort = await unusedPort();
		const info = await collectRemoteStatusInfo({
			workspaceUrl: `ws://127.0.0.1:${workspacePort}`,
			appUrl: `ws://127.0.0.1:${appPort}`,
			timeoutMs: 100,
		});
		expect(info.workspaceBackend.status).toBe("unavailable");
		expect(info.appServer.status).toBe("unavailable");
		expect(info.recommendation.preferred).toBe("none");
	});

	test("probes a workspace backend and starts a turn through it", async () => {
		const server = await startFakeWorkspaceBackend();
		try {
			const info = await collectRemoteStatusInfo({
				workspaceUrl: server.url,
				appUrl: `ws://127.0.0.1:${await unusedPort()}`,
				timeoutMs: 1_000,
			});
			expect(info.workspaceBackend.status).toBe("connected");
			expect(info.workspaceBackend.remoteControl).toMatchObject({
				status: "connected",
				serverName: "fake-vps",
			});
			expect(info.recommendation.preferred).toBe("workspace");

			const turn = await startRemoteTurn({
				prompt: "hello remote",
				cwd: "/srv/workspace",
				via: "workspace",
				workspaceUrl: server.url,
				appUrl: `ws://127.0.0.1:${await unusedPort()}`,
				timeoutMs: 1_000,
				sandbox: "danger-full-access",
				approvalPolicy: "never",
			});
			expect(turn).toMatchObject({
				via: "workspace",
				url: server.url,
				threadId: "thread-1",
				turnId: "turn-1",
			});
			expect(server.methods).toEqual([
				"workspace.initialize",
				"remoteControl/status/read",
				"workspace.initialize",
				"thread/start",
				"turn/start",
			]);
			expect(server.requests.find((request) => request.method === "thread/start"))
				?.toMatchObject({
					params: {
						cwd: "/srv/workspace",
						sandbox: "danger-full-access",
						approvalPolicy: "never",
					},
				});
		} finally {
			await server.close();
		}
	});

	test("rejects incompatible sandbox and permissions turn options", async () => {
		await expect(startRemoteTurn({
			prompt: "hello remote",
			cwd: "/srv/workspace",
			via: "workspace",
			workspaceUrl: `ws://127.0.0.1:${await unusedPort()}`,
			appUrl: `ws://127.0.0.1:${await unusedPort()}`,
			timeoutMs: 100,
			sandbox: "danger-full-access",
			permissions: "trusted",
		})).rejects.toThrow("--sandbox cannot be combined with --permissions");
	});
});

async function startFakeWorkspaceBackend(): Promise<{
	url: string;
	methods: string[];
	requests: Array<{ method: string; params: unknown }>;
	close(): Promise<void>;
}> {
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise<void>((resolve) => wss.once("listening", resolve));
	const address = wss.address() as AddressInfo;
	const methods: string[] = [];
	const requests: Array<{ method: string; params: unknown }> = [];

	wss.on("connection", (socket) => {
		socket.on("message", (data) => {
			const message = JSON.parse(data.toString()) as Record<string, unknown>;
			const method = String(message.method);
			const appMethod = method === "appServer.call"
				? String(record(message.params).method)
				: method;
			methods.push(appMethod);
			requests.push({
				method: appMethod,
				params: method === "appServer.call"
					? record(message.params).params
					: message.params,
			});
			socket.send(JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: fakeResult(method, message.params),
			}));
		});
	});

	return {
		url: `ws://127.0.0.1:${address.port}`,
		methods,
		requests,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				wss.close((error) => error ? reject(error) : resolve());
			});
		},
	};
}

function fakeResult(method: string, params: unknown): unknown {
	if (method === "workspace.initialize") {
		return {
			ok: true,
			serverInfo: { name: "fake-workspace-backend", version: "0.1.0" },
			capabilities: {
				appServerPassThrough: true,
				workspaceMethods: [],
			},
		};
	}
	if (method === "appServer.call") {
		const appMethod = String(record(params).method);
		if (appMethod === "remoteControl/status/read") {
			return {
				status: "connected",
				serverName: "fake-vps",
				installationId: "install-1",
				environmentId: null,
			};
		}
		if (appMethod === "thread/start") {
			return { thread: { id: "thread-1" } };
		}
		if (appMethod === "turn/start") {
			return { turn: { id: "turn-1" } };
		}
	}
	return {};
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	});
	return port;
}
