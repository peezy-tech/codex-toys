import type { v2 } from "./app-server/generated/index.ts";
import type { ServerNotification } from "./app-server/generated/index.ts";
import type { JsonRpcNotification } from "./app-server/rpc.ts";

export type WorkbenchTurnStatus =
	| "idle"
	| "inProgress"
	| "completed"
	| "failed"
	| "interrupted";

export type WorkbenchPlanStep = {
	step: string;
	status: "pending" | "inProgress" | "completed";
};

export type WorkbenchGoalSummary = {
	threadId: string;
	objective: string;
	status: v2.ThreadGoalStatus;
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
};

export type WorkbenchRunningCommand = {
	itemId: string;
	turnId: string;
	command: string;
	status: "inProgress";
	startedAt: string;
	lastOutputAt?: string;
};

export type WorkbenchActivity = {
	itemId: string;
	turnId: string;
	kind: string;
	label: string;
	status: "inProgress" | "completed" | "failed" | "declined";
	updatedAt: string;
};

export type WorkbenchProgressKind = "summary" | "commentary" | "final";
export type WorkbenchProgressMode = "summary" | "commentary" | "none";

export type WorkbenchProgressMessage = {
	id: string;
	kind: WorkbenchProgressKind;
	threadId: string;
	turnId: string;
	itemId?: string;
	summaryIndex?: number;
	text: string;
	ready: boolean;
	deliveredAt?: string;
};

export type WorkbenchProgressState = {
	summaryBuffers: Array<{
		threadId: string;
		turnId: string;
		itemId: string;
		summaryIndex: number;
		text: string;
	}>;
	agentMessageBuffers: Array<{
		threadId: string;
		turnId: string;
		itemId: string;
		text: string;
	}>;
	messages: WorkbenchProgressMessage[];
	finalAnswer?: WorkbenchProgressMessage;
};

export type WorkbenchThreadSnapshot = {
	threadId: string;
	activeTurnId?: string;
	turnStatus: WorkbenchTurnStatus;
	goal?: WorkbenchGoalSummary;
	plan: {
		explanation?: string;
		steps: WorkbenchPlanStep[];
		text: string;
		updatedAt?: string;
	};
	runningCommands: WorkbenchRunningCommand[];
	recentActivity: WorkbenchActivity[];
	progress: WorkbenchProgressState;
	updatedAt: string;
};

export type WorkbenchReducerOptions = {
	now?: Date | (() => Date);
	maxActivity?: number;
};

export type AppServerRequestDescriptor<TParams = unknown> = {
	method: string;
	params: TParams;
};

export function createThreadSnapshot(
	threadId: string,
	options: WorkbenchReducerOptions = {},
): WorkbenchThreadSnapshot {
	return {
		threadId,
		turnStatus: "idle",
		plan: {
			steps: [],
			text: "",
		},
		runningCommands: [],
		recentActivity: [],
		progress: {
			summaryBuffers: [],
			agentMessageBuffers: [],
			messages: [],
		},
		updatedAt: nowIso(options),
	};
}

export function snapshotFromThread(
	thread: v2.Thread,
	options: WorkbenchReducerOptions = {},
): WorkbenchThreadSnapshot {
	let snapshot = createThreadSnapshot(thread.id, options);
	for (const turn of thread.turns) {
		if (turn.status === "inProgress") {
			snapshot = {
				...snapshot,
				activeTurnId: turn.id,
				turnStatus: "inProgress",
				updatedAt: nowIso(options),
			};
			for (const item of turn.items) {
				snapshot = applyThreadItem(snapshot, turn.id, item, "inProgress", options);
			}
			continue;
		}
		snapshot = reduceCompletedTurn(snapshot, thread.id, turn, options);
	}
	return snapshot;
}

