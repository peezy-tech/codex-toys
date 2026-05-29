import { describe, expect, test } from "vite-plus/test";
import { createServer } from "vite";
import { CodexEventEmitter } from "../src/app-server/events.ts";
import type { CodexWorkspaceBackendTransport } from "../src/workspace-backend/client.ts";
import { codexFlowsRemote } from "../src/vite.ts";

describe("codexFlowsRemote Vite plugin", () => {
	test("serves local bridge endpoints and forwards function calls", async () => {
		const transport = new FakeWorkspaceTransport();
		const server = await createServer({
			configFile: false,
			logLevel: "silent",
			server: {
				host: "127.0.0.1",
				port: 0,
			},
			plugins: [codexFlowsRemote({ transport })],
		});
		try {
			await server.listen();
			const baseUrl = serverBaseUrl(server);

			const status = await fetchJson(`${baseUrl}/__codex_flows/api/status`);
			expect(status).toMatchObject({ ok: true, agent: { ok: true, cwd: "/remote" } });

			const schema = await fetchJson(`${baseUrl}/__codex_flows/api/schema`);
			expect(schema).toMatchObject({
				capabilities: {
					workspaceMethods: ["agent.status", "functions.list", "functions.describe", "functions.call"],
				},
			});

			const functions = await fetchJson(`${baseUrl}/__codex_flows/api/workspace/functions.list`, {
				method: "POST",
			});
			expect(functions).toEqual({
				functions: [{ name: "snapshot", description: "Read snapshot.", sideEffects: "read-only" }],
			});

			const described = await fetchJson(`${baseUrl}/__codex_flows/api/workspace/functions.describe`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "snapshot" }),
			});
			expect(described).toEqual({
				function: { name: "snapshot", description: "Read snapshot.", sideEffects: "read-only" },
			});

			const called = await fetchJson(`${baseUrl}/__codex_flows/api/workspace/functions.call`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "snapshot", params: { id: "one" } }),
			});
			expect(called).toEqual({ result: { id: "one", ok: true } });
			expect(transport.requests.map((request) => request.method)).toEqual([
				"workspace.initialize",
				"agent.status",
				"functions.list",
				"functions.describe",
				"functions.call",
			]);
		} finally {
			await server.close();
		}
	});
});

class FakeWorkspaceTransport extends CodexEventEmitter implements CodexWorkspaceBackendTransport {
	readonly requestTimeoutMs = 1_000;
	requests: Array<{ method: string; params?: unknown }> = [];

	start(): void {}

	close(): void {}

	notify(): void {}

	async request<T = unknown>(method: string, params?: unknown): Promise<T> {
		this.requests.push({ method, params });
		if (method === "workspace.initialize") {
			return {
				ok: true,
				serverInfo: { name: "fake", version: "0.1.0" },
				capabilities: {
					appServerPassThrough: true,
					workspaceMethods: ["agent.status", "functions.list", "functions.describe", "functions.call"],
					workspaceMethodMetadata: [],
				},
			} as T;
		}
		if (method === "agent.status") {
			return { ok: true, cwd: "/remote" } as T;
		}
		if (method === "functions.list") {
			return {
				functions: [{ name: "snapshot", description: "Read snapshot.", sideEffects: "read-only" }],
			} as T;
		}
		if (method === "functions.describe") {
			return {
				function: { name: "snapshot", description: "Read snapshot.", sideEffects: "read-only" },
			} as T;
		}
		if (method === "functions.call") {
			const input = params as { params?: { id?: string } };
			return { result: { id: input.params?.id, ok: true } } as T;
		}
		throw new Error(`Unexpected request: ${method}`);
	}
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	expect(response.ok).toBe(true);
	return await response.json() as unknown;
}

function serverBaseUrl(server: Awaited<ReturnType<typeof createServer>>): string {
	const address = server.httpServer?.address();
	if (!address || typeof address === "string") {
		throw new Error("Vite server is not listening on a TCP port");
	}
	return `http://127.0.0.1:${address.port}`;
}
