import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { evaluateOracles } from "../src/oracle.ts";

describe("deterministic oracles", () => {
	test("checks final text, event types, commands, files, and json fields", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "codex-surface-oracle-"));
		await writeFile(path.join(dir, "state.json"), JSON.stringify({ queue: { status: "empty" } }));
		const result = await evaluateOracles([
			{ type: "finalTextIncludes", text: "workbench dispatch run-due" },
			{ type: "eventTypeSeen", eventType: "command" },
			{ type: "commandSeen", pattern: "dispatch run-due" },
			{ type: "fileExists", path: "state.json" },
			{ type: "jsonPathEquals", file: "state.json", path: "queue.status", equals: "empty" },
		], {
			cwd: dir,
			finalText: "Use workbench dispatch run-due from systemd.",
			events: [{ type: "command", command: "codex-toys workbench dispatch run-due", raw: {} }],
		});
		expect(result.status).toBe("passed");
		expect(result.checks.every((check) => check.passed)).toBe(true);
	});
});