export function reduceThreadNotification(
	snapshot: WorkbenchThreadSnapshot,
	notification: JsonRpcNotification | ServerNotification,
	options: WorkbenchReducerOptions = {},
): WorkbenchThreadSnapshot {
	const params = record(notification.params);
	const threadId = stringValue(params.threadId);
	if (threadId && threadId !== snapshot.threadId) {
		return snapshot;
	}

	if (notification.method === "thread/goal/updated") {
		const goal = goalSummary(record(params.goal));
		return touch({
			...cloneSnapshot(snapshot),
			...(goal ? { goal } : {}),
		}, options);
	}

	if (notification.method === "thread/goal/cleared") {
		const next = cloneSnapshot(snapshot);
		next.goal = undefined;
		return touch(next, options);
	}

	const turnId = stringValue(params.turnId) ?? stringValue(record(params.turn).id);
	if (!turnId) {
		return snapshot;
	}

	if (notification.method === "turn/started") {
		return touch({
			...cloneSnapshot(snapshot),
			activeTurnId: turnId,
			turnStatus: "inProgress",
		}, options);
	}

	if (notification.method === "turn/plan/updated") {
		const next = cloneSnapshot(snapshot);
		next.activeTurnId = turnId;
		next.turnStatus = "inProgress";
		next.plan = {
			explanation: stringValue(params.explanation),
			steps: Array.isArray(params.plan)
				? params.plan.filter(isRecord).map(planStep).filter((step) => step.step)
				: [],
			text: next.plan.text,
			updatedAt: nowIso(options),
		};
		return touch(next, options);
	}

	if (notification.method === "item/plan/delta") {
		const delta = stringValue(params.delta);
		if (!delta) {
			return snapshot;
		}
		const next = cloneSnapshot(snapshot);
		next.activeTurnId = turnId;
		next.turnStatus = "inProgress";
		next.plan = {
			...next.plan,
			text: `${next.plan.text}${delta}`,
			updatedAt: nowIso(options),
		};
		return touch(next, options);
	}

	if (notification.method === "item/started") {
		return applyThreadItem(snapshot, turnId, record(params.item), "inProgress", options);
	}

	if (notification.method === "item/completed") {
		return applyThreadItem(snapshot, turnId, record(params.item), "completed", options);
	}

	if (notification.method === "item/commandExecution/outputDelta") {
		const itemId = stringValue(params.itemId) ?? "command";
		return upsertRunningCommand(
			snapshot,
			turnId,
			itemId,
			undefined,
			options,
		);
	}

	if (notification.method === "item/reasoning/summaryPartAdded") {
		const next = cloneSnapshot(snapshot);
		const key = summaryKey(snapshot.threadId, turnId, params);
		finalizeEarlierSummaries(next, key, options);
		ensureSummaryBuffer(next, key);
		return touch(next, options);
	}

	if (notification.method === "item/reasoning/summaryTextDelta") {
		const delta = stringValue(params.delta);
		if (!delta) {
			return snapshot;
		}
		const next = cloneSnapshot(snapshot);
		appendSummaryBuffer(next, summaryKey(snapshot.threadId, turnId, params), delta);
		return touch(next, options);
	}

	if (notification.method === "item/agentMessage/delta") {
		const delta = stringValue(params.delta);
		if (!delta) {
			return snapshot;
		}
		const next = cloneSnapshot(snapshot);
		appendAgentMessageBuffer(next, {
			threadId: snapshot.threadId,
			turnId,
			itemId: stringValue(params.itemId) ?? "agent-message",
		}, delta);
		return touch(next, options);
	}

	if (notification.method === "rawResponseItem/completed") {
		const item = record(params.item);
		if (item.type === "message") {
			const text = responseMessageText(item);
			if (!text) {
				return snapshot;
			}
			const next = cloneSnapshot(snapshot);
			if (messagePhase(item.phase) === "commentary") {
				addProgressMessage(next, {
					kind: "commentary",
					threadId: snapshot.threadId,
					turnId,
					itemId: `raw:${next.progress.messages.length}`,
					text,
				}, options);
				return touch(next, options);
			}
			next.progress.finalAnswer = finalProgressMessage(snapshot.threadId, turnId, text, false);
			return touch(next, options);
		}
		return snapshot;
	}

	if (notification.method === "turn/completed") {
		return reduceCompletedTurn(
			snapshot,
			snapshot.threadId,
			record(params.turn) as Partial<v2.Turn>,
			options,
		);
	}

	return snapshot;
}

