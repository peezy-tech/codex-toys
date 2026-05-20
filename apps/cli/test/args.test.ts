import { expect, test } from "vite-plus/test";

import { parseArgs } from "../src/args.ts";

test("parses a direct action call with params JSON", () => {
	expect(parseArgs(["thread/list", "{\"limit\":10}"], {})).toEqual({
		type: "call",
		action: "thread/list",
		paramsText: "{\"limit\":10}",
		url: "ws://127.0.0.1:3585",
		timeoutMs: 90_000,
		pretty: true,
	});
});

test("parses call alias, url, timeout, and compact output", () => {
	expect(
		parseArgs(
			[
				"--url",
				"ws://localhost:4000",
				"--timeout-ms=1234",
				"--compact",
				"call",
				"account/read",
			],
			{},
		),
	).toEqual({
		type: "call",
		action: "account/read",
		paramsText: undefined,
		url: "ws://localhost:4000",
		timeoutMs: 1234,
		pretty: false,
	});
});

test("uses environment URL default", () => {
	const parsed = parseArgs(["account/read"], {
		CODEX_WORKSPACE_APP_SERVER_WS_URL: "ws://127.0.0.1:9999",
	});
	expect(parsed).toMatchObject({
		type: "call",
		url: "ws://127.0.0.1:9999",
	});
});

test("parses code mode extraction command", () => {
	expect(parseArgs(["extract-code-mode", "--output-dir", ".tmp/candidates"], {})).toEqual({
		type: "extract-code-mode",
		outputDir: ".tmp/candidates",
	});
});

test("parses code mode tool input extraction command", () => {
	expect(parseArgs(["extract-code-mode-tool-input", "--output-dir", ".tmp/candidates"], {})).toEqual({
		type: "extract-code-mode-tool-input",
		outputDir: ".tmp/candidates",
	});
});

test("parses code mode runner command", () => {
	expect(
		parseArgs(
			[
				"--url=ws://localhost:4000",
				"--timeout-ms",
				"5000",
				"run-code-mode",
				".codex/code-mode-candidates/demo.mjs",
				"--cwd",
				"/tmp/demo",
			],
			{},
		),
	).toEqual({
		type: "run-code-mode",
		file: ".codex/code-mode-candidates/demo.mjs",
		cwd: "/tmp/demo",
		codexCommand: undefined,
		url: "ws://localhost:4000",
		timeoutMs: 5000,
		pretty: true,
	});
});

test("parses code mode runner stdio transport command", () => {
	expect(
		parseArgs(
			[
				"--url=stdio://",
				"--codex-command",
				"/tmp/codex",
				"run-code-mode",
				".codex/code-mode-candidates/demo.mjs",
			],
			{},
		),
	).toEqual({
		type: "run-code-mode",
		file: ".codex/code-mode-candidates/demo.mjs",
		cwd: undefined,
		codexCommand: "/tmp/codex",
		url: "stdio://",
		timeoutMs: 90_000,
		pretty: true,
	});
});

test("uses environment Codex command for stdio runner", () => {
	expect(
		parseArgs(["--url=stdio://", "run-code-mode", "demo.mjs"], {
			CODEX_APP_SERVER_CODEX_COMMAND: "/tmp/forked-codex",
		}),
	).toMatchObject({
		type: "run-code-mode",
		codexCommand: "/tmp/forked-codex",
	});
});

test("rejects unknown actions before connecting", () => {
	expect(() => parseArgs(["not-a-method"], {})).toThrow("Unknown action");
});

test("completion command is not supported", () => {
	expect(() => parseArgs(["completion", "zsh"], {})).toThrow("Unknown action");
});
