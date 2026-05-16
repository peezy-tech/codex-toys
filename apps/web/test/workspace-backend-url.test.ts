import { describe, expect, test } from "bun:test";

import {
	workspaceBackendStorageKey,
	initialWorkspaceBackendWsUrl,
	proxiedWorkspaceBackendWsUrl,
} from "../src/workspace-backend-url.ts";

describe("workspace backend URLs", () => {
	test("uses the proxied workspace backend path on http origins", () => {
		expect(proxiedWorkspaceBackendWsUrl({ protocol: "http:", host: "localhost:5173" }))
			.toBe("ws://localhost:5173/__codex-workspace-backend");
	});

	test("uses wss for https origins", () => {
		expect(proxiedWorkspaceBackendWsUrl({ protocol: "https:", host: "flows.peezy.tech" }))
			.toBe("wss://flows.peezy.tech/__codex-workspace-backend");
	});

	test("prefers stored workspace backend URLs over env defaults", () => {
		const values = new Map<string, string>([
			[workspaceBackendStorageKey, "ws://127.0.0.1:4599"],
		]);
		expect(
			initialWorkspaceBackendWsUrl({
				envUrl: "ws://127.0.0.1:3586",
				location: { protocol: "http:", host: "localhost:5173" },
				storage: { getItem: (key) => values.get(key) ?? null },
			}),
		).toBe("ws://127.0.0.1:4599");
	});

	test("uses env defaults before deriving the proxied URL", () => {
		expect(
			initialWorkspaceBackendWsUrl({
				envUrl: "ws://127.0.0.1:3586",
				location: { protocol: "http:", host: "localhost:5173" },
			}),
		).toBe("ws://127.0.0.1:3586");
	});
});