export function reduceCompletedTurn(
	snapshot: WorkbenchThreadSnapshot,
	threadId: string,
	turn: v2.Turn | Partial<v2.Turn>,
	options: WorkbenchReducerOptions = {},
): WorkbenchThreadSnapshot {
	if (threadId !== snapshot.threadId || !turn.id) {
		return snapshot;
	}
	let next = cloneSnapshot(snapshot);
	const items = Array.isArray(turn.items) ? turn.items : [];
	for (const item of items) {
		if (isRecord(item)) {
			next = applyThreadItem(next, turn.id, item as v2.ThreadItem, "completed", options);
		}
	}
	finalizeSummariesForTurn(next, turn.id, options);
	const finalText =
		next.progress.finalAnswer?.text.trim() ||
		finalTextFromTurn(turn).trim();
	if (finalText) {
		next.progress.finalAnswer = finalProgressMessage(threadId, turn.id, finalText, true);
		upsertProgressMessage(next, next.progress.finalAnswer);
	}
	next.activeTurnId = next.activeTurnId === turn.id ? undefined : next.activeTurnId;
	next.turnStatus = turnStatus(turn.status);
	next.runningCommands = next.runningCommands.filter((command) =>
		command.turnId !== turn.id
	);
	return touch(next, options);
}

export function pendingProgressMessages(
	snapshot: WorkbenchThreadSnapshot,
	options: { mode?: WorkbenchProgressMode } = {},
): WorkbenchProgressMessage[] {
	const mode = options.mode ?? "summary";
	return snapshot.progress.messages.filter((message) => {
		if (!message.ready || message.deliveredAt) {
			return false;
		}
		if (message.kind === "final") {
			return true;
		}
		return message.kind === mode;
	});
}

export function markProgressMessagesDelivered(
	snapshot: WorkbenchThreadSnapshot,
	messageIds: string[],
	options: WorkbenchReducerOptions = {},
): WorkbenchThreadSnapshot {
	const delivered = new Set(messageIds);
	const deliveredAt = nowIso(options);
	const next = cloneSnapshot(snapshot);
	next.progress.messages = next.progress.messages.map((message) =>
		delivered.has(message.id) ? { ...message, deliveredAt } : message
	);
	if (
		next.progress.finalAnswer &&
		delivered.has(next.progress.finalAnswer.id)
	) {
		next.progress.finalAnswer = {
			...next.progress.finalAnswer,
			deliveredAt,
		};
	}
	return touch(next, options);
}

export function threadGoalSetDescriptor(
	params: v2.ThreadGoalSetParams,
): AppServerRequestDescriptor<v2.ThreadGoalSetParams> {
	return { method: "thread/goal/set", params };
}

export function threadGoalGetDescriptor(
	params: v2.ThreadGoalGetParams,
): AppServerRequestDescriptor<v2.ThreadGoalGetParams> {
	return { method: "thread/goal/get", params };
}

export function threadGoalClearDescriptor(
	params: v2.ThreadGoalClearParams,
): AppServerRequestDescriptor<v2.ThreadGoalClearParams> {
	return { method: "thread/goal/clear", params };
}

export function threadReadDescriptor(
	params: v2.ThreadReadParams,
): AppServerRequestDescriptor<v2.ThreadReadParams> {
	return { method: "thread/read", params };
}

export function threadNameSetDescriptor(
	params: v2.ThreadSetNameParams,
): AppServerRequestDescriptor<v2.ThreadSetNameParams> {
	return { method: "thread/name/set", params };
}

export function turnStartDescriptor(
	params: v2.TurnStartParams,
): AppServerRequestDescriptor<v2.TurnStartParams> {
	return { method: "turn/start", params };
}

export function turnSteerDescriptor(
	params: v2.TurnSteerParams,
): AppServerRequestDescriptor<v2.TurnSteerParams> {
	return { method: "turn/steer", params };
}

