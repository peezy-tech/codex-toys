import { describe, expect, test } from "vite-plus/test";
import { formatReport } from "../src/report.ts";
import type { RunResult } from "../src/types.ts";

describe("eval reports", () => {
	test("renders compact markdown with unknown token usage preserved", () => {
		const report = formatReport([
			result("run-a", "passed", 12),
			{ ...result("run-b", "failed", 0), tokenUsage: { status: "unknown" } },
		]);
		expect(report).toContain("Runs: 2");
		expect(report).toContain("Passed: 1");
		expect(report).toContain("| run-b | scenario | profile | failed | unknown |");
	});
});

function result(id: string, status: RunResult["status"], tokens: number): RunResult {
	return {
		id,
		scenarioId: "scenario",
		profileId: "profile",
		status,
		createdAt: "2026-06-07T00:00:00.000Z",
		completedAt: "2026-06-07T00:00:01.000Z",
		elapsedMs: 1000,
		tokenUsage: {
			status: "known",
			total: {
				totalTokens: tokens,
				inputTokens: tokens,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningOutputTokens: 0,
			},
		},
		metrics: {
			commandCount: 0,
			failedCommandCount: 0,
			fileChangeCount: 0,
			toolCallCount: 0,
			userInterventionCount: 0,
		},
		finalText: "",
		oracle: { status: status === "passed" ? "passed" : "failed", checks: [] },
		artifacts: { manifest: "run.json" },
	};
}
