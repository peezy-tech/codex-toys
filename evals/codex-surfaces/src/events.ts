import type { NormalizedEvent, TokenUsageBreakdown, TokenUsageSummary } from "./types.ts";
import { array, optionalNumber, optionalString, record } from "./util.ts";

export function normalizeRawEvents(rawEvents: unknown[]): NormalizedEvent[] {
	return rawEvents.flatMap((event) => normalizeRawEvent(event));
}

export function normalizeRawEvent(raw: unknown): NormalizedEvent[] {
	const input = record(raw);
	if (optionalString(input.method)) {
		return normalizeJsonRpcNotification(input, raw);
	}
	if (optionalString(input.type)) {
		return normalizeTypedEvent(input, raw);
	}
	if (input.item) {
		return normalizeThreadItem(record(input.item), raw);
	}
	return [{ type: "raw", at: eventTime(input), raw }];
}

export function aggregateTokenUsage(events: NormalizedEvent[]): TokenUsageSummary {
	const latest = [...events].reverse().find((event) => event.type === "token.usage");
	return latest?.type === "token.usage"
		? { status: "known", total: latest.usage }
		: { status: "unknown" };
}

export function finalTextFromEvents(events: NormalizedEvent[]): string {
	return events
		.filter((event): event is Extract<NormalizedEvent, { type: "agent.final" }> => event.type === "agent.final")
		.map((event) => event.text.trim())
		.filter(Boolean)
		.join("\n\n");
}

export function runMetrics(events: NormalizedEvent[]): {
	commandCount: number;
	failedCommandCount: number;
	fileChangeCount: number;
	toolCallCount: number;
	userInterventionCount: number;
} {
	const commands = events.filter((event) => event.type === "command");
	return {
		commandCount: commands.length,
		failedCommandCount: commands.filter((event) =>
			(event.exitCode !== null && event.exitCode !== undefined && event.exitCode !== 0) ||
			event.status === "failed"
		).length,
		fileChangeCount: events.filter((event) => event.type === "file.change").length,
		toolCallCount: events.filter((event) => event.type === "tool.call").length,
		userInterventionCount: events.filter((event) => event.type === "user.intervention").length,
	};
}

function normalizeJsonRpcNotification(input: Record<string, unknown>, raw: unknown): NormalizedEvent[] {
	const method = optionalString(input.method);
	const params = record(input.params);
	if (method === "thread/started") {
		const thread = record(params.thread);
		const threadId = optionalString(params.threadId) ?? optionalString(thread.id);
		return threadId ? [{ type: "thread.started", at: eventTime(params), threadId, method, raw }] : rawEvent(method, raw);
	}
	if (method === "turn/started") {
		const turn = record(params.turn);
		return [{
			type: "turn.started",
			at: eventTime(params),
			threadId: optionalString(params.threadId),
			turnId: optionalString(params.turnId) ?? optionalString(turn.id),
			method,
			raw,
		}];
	}
	if (method === "turn/completed") {
		const turn = record(params.turn);
		return [
			...normalizeTurnItems(array(turn.items), raw),
			{
				type: "turn.completed",
				at: eventTime(params),
				threadId: optionalString(params.threadId),
				turnId: optionalString(params.turnId) ?? optionalString(turn.id),
				status: optionalString(turn.status),
				durationMs: optionalNumber(turn.durationMs),
				method,
				raw,
			},
		];
	}
	if (method === "thread/tokenUsage/updated") {
		const usage = tokenUsageFromValue(record(params.tokenUsage).total);
		return usage ? [{
			type: "token.usage",
			at: eventTime(params),
			threadId: optionalString(params.threadId),
			turnId: optionalString(params.turnId),
			usage,
			method,
			raw,
		}] : rawEvent(method, raw);
	}
	if (method === "item/completed" || method === "item/started") {
		return normalizeThreadItem(record(params.item), raw);
	}
	if (method === "serverRequest/resolved" || method?.includes("approval")) {
		return [{ type: "user.intervention", at: eventTime(params), label: method, raw }];
	}
	if (method === "error") {
		return [{ type: "error", at: eventTime(params), message: errorText(params), raw }];
	}
	return rawEvent(method, raw);
}