export function turnInterruptDescriptor(
	params: v2.TurnInterruptParams,
): AppServerRequestDescriptor<v2.TurnInterruptParams> {
	return { method: "turn/interrupt", params };
}

function applyThreadItem(
	snapshot: WorkbenchThreadSnapshot,
	turnId: string,
	item: v2.ThreadItem | Record<string, unknown>,
	fallbackStatus: WorkbenchActivity["status"],
	options: WorkbenchReducerOptions,
): WorkbenchThreadSnapshot {
	let next = cloneSnapshot(snapshot);
	next.activeTurnId = fallbackStatus === "inProgress" ? turnId : next.activeTurnId;
	next.turnStatus = fallbackStatus === "inProgress" ? "inProgress" : next.turnStatus;
	if (item.type === "commandExecution") {
		const status = activityStatus(item.status, fallbackStatus);
		if (status === "inProgress") {
			next = upsertRunningCommand(
				next,
				turnId,
				stringValue(item.id) ?? "command",
				stringValue(item.command),
				options,
			);
		} else {
			next.runningCommands = next.runningCommands.filter((command) =>
				command.itemId !== (stringValue(item.id) ?? "command")
			);
			next = touch(next, options);
		}
	}
	if (item.type === "plan") {
		const text = stringValue(item.text);
		if (text) {
			next.plan = { ...next.plan, text, updatedAt: nowIso(options) };
		}
	}
	if (item.type === "agentMessage") {
		const text = stringValue(item.text)?.trim() ||
			agentMessageBufferText(next, snapshot.threadId, turnId, stringValue(item.id) ?? "agent-message");
		if (text) {
			if (messagePhase(item.phase) === "commentary") {
				addProgressMessage(next, {
					kind: "commentary",
					threadId: snapshot.threadId,
					turnId,
					itemId: stringValue(item.id) ?? "agent-message",
					text,
				}, options);
			} else {
				next.progress.finalAnswer = finalProgressMessage(snapshot.threadId, turnId, text, false);
			}
			next.progress.agentMessageBuffers = next.progress.agentMessageBuffers.filter((buffer) =>
				!(
					buffer.threadId === snapshot.threadId &&
					buffer.turnId === turnId &&
					buffer.itemId === (stringValue(item.id) ?? "agent-message")
				)
			);
		}
	}
	if (item.type === "reasoning" && Array.isArray(item.summary)) {
		item.summary.forEach((entry, index) => {
			const text = stringValue(entry);
			if (text) {
				addProgressMessage(next, {
					kind: "summary",
					threadId: snapshot.threadId,
					turnId,
					itemId: stringValue(item.id) ?? "reasoning",
					summaryIndex: index,
					text,
				}, options);
			}
		});
	}
	const activity = activityFromItem(item, turnId, fallbackStatus, options);
	if (activity) {
		next.recentActivity = [
			activity,
			...next.recentActivity.filter((entry) => entry.itemId !== activity.itemId),
		].slice(0, options.maxActivity ?? 12);
	}
	return touch(next, options);
}

function upsertRunningCommand(
	snapshot: WorkbenchThreadSnapshot,
	turnId: string,
	itemId: string,
	command: string | undefined,
	options: WorkbenchReducerOptions,
): WorkbenchThreadSnapshot {
	const next = cloneSnapshot(snapshot);
	const existing = next.runningCommands.find((entry) => entry.itemId === itemId);
	const at = nowIso(options);
	const running: WorkbenchRunningCommand = {
		itemId,
		turnId,
		command: command ?? existing?.command ?? `command ${compactId(itemId)}`,
		status: "inProgress",
		startedAt: existing?.startedAt ?? at,
		lastOutputAt: at,
	};
	next.runningCommands = [
		running,
		...next.runningCommands.filter((entry) => entry.itemId !== itemId),
	];
	return touch(next, options);
}

