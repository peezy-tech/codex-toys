import { describe, expect, test } from "vite-plus/test";
import { createCodexFlowsBrowserClient } from "../src/browser.ts";

describe("Codex Flows browser client", () => {
	test("calls function endpoints and unwraps responses", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const client = createCodexFlowsBrowserClient({
			basePath: "/bridge",
			fetch: (async (url, init) => {
				calls.push({ url: String(url), init });
				if (String(url) === "/bridge/functions") {
					return jsonResponse({ functions: [{ name: "snapshot", description: "", sideEffects: "read-only" }] });
				}
				if (String(url) === "/bridge/functions/snapshot" && !init) {
					return jsonResponse({ function: { name: "snapshot", description: "", sideEffects: "read-only" } });
				}
				if (String(url) === "/bridge/functions/snapshot" && init?.method === "POST") {
					return jsonResponse({ result: { ok: true } });
				}
				return jsonResponse({ error: "not found" }, 404);
			}) as typeof fetch,
		});

		await expect(client.functions.list()).resolves.toEqual([
			{ name: "snapshot", description: "", sideEffects: "read-only" },
		]);
		await expect(client.functions.describe("snapshot")).resolves.toEqual({
			name: "snapshot",
			description: "",
			sideEffects: "read-only",
		});
		await expect(client.functions.call("snapshot", { include: "cash" })).resolves.toEqual({
			ok: true,
		});
		expect(calls.at(-1)?.init?.body).toBe("{\"params\":{\"include\":\"cash\"}}");
	});

	test("propagates endpoint errors", async () => {
		const client = createCodexFlowsBrowserClient({
			fetch: (async () => jsonResponse({ error: "boom" }, 500)) as typeof fetch,
		});

		await expect(client.functions.list()).rejects.toThrow("boom");
	});
});

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}
