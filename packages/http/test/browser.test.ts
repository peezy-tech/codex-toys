import { describe, expect, test } from "vite-plus/test";
import { createAgentHarnessBrowserClient } from "@codex-appkit/http/browser";

describe("Agent Harness browser client", () => {
	test("starts a provider-selected run", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const client = createAgentHarnessBrowserClient({
			basePath: "/bridge",
			fetch: (async (url, init) => {
				calls.push({ url: String(url), init });
				return jsonResponse({ id: "run-1", provider: "claude", sessionId: "session-1", runId: null }, 201);
			}) as typeof fetch,
		});

		await expect(client.run({ provider: "claude", prompt: "inspect", model: "sonnet" })).resolves.toEqual({
			id: "run-1", provider: "claude", sessionId: "session-1", runId: null,
		});
		expect(calls.at(-1)).toEqual(expect.objectContaining({
			url: "/bridge/runs",
			init: expect.objectContaining({ body: "{\"provider\":\"claude\",\"prompt\":\"inspect\",\"model\":\"sonnet\"}" }),
		}));
	});

	test("propagates endpoint errors", async () => {
		const client = createAgentHarnessBrowserClient({
			fetch: (async () => jsonResponse({ error: "boom" }, 500)) as typeof fetch,
		});

		await expect(client.status()).rejects.toThrow("boom");
	});
});

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}