function activityFromItem(
	item: v2.ThreadItem | Record<string, unknown>,
	turnId: string,
	fallbackStatus: WorkbenchActivity["status"],
	options: WorkbenchReducerOptions,
): WorkbenchActivity | undefined {
	const itemId = stringValue(item.id);
	if (!itemId) {
		return undefined;
	}
	const status = activityStatus("status" in item ? item.status : undefined, fallbackStatus);
	const base = {
		itemId,
		turnId,
		status,
		updatedAt: nowIso(options),
	};
	if (item.type === "fileChange") {
		const changes = Array.isArray(item.changes) ? item.changes.length : 0;
		return {
			...base,
			kind: "files",
			label: changes > 0 ? `${changes} file change${changes === 1 ? "" : "s"}` : "file changes",
		};
	}
	if (item.type === "commandExecution") {
		return {
			...base,
			kind: "command",
			label: stringValue(item.command) ?? "command",
		};
	}
	if (item.type === "mcpToolCall") {
		return {
			...base,
			kind: "mcp",
			label: `${stringValue(item.server) ?? "mcp"}.${stringValue(item.tool) ?? "tool"}`,
		};
	}
	if (item.type === "dynamicToolCall") {
		const namespace = stringValue(item.namespace);
		const tool = stringValue(item.tool) ?? "tool";
		return {
			...base,
			kind: "tool",
			label: namespace ? `${namespace}.${tool}` : tool,
		};
	}
	if (item.type === "collabAgentToolCall") {
		return {
			...base,
			kind: "agent",
			label: stringValue(item.tool) ?? "collab agent",
		};
	}
	if (item.type === "webSearch") {
		return {
			...base,
			kind: "web",
			label: stringValue(item.query) ?? "web search",
		};
	}
	if (item.type === "imageGeneration") {
		return {
			...base,
			kind: "image",
			label: "image generation",
		};
	}
	if (item.type === "contextCompaction") {
		return {
			...base,
			kind: "context",
			label: "compaction",
		};
	}
	return undefined;
}

function addProgressMessage(
	snapshot: WorkbenchThreadSnapshot,
	input: Omit<WorkbenchProgressMessage, "id" | "ready">,
	options: WorkbenchReducerOptions,
): void {
	upsertProgressMessage(snapshot, {
		id: progressMessageId(input),
		ready: true,
		...input,
	});
	snapshot.updatedAt = nowIso(options);
}

function upsertProgressMessage(
	snapshot: WorkbenchThreadSnapshot,
	message: WorkbenchProgressMessage,
): void {
	const existing = snapshot.progress.messages.find((candidate) =>
		candidate.id === message.id
	);
	snapshot.progress.messages = [
		existing?.deliveredAt ? { ...message, deliveredAt: existing.deliveredAt } : message,
		...snapshot.progress.messages.filter((candidate) => candidate.id !== message.id),
	];
}

function progressMessageId(
	input: Pick<WorkbenchProgressMessage, "kind" | "threadId" | "turnId" | "itemId" | "summaryIndex">,
): string {
	return [
		input.kind,
		input.threadId,
		input.turnId,
		input.itemId ?? "",
		input.summaryIndex ?? "",
	].join(":");
}

function finalProgressMessage(
	threadId: string,
	turnId: string,
	text: string,
	ready: boolean,
): WorkbenchProgressMessage {
	return {
		id: progressMessageId({ kind: "final", threadId, turnId }),
		kind: "final",
		threadId,
		turnId,
		text,
		ready,
	};
}

function summaryKey(
	threadId: string,
	turnId: string,
	params: Record<string, unknown>,
): {
	threadId: string;
	turnId: string;
	itemId: string;
	summaryIndex: number;
} {
	return {
		threadId,
		turnId,
		itemId: stringValue(params.itemId) ?? "reasoning",
		summaryIndex: numberValue(params.summaryIndex) ?? 0,
	};
}

function ensureSummaryBuffer(
	snapshot: WorkbenchThreadSnapshot,
	key: {
		threadId: string;
		turnId: string;
		itemId: string;
		summaryIndex: number;
	},
): void {
	if (!summaryBuffer(snapshot, key)) {
		snapshot.progress.summaryBuffers.push({ ...key, text: "" });
	}
}

