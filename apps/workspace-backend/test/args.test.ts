import { describe, expect, test } from "vite-plus/test";

import { parseArgs } from "../src/args.ts";

describe("parseArgs", () => {
	test("defaults to serving the local workspace backend port", () => {
		expect(parseArgs([], {})).toMatchObject({
			type: "serve",
			hostname: "127.0.0.1",
			port: 3586,
			appServerUrl: undefined,
			localAppServer: false,
		});
	});

	test("accepts host, port, and app-server URL flags", () => {
		expect(
			parseArgs([
				"serve",
				"--host",
				"0.0.0.0",
				"--port=4599",
				"--app-server-url",
				"ws://127.0.0.1:3585",
			], {}),
		).toMatchObject({
			type: "serve",
			hostname: "0.0.0.0",
			port: 4599,
			appServerUrl: "ws://127.0.0.1:3585",
			localAppServer: false,
		});
	});

	test("rejects local stdio and explicit WebSocket app-server together", () => {
		expect(() =>
			parseArgs([
				"serve",
				"--local-app-server",
				"--app-server-url",
				"ws://127.0.0.1:3585",
			], {}),
		).toThrow("Cannot set both --local-app-server and --app-server-url.");
	});

	test("reads environment overrides", () => {
		expect(
			parseArgs([], {
				CODEX_WORKSPACE_BACKEND_HOST: "0.0.0.0",
				CODEX_WORKSPACE_BACKEND_PORT: "4599",
				CODEX_WORKSPACE_BACKEND_LOCAL_APP_SERVER: "yes",
			}),
		).toMatchObject({
			type: "serve",
			hostname: "0.0.0.0",
			port: 4599,
			appServerUrl: undefined,
			localAppServer: true,
		});
	});
});