function normalizeTypedEvent(input: Record<string, unknown>, raw: unknown): NormalizedEvent[] {
	const type = optionalString(input.type);
	if (type === "thread.started") {
		const threadId = optionalString(input.thread_id) ?? optionalString(input.threadId);
		return threadId ? [{ type: "thread.started", at: eventTime(input), threadId, raw }] : [{ type: "raw", at: eventTime(input), raw }];
	}
	if (type === "turn.started") {
		return [{ type: "turn.started", at: eventTime(input), threadId: optionalString(input.threadId), turnId: optionalString(input.turnId), raw }];
	}
	if (type === "turn.completed") {
		const usage = tokenUsageFromValue(input.usage);
		const completed: NormalizedEvent = {
			type: "turn.completed",
			at: eventTime(input),
			threadId: optionalString(input.threadId),
			turnId: optionalString(input.turnId),
			status: optionalString(input.status) ?? "completed",
			raw,
		};
		return usage ? [{ type: "token.usage", at: eventTime(input), usage, raw }, completed] : [completed];
	}
	if (type?.startsWith("item.")) {
		return normalizeThreadItem(record(input.item), raw);
	}
	if (type === "error") {
		return [{ type: "error", at: eventTime(input), message: errorText(input), raw }];
	}
	return [{ type: "raw", at: eventTime(input), raw }];
}

function normalizeTurnItems(items: unknown[], raw: unknown): NormalizedEvent[] {
	return items.flatMap((item) => normalizeThreadItem(record(item), raw));
}

function normalizeThreadItem(item: Record<string, unknown>, raw: unknown): NormalizedEvent[] {
	const type = optionalString(item.type);
	if (type === "agentMessage") {
		const phase = optionalString(item.phase);
		const text = optionalString(item.text);
		return text && (phase === "final_answer" || phase === "final" || phase === null || phase === undefined)
			? [{ type: "agent.final", text, raw }]
			: [];
	}
	if (type === "commandExecution") {
		return [{
			type: "command",
			command: optionalString(item.command) ?? "",
			status: optionalString(item.status),
			exitCode: optionalNumber(item.exitCode) ?? null,
			durationMs: optionalNumber(item.durationMs) ?? null,
			raw,
		}];
	}
	if (type === "fileChange") {
		return [{
			type: "file.change",
			status: optionalString(item.status),
			paths: array(item.changes).map((change) => optionalString(record(change).path)).filter((entry): entry is string => Boolean(entry)),
			raw,
		}];
	}
	if (type === "mcpToolCall") {
		return [{ type: "tool.call", tool: optionalString(item.tool) ?? "mcp", status: optionalString(item.status), raw }];
	}
	if (type === "dynamicToolCall") {
		return [{
			type: "tool.call",
			namespace: optionalString(item.namespace) ?? null,
			tool: optionalString(item.tool) ?? "dynamic",
			status: optionalString(item.status),
			raw,
		}];
	}
	return [];
}

function tokenUsageFromValue(value: unknown): TokenUsageBreakdown | undefined {
	const input = record(value);
	const totalTokens = numberField(input, "totalTokens", "total_tokens");
	const inputTokens = numberField(input, "inputTokens", "input_tokens");
	const cachedInputTokens = numberField(input, "cachedInputTokens", "cached_input_tokens");
	const outputTokens = numberField(input, "outputTokens", "output_tokens");
	const reasoningOutputTokens = numberField(input, "reasoningOutputTokens", "reasoning_output_tokens");
	return totalTokens === undefined ||
		inputTokens === undefined ||
		cachedInputTokens === undefined ||
		outputTokens === undefined ||
		reasoningOutputTokens === undefined
		? undefined
		: { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens };
}

function numberField(input: Record<string, unknown>, camel: string, snake: string): number | undefined {
	return optionalNumber(input[camel]) ?? optionalNumber(input[snake]);
}

function eventTime(input: Record<string, unknown>): string | undefined {
	return optionalString(input.at) ?? optionalString(input.timestamp) ?? optionalString(input.createdAt);
}

function errorText(input: Record<string, unknown>): string {
	return optionalString(input.message) ?? optionalString(record(input.error).message) ?? JSON.stringify(input);
}

function rawEvent(method: string | undefined, raw: unknown): NormalizedEvent[] {
	return [{ type: "raw", method, raw }];
}