function appendSummaryBuffer(
	snapshot: WorkbenchThreadSnapshot,
	key: {
		threadId: string;
		turnId: string;
		itemId: string;
		summaryIndex: number;
	},
	delta: string,
): void {
	ensureSummaryBuffer(snapshot, key);
	const buffer = summaryBuffer(snapshot, key);
	if (buffer) {
		buffer.text = `${buffer.text}${delta}`;
	}
}

function summaryBuffer(
	snapshot: WorkbenchThreadSnapshot,
	key: {
		threadId: string;
		turnId: string;
		itemId: string;
		summaryIndex: number;
	},
) {
	return snapshot.progress.summaryBuffers.find((buffer) =>
		buffer.threadId === key.threadId &&
		buffer.turnId === key.turnId &&
		buffer.itemId === key.itemId &&
		buffer.summaryIndex === key.summaryIndex
	);
}

function finalizeEarlierSummaries(
	snapshot: WorkbenchThreadSnapshot,
	key: {
		threadId: string;
		turnId: string;
		itemId: string;
		summaryIndex: number;
	},
	options: WorkbenchReducerOptions,
): void {
	for (const buffer of [...snapshot.progress.summaryBuffers]) {
		if (
			buffer.threadId === key.threadId &&
			buffer.turnId === key.turnId &&
			buffer.itemId === key.itemId &&
			buffer.summaryIndex < key.summaryIndex
		) {
			finalizeSummary(snapshot, buffer, options);
		}
	}
}

function finalizeSummariesForTurn(
	snapshot: WorkbenchThreadSnapshot,
	turnId: string,
	options: WorkbenchReducerOptions,
): void {
	for (const buffer of [...snapshot.progress.summaryBuffers]) {
		if (buffer.turnId === turnId) {
			finalizeSummary(snapshot, buffer, options);
		}
	}
}

function finalizeSummary(
	snapshot: WorkbenchThreadSnapshot,
	buffer: {
		threadId: string;
		turnId: string;
		itemId: string;
		summaryIndex: number;
		text: string;
	},
	options: WorkbenchReducerOptions,
): void {
	const text = buffer.text.trim();
	if (text) {
		addProgressMessage(snapshot, {
			kind: "summary",
			threadId: buffer.threadId,
			turnId: buffer.turnId,
			itemId: buffer.itemId,
			summaryIndex: buffer.summaryIndex,
			text,
		}, options);
	}
	snapshot.progress.summaryBuffers = snapshot.progress.summaryBuffers.filter((entry) =>
		!(
			entry.threadId === buffer.threadId &&
			entry.turnId === buffer.turnId &&
			entry.itemId === buffer.itemId &&
			entry.summaryIndex === buffer.summaryIndex
		)
	);
}

function appendAgentMessageBuffer(
	snapshot: WorkbenchThreadSnapshot,
	key: { threadId: string; turnId: string; itemId: string },
	delta: string,
): void {
	let buffer = snapshot.progress.agentMessageBuffers.find((entry) =>
		entry.threadId === key.threadId &&
		entry.turnId === key.turnId &&
		entry.itemId === key.itemId
	);
	if (!buffer) {
		buffer = { ...key, text: "" };
		snapshot.progress.agentMessageBuffers.push(buffer);
	}
	buffer.text = `${buffer.text}${delta}`;
}

function agentMessageBufferText(
	snapshot: WorkbenchThreadSnapshot,
	threadId: string,
	turnId: string,
	itemId: string,
): string {
	return snapshot.progress.agentMessageBuffers.find((buffer) =>
		buffer.threadId === threadId &&
		buffer.turnId === turnId &&
		buffer.itemId === itemId
	)?.text.trim() ?? "";
}

