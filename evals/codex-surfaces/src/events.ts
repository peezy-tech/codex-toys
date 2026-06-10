import type { NormalizedEvent, TokenUsageBreakdown, TokenUsageSummary } from "./types.ts";
import { array, optionalNumber, optionalString, record } from "./util.ts";

export function normalizeRawEvents(rawEvents: unknown[]): NormalizedEvent[] {
	return rawEvents.flatMap((event) => normalizeRawEvent(event));
}

export function normalizeRawEvent(raw: unknown): NormalizedEvent[] {
	const input = record(raw);
	if (optionalString(input.type) === "session_meta") {
		return normalizeRolloutSessionMeta(input, raw);
	}
	if (optionalString(input.type) === "turn_context") {
		return [{ type: "raw", at: eventTime(input), raw }];
	}
	if (optionalString(input.type) === "event_msg") {
		return normalizeRolloutEventMessage(input, raw);
	}
	if (optionalString(input.type) === "response_item") {
		return normalizeRolloutResponseItem(input, raw);
	}
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

function normalizeRolloutSessionMeta(input: Record<string, unknown>, raw: unknown): NormalizedEvent[] {
	const payload = record(input.payload);
	const threadId = optionalString(payload.id);
	return threadId ? [{
		type: "thread.started",
		at: eventTime(input) ?? optionalString(payload.timestamp),
		threadId,
		raw,
	}] : [{ type: "raw", at: eventTime(input), raw }];
}

function normalizeRolloutEventMessage(input: Record<string, unknown>, raw: unknown): NormalizedEvent[] {
	const payload = record(input.payload);
	const payloadType = optionalString(payload.type);
	if (payloadType === "task_started") {
		return [{
			type: "turn.started",
			at: eventTime(input) ?? optionalString(payload.started_at),
			turnId: optionalString(payload.turn_id),
			raw,
		}];
	}
	if (payloadType === "task_complete") {
		const finalText = optionalString(payload.last_agent_message);
		const completed: NormalizedEvent = {
			type: "turn.completed",
			at: eventTime(input) ?? optionalString(payload.completed_at),
			turnId: optionalString(payload.turn_id),
			status: "completed",
			durationMs: optionalNumber(payload.duration_ms),
			raw,
		};
		return finalText ? [{ type: "agent.final", at: completed.at, text: finalText, raw }, completed] : [completed];
	}
	if (payloadType === "agent_message") {
		const phase = optionalString(payload.phase);
		const text = optionalString(payload.message);
		return text && (phase === "final_answer" || phase === "final")
			? [{ type: "agent.final", at: eventTime(input), text, raw }]
			: [];
	}
	if (payloadType === "token_count") {
		const usage = tokenUsageFromValue(record(record(payload.info).total_token_usage));
		return usage ? [{
			type: "token.usage",
			at: eventTime(input),
			usage,
			raw,
		}] : [{ type: "raw", at: eventTime(input), raw }];
	}
	if (payloadType === "web_search_end") {
		return [{
			type: "tool.call",
			at: eventTime(input),
			namespace: "web",
			tool: "web_search",
			status: "completed",
			raw,
		}];
	}
	if (payloadType === "exec_command_begin") {
		return [{
			type: "command",
			at: eventTime(input),
			command: optionalString(payload.command) ?? optionalString(payload.cmd) ?? "",
			status: "in_progress",
			raw,
		}];
	}
	if (payloadType === "exec_command_end") {
		return [{
			type: "command",
			at: eventTime(input),
			command: optionalString(payload.command) ?? optionalString(payload.cmd) ?? "",
			status: optionalString(payload.status) ?? "completed",
			exitCode: optionalNumber(payload.exit_code) ?? optionalNumber(payload.exitCode) ?? null,
			durationMs: optionalNumber(payload.duration_ms) ?? optionalNumber(payload.durationMs) ?? null,
			raw,
		}];
	}
	return [{ type: "raw", at: eventTime(input), raw }];
}

function normalizeRolloutResponseItem(input: Record<string, unknown>, raw: unknown): NormalizedEvent[] {
	const payload = record(input.payload);
	const payloadType = optionalString(payload.type);
	if (payloadType === "message" && optionalString(payload.role) === "assistant") {
		const phase = optionalString(payload.phase);
		const text = rolloutMessageText(payload);
		return text && (phase === "final_answer" || phase === "final")
			? [{ type: "agent.final", at: eventTime(input), text, raw }]
			: [];
	}
	if (payloadType === "web_search_call") {
		return [{
			type: "tool.call",
			at: eventTime(input),
			namespace: "web",
			tool: "web_search",
			status: optionalString(payload.status),
			raw,
		}];
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
	const texts = events
		.filter((event): event is Extract<NormalizedEvent, { type: "agent.final" }> => event.type === "agent.final")
		.map((event) => event.text.trim())
		.filter(Boolean);
	return [...new Set(texts)].join("\n\n");
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

function rolloutMessageText(payload: Record<string, unknown>): string {
	return array(payload.content)
		.map((entry) => optionalString(record(entry).text))
		.filter((entry): entry is string => Boolean(entry))
		.join("\n\n");
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
