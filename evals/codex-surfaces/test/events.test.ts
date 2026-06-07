import { describe, expect, test } from "vite-plus/test";
import { aggregateTokenUsage, finalTextFromEvents, normalizeRawEvents, runMetrics } from "../src/events.ts";

describe("event normalization", () => {
	test("extracts token usage, final text, commands, files, and tools", () => {
		const events = normalizeRawEvents([
			{
				method: "thread/tokenUsage/updated",
				params: {
					threadId: "thread-1",
					turnId: "turn-1",
					tokenUsage: {
						total: {
							totalTokens: 15,
							inputTokens: 10,
							cachedInputTokens: 4,
							outputTokens: 5,
							reasoningOutputTokens: 2,
						},
					},
				},
			},
			{
				method: "turn/completed",
				params: {
					threadId: "thread-1",
					turn: {
						id: "turn-1",
						status: "completed",
						durationMs: 1200,
						items: [
							{ type: "agentMessage", phase: "final_answer", text: "done" },
							{ type: "commandExecution", command: "codex-toys workbench doctor --json", status: "completed", exitCode: 0, durationMs: 20 },
							{ type: "fileChange", status: "completed", changes: [{ path: "README.md" }] },
							{ type: "mcpToolCall", tool: "read", status: "completed" },
						],
					},
				},
			},
		]);
		expect(aggregateTokenUsage(events)).toEqual({
			status: "known",
			total: {
				totalTokens: 15,
				inputTokens: 10,
				cachedInputTokens: 4,
				outputTokens: 5,
				reasoningOutputTokens: 2,
			},
		});
		expect(finalTextFromEvents(events)).toBe("done");
		expect(runMetrics(events)).toMatchObject({
			commandCount: 1,
			failedCommandCount: 0,
			fileChangeCount: 1,
			toolCallCount: 1,
		});
	});

	test("keeps token usage unknown when no usage event exists", () => {
		const events = normalizeRawEvents([{ type: "turn.completed", status: "completed" }]);
		expect(aggregateTokenUsage(events)).toEqual({ status: "unknown" });
	});
});