function goalSummary(value: Record<string, unknown>): WorkbenchGoalSummary | undefined {
	const threadId = stringValue(value.threadId);
	const objective = stringValue(value.objective);
	const status = threadGoalStatus(value.status);
	if (!threadId || !objective || !status) {
		return undefined;
	}
	return {
		threadId,
		objective,
		status,
		tokenBudget: typeof value.tokenBudget === "number" ? value.tokenBudget : null,
		tokensUsed: numberValue(value.tokensUsed) ?? 0,
		timeUsedSeconds: numberValue(value.timeUsedSeconds) ?? 0,
		createdAt: numberValue(value.createdAt) ?? 0,
		updatedAt: numberValue(value.updatedAt) ?? 0,
	};
}

function planStep(value: Record<string, unknown>): WorkbenchPlanStep {
	return {
		step: stringValue(value.step) ?? "",
		status: planStepStatus(value.status),
	};
}

function finalTextFromTurn(turn: Pick<Partial<v2.Turn>, "items">): string {
	const items = Array.isArray(turn.items) ? turn.items : [];
	const agentMessages = items
		.filter(isRecord)
		.filter((item) => item.type === "agentMessage");
	const finalMessages = agentMessages.filter((item) =>
		messagePhase(item.phase) === "final_answer"
	);
	const selected = finalMessages.length > 0 ? finalMessages : agentMessages;
	return selected
		.map((item) => stringValue(item.text) ?? "")
		.filter(Boolean)
		.join("\n\n");
}

function responseMessageText(item: Record<string, unknown>): string {
	const content = Array.isArray(item.content) ? item.content : [];
	return content
		.filter(isRecord)
		.map((entry) =>
			stringValue(entry.text) ??
			stringValue(entry.input_text) ??
			stringValue(entry.output_text) ??
			""
		)
		.filter(Boolean)
		.join("");
}

function cloneSnapshot(snapshot: WorkbenchThreadSnapshot): WorkbenchThreadSnapshot {
	return {
		...snapshot,
		plan: {
			...snapshot.plan,
			steps: snapshot.plan.steps.map((step) => ({ ...step })),
		},
		runningCommands: snapshot.runningCommands.map((command) => ({ ...command })),
		recentActivity: snapshot.recentActivity.map((activity) => ({ ...activity })),
		progress: {
			summaryBuffers: snapshot.progress.summaryBuffers.map((buffer) => ({ ...buffer })),
			agentMessageBuffers: snapshot.progress.agentMessageBuffers.map((buffer) => ({ ...buffer })),
			messages: snapshot.progress.messages.map((message) => ({ ...message })),
			...(snapshot.progress.finalAnswer
				? { finalAnswer: { ...snapshot.progress.finalAnswer } }
				: {}),
		},
	};
}

function touch(
	snapshot: WorkbenchThreadSnapshot,
	options: WorkbenchReducerOptions,
): WorkbenchThreadSnapshot {
	return {
		...snapshot,
		updatedAt: nowIso(options),
	};
}

function nowIso(options: WorkbenchReducerOptions): string {
	const now = options.now;
	if (now instanceof Date) {
		return now.toISOString();
	}
	if (typeof now === "function") {
		return now().toISOString();
	}
	return new Date().toISOString();
}

function turnStatus(value: unknown): WorkbenchTurnStatus {
	return value === "inProgress" ||
		value === "completed" ||
		value === "failed" ||
		value === "interrupted"
		? value
		: "idle";
}

function planStepStatus(value: unknown): WorkbenchPlanStep["status"] {
	return value === "pending" || value === "inProgress" || value === "completed"
		? value
		: "pending";
}

function threadGoalStatus(value: unknown): v2.ThreadGoalStatus | undefined {
	return value === "active" ||
		value === "paused" ||
		value === "blocked" ||
		value === "usageLimited" ||
		value === "budgetLimited" ||
		value === "complete"
		? value
		: undefined;
}

function activityStatus(
	value: unknown,
	fallback: WorkbenchActivity["status"],
): WorkbenchActivity["status"] {
	return value === "inProgress" ||
		value === "completed" ||
		value === "failed" ||
		value === "declined"
		? value
		: fallback;
}

function messagePhase(value: unknown): "commentary" | "final_answer" | undefined {
	return value === "commentary" || value === "final_answer" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactId(value: string): string {
	return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}
