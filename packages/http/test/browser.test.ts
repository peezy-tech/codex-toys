import { describe, expect, test } from "vite-plus/test";
import { createCodexAppkitBrowserClient } from "@codex-appkit/http/browser";

describe("Codex AppKit browser client", () => {
	test("calls app endpoints", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const client = createCodexAppkitBrowserClient({
			basePath: "/bridge",
			fetch: (async (url, init) => {
				calls.push({ url: String(url), init });
				if (String(url) === "/bridge/app/thread%2Flist") {
					return jsonResponse({ threads: [] });
				}
				return jsonResponse({ error: "not found" }, 404);
			}) as typeof fetch,
		});

		await expect(client.app.call("thread/list", { limit: 20 })).resolves.toEqual({
			threads: [],
		});
		expect(calls.at(-1)?.init?.body).toBe("{\"limit\":20}");
	});

	test("propagates endpoint errors", async () => {
		const client = createCodexAppkitBrowserClient({
			fetch: (async () => jsonResponse({ error: "boom" }, 500)) as typeof fetch,
		});

		await expect(client.status()).rejects.toThrow("boom");
	});

	test("calls the local Claude session endpoints", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const client = createCodexAppkitBrowserClient({
			basePath: "/bridge",
			fetch: (async (url, init) => {
				calls.push({ url: String(url), init });
				return jsonResponse({ sessionId: "session-1" });
			}) as typeof fetch,
		});

		await expect(client.claude.start({ cwd: "/workspace" })).resolves.toEqual({
			sessionId: "session-1",
		});
		expect(calls.at(-1)).toEqual(expect.objectContaining({
			url: "/bridge/claude/sessions",
			init: expect.objectContaining({ body: "{\"cwd\":\"/workspace\"}" }),
		}));
	});
});

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}
