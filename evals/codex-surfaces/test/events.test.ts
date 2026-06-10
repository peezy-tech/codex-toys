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

	test("normalizes native rollout records", () => {
		const events = normalizeRawEvents([
			{
				timestamp: "2026-06-10T00:00:00.000Z",
				type: "session_meta",
				payload: { id: "thread-1" },
			},
			{
				timestamp: "2026-06-10T00:00:01.000Z",
				type: "event_msg",
				payload: { type: "task_started", turn_id: "turn-1" },
			},
			{
				timestamp: "2026-06-10T00:00:02.000Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "assistant",
					phase: "final_answer",
					content: [{ type: "output_text", text: "native final" }],
				},
			},
			{
				timestamp: "2026-06-10T00:00:03.000Z",
				type: "event_msg",
				payload: {
					type: "token_count",
					info: {
						total_token_usage: {
							total_tokens: 20,
							input_tokens: 12,
							cached_input_tokens: 3,
							output_tokens: 8,
							reasoning_output_tokens: 1,
						},
					},
				},
			},
			{
				timestamp: "2026-06-10T00:00:04.000Z",
				type: "event_msg",
				payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "native final", duration_ms: 50 },
			},
		]);
		expect(events.map((event) => event.type)).toEqual([
			"thread.started",
			"turn.started",
			"agent.final",
			"token.usage",
			"agent.final",
			"turn.completed",
		]);
		expect(finalTextFromEvents(events)).toBe("native final");
		expect(aggregateTokenUsage(events)).toMatchObject({
			status: "known",
			total: { totalTokens: 20 },
		});
	});
});
