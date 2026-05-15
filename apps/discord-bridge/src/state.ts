import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
	DiscordBridgeActiveTurn,
	DiscordBridgeDelivery,
	DiscordBridgeQueueItem,
	DiscordBridgeSession,
	DiscordBridgeState,
	DiscordBridgeStateStore,
	DiscordGatewayDelegation,
	DiscordGatewayHookEventName,
	DiscordGatewayObservedThread,
	DiscordGatewayWorkspaceSurface,
	DiscordGatewayState,
} from "./types.ts";

const maxProcessedMessageIds = 1000;
const maxDeliveries = 500;
const maxProcessedStopHookEventIds = 2000;
const maxProcessedHookEventIds = 5000;
const maxObservedThreads = 1000;

export class JsonFileStateStore implements DiscordBridgeStateStore {
	readonly path: string;

	constructor(filePath: string) {
		this.path = path.resolve(filePath);
	}

	async load(): Promise<DiscordBridgeState> {
		const file = Bun.file(this.path);
		if (!(await file.exists())) {
			return emptyState();
		}
		const parsed = JSON.parse(await file.text()) as unknown;
		return parseState(parsed);
	}

	async save(state: DiscordBridgeState): Promise<void> {
		trimState(state);
		await mkdir(path.dirname(this.path), { recursive: true });
		const tempPath = `${this.path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
		await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`);
		await rename(tempPath, this.path);
	}
}

export class MemoryStateStore implements DiscordBridgeStateStore {
	state: DiscordBridgeState;

	constructor(state: DiscordBridgeState = emptyState()) {
		this.state = structuredClone(state);
	}

	async load(): Promise<DiscordBridgeState> {
		return structuredClone(this.state);
	}

	async save(state: DiscordBridgeState): Promise<void> {
		this.state = structuredClone(state);
	}
}

export function emptyState(): DiscordBridgeState {
	return {
		version: 1,
		gateway: undefined,
		sessions: [],
		queue: [],
		activeTurns: [],
		processedMessageIds: [],
		deliveries: [],
	};
}

export function trimState(state: DiscordBridgeState): void {
	state.processedMessageIds = state.processedMessageIds.slice(
		-maxProcessedMessageIds,
	);
	state.deliveries = state.deliveries.slice(-maxDeliveries);
	if (state.gateway?.processedStopHookEventIds) {
		state.gateway.processedStopHookEventIds =
			state.gateway.processedStopHookEventIds.slice(
				-maxProcessedStopHookEventIds,
			);
	}
	if (state.gateway?.processedHookEventIds) {
		state.gateway.processedHookEventIds =
			state.gateway.processedHookEventIds.slice(-maxProcessedHookEventIds);
	}
	if (state.gateway?.observedThreads) {
		state.gateway.observedThreads = [...state.gateway.observedThreads]
			.sort((left, right) =>
				Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt)
			)
			.slice(0, maxObservedThreads);
	}
}

function parseState(value: unknown): DiscordBridgeState {
	if (!isRecord(value) || value.version !== 1) {
		throw new Error("Invalid Discord bridge state file");
	}
	return {
		version: 1,
		gateway: parseGateway(value.gateway),
		sessions: Array.isArray(value.sessions)
			? value.sessions.map(parseSession)
			: [],
		queue: Array.isArray(value.queue) ? value.queue.map(parseQueueItem) : [],
		activeTurns: Array.isArray(value.activeTurns)
			? value.activeTurns.map(parseActiveTurn)
			: [],
		processedMessageIds: Array.isArray(value.processedMessageIds)
			? value.processedMessageIds.filter(
					(candidate): candidate is string => typeof candidate === "string",
				)
			: [],
		deliveries: Array.isArray(value.deliveries)
			? value.deliveries.map(parseDelivery)
			: [],
	};
}

function parseGateway(value: unknown): DiscordGatewayState | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error("Invalid Discord bridge gateway state");
	}
	return {
		homeChannelId: requiredString(value.homeChannelId, "gateway.homeChannelId"),
		mainThreadId: optionalString(value.mainThreadId),
		statusMessageId: optionalString(value.statusMessageId),
		createdAt: optionalString(value.createdAt),
		toolsVersion: optionalNumber(value.toolsVersion),
		delegations: Array.isArray(value.delegations)
			? value.delegations.map(parseGatewayDelegation)
			: [],
		workspaces: Array.isArray(value.workspaces)
			? value.workspaces.map(parseGatewayWorkspace)
			: [],
		observedThreads: Array.isArray(value.observedThreads)
			? value.observedThreads.map(parseGatewayObservedThread)
			: [],
		pendingWakes: Array.isArray(value.pendingWakes)
			? value.pendingWakes.map(parseGatewayPendingWake)
			: [],
		processedHookEventIds: uniqueStrings([
			...(Array.isArray(value.processedHookEventIds)
				? value.processedHookEventIds
				: []),
			...(Array.isArray(value.processedStopHookEventIds)
				? value.processedStopHookEventIds
				: []),
		]),
		processedStopHookEventIds: Array.isArray(value.processedStopHookEventIds)
			? uniqueStrings(value.processedStopHookEventIds)
			: [],
	};
}

function parseGatewayDelegation(value: unknown): DiscordGatewayDelegation {
	if (!isRecord(value)) {
		throw new Error("Invalid Discord bridge gateway delegation");
	}
	const status = value.status;
	if (
		status !== "active" &&
		status !== "idle" &&
		status !== "failed" &&
		status !== "complete" &&
		status !== "reported"
	) {
		throw new Error("Invalid Discord bridge gateway delegation status");
	}
	return {
		id: requiredString(value.id, "gateway.delegations.id"),
		codexThreadId: requiredString(
			value.codexThreadId,
			"gateway.delegations.codexThreadId",
		),
		title: requiredString(value.title, "gateway.delegations.title"),
		status,
		cwd: optionalString(value.cwd),
		workspaceKey: optionalString(value.workspaceKey),
		groupId: optionalString(value.groupId),
		returnMode: parseReturnMode(value.returnMode),
		discordDetailThreadId: optionalString(value.discordDetailThreadId),
		discordTaskThreadId: optionalString(value.discordTaskThreadId),
		discordWorkspaceThreadId: optionalString(value.discordWorkspaceThreadId),
		parentDiscordMessageId: optionalString(value.parentDiscordMessageId),
		lastTurnId: optionalString(value.lastTurnId),
		lastStatus: optionalString(value.lastStatus),
		lastFinal: optionalString(value.lastFinal),
		completedAt: optionalString(value.completedAt),
		injectedAt: optionalString(value.injectedAt),
		mirroredAt: optionalString(value.mirroredAt),
		taskMirroredAt: optionalString(value.taskMirroredAt),
		reportedAt: optionalString(value.reportedAt),
		createdAt: requiredString(value.createdAt, "gateway.delegations.createdAt"),
		updatedAt: requiredString(value.updatedAt, "gateway.delegations.updatedAt"),
	};
}

function parseGatewayWorkspace(value: unknown): DiscordGatewayWorkspaceSurface {
	if (!isRecord(value)) {
		throw new Error("Invalid Discord bridge gateway workspace");
	}
	return {
		key: requiredString(value.key, "gateway.workspaces.key"),
		cwd: requiredString(value.cwd, "gateway.workspaces.cwd"),
		title: requiredString(value.title, "gateway.workspaces.title"),
		discordThreadId: requiredString(
			value.discordThreadId,
			"gateway.workspaces.discordThreadId",
		),
		statusMessageId: optionalString(value.statusMessageId),
		delegationIds: Array.isArray(value.delegationIds)
			? uniqueStrings(value.delegationIds)
			: [],
		createdAt: requiredString(value.createdAt, "gateway.workspaces.createdAt"),
		updatedAt: requiredString(value.updatedAt, "gateway.workspaces.updatedAt"),
	};
}

function parseGatewayPendingWake(
	value: unknown,
): NonNullable<DiscordGatewayState["pendingWakes"]>[number] {
	if (!isRecord(value)) {
		throw new Error("Invalid Discord bridge gateway pending wake");
	}
	const kind = value.kind === "delegation" || value.kind === "group"
		? value.kind
		: undefined;
	if (!kind) {
		throw new Error("Invalid Discord bridge gateway pending wake kind");
	}
	return {
		id: requiredString(value.id, "gateway.pendingWakes.id"),
		kind,
		delegationIds: Array.isArray(value.delegationIds)
			? uniqueStrings(value.delegationIds)
			: [],
		groupId: optionalString(value.groupId),
		reason: requiredString(value.reason, "gateway.pendingWakes.reason"),
		createdAt: requiredString(value.createdAt, "gateway.pendingWakes.createdAt"),
		startedAt: optionalString(value.startedAt),
	};
}

function parseGatewayObservedThread(value: unknown): DiscordGatewayObservedThread {
	if (!isRecord(value)) {
		throw new Error("Invalid Discord bridge gateway observed thread");
	}
	return {
		threadId: requiredString(value.threadId, "gateway.observedThreads.threadId"),
		title: optionalString(value.title),
		status: parseObservedThreadStatus(value.status),
		cwd: optionalString(value.cwd),
		workspaceKey: optionalString(value.workspaceKey),
		model: optionalString(value.model),
		transcriptPath: optionalString(value.transcriptPath),
		lastTurnId: optionalString(value.lastTurnId),
		lastHookEventName: parseHookEventName(value.lastHookEventName),
		source: optionalString(value.source),
		promptPreview: optionalString(value.promptPreview),
		assistantPreview: optionalString(value.assistantPreview),
		toolName: optionalString(value.toolName),
		toolUseId: optionalString(value.toolUseId),
		toolInputPreview: optionalString(value.toolInputPreview),
		toolResponsePreview: optionalString(value.toolResponsePreview),
		permissionDescription: optionalString(value.permissionDescription),
		firstSeenAt: requiredString(value.firstSeenAt, "gateway.observedThreads.firstSeenAt"),
		lastSeenAt: requiredString(value.lastSeenAt, "gateway.observedThreads.lastSeenAt"),
		updatedAt: requiredString(value.updatedAt, "gateway.observedThreads.updatedAt"),
	};
}

function parseObservedThreadStatus(
	value: unknown,
): DiscordGatewayObservedThread["status"] {
	return value === "starting" ||
			value === "active" ||
			value === "tool" ||
			value === "waiting" ||
			value === "idle"
		? value
		: "idle";
}

function parseHookEventName(value: unknown): DiscordGatewayHookEventName | undefined {
	return value === "SessionStart" ||
			value === "UserPromptSubmit" ||
			value === "PreToolUse" ||
			value === "PermissionRequest" ||
			value === "PostToolUse" ||
			value === "Stop"
		? value
		: undefined;
}

function parseReturnMode(value: unknown): DiscordGatewayDelegation["returnMode"] {
	return value === "detached" ||
			value === "record_only" ||
			value === "wake_on_done" ||
			value === "wake_on_group" ||
			value === "manual"
		? value
		: undefined;
}

function parseActiveTurn(value: unknown): DiscordBridgeActiveTurn {
	if (!isRecord(value)) {
		throw new Error("Invalid Discord bridge active turn");
	}
	const origin = value.origin === "discord" || value.origin === "external"
		? value.origin
		: "external";
	return {
		turnId: requiredString(value.turnId, "activeTurns.turnId"),
		discordThreadId: requiredString(value.discordThreadId, "activeTurns.discordThreadId"),
		codexThreadId: requiredString(value.codexThreadId, "activeTurns.codexThreadId"),
		origin,
		queueItemId: optionalString(value.queueItemId),
		startedAt: optionalString(value.startedAt),
		observedAt: requiredString(value.observedAt, "activeTurns.observedAt"),
	};
}

function parseSession(value: unknown): DiscordBridgeSession {
	if (!isRecord(value)) {
		throw new Error("Invalid Discord bridge session");
	}
	return {
		discordThreadId: requiredString(value.discordThreadId, "session.discordThreadId"),
		parentChannelId: requiredString(value.parentChannelId, "session.parentChannelId"),
		guildId: optionalString(value.guildId),
		sourceMessageId: optionalString(value.sourceMessageId),
		codexThreadId: requiredString(value.codexThreadId, "session.codexThreadId"),
		title: requiredString(value.title, "session.title"),
		createdAt: requiredString(value.createdAt, "session.createdAt"),
		ownerUserId: optionalString(value.ownerUserId),
		participantUserIds: Array.isArray(value.participantUserIds)
			? uniqueStrings(value.participantUserIds)
			: undefined,
		cwd: optionalString(value.cwd),
		mode: parseSessionMode(value.mode),
		statusMessageId: optionalString(value.statusMessageId),
	};
}

function parseQueueItem(value: unknown): DiscordBridgeQueueItem {
	if (!isRecord(value)) {
		throw new Error("Invalid Discord bridge queue item");
	}
	const status = value.status;
	if (status !== "pending" && status !== "processing" && status !== "failed") {
		throw new Error("Invalid Discord bridge queue item status");
	}
	return {
		id: requiredString(value.id, "queue.id"),
		status,
		discordMessageId: requiredString(value.discordMessageId, "queue.discordMessageId"),
		discordThreadId: requiredString(value.discordThreadId, "queue.discordThreadId"),
		codexThreadId: requiredString(value.codexThreadId, "queue.codexThreadId"),
		authorId: requiredString(value.authorId, "queue.authorId"),
		authorName: requiredString(value.authorName, "queue.authorName"),
		content: requiredString(value.content, "queue.content"),
		createdAt: requiredString(value.createdAt, "queue.createdAt"),
		receivedAt: requiredString(value.receivedAt, "queue.receivedAt"),
		attempts: optionalNumber(value.attempts) ?? 0,
		turnId: optionalString(value.turnId),
		lastError: optionalString(value.lastError),
		nextAttemptAt: optionalString(value.nextAttemptAt),
	};
}

function parseDelivery(value: unknown): DiscordBridgeDelivery {
	if (!isRecord(value)) {
		throw new Error("Invalid Discord bridge delivery");
	}
	const kind = value.kind;
	if (
		kind !== "summary" &&
		kind !== "commentary" &&
		kind !== "final" &&
		kind !== "error"
	) {
		throw new Error("Invalid Discord bridge delivery kind");
	}
	return {
		discordMessageId: requiredString(value.discordMessageId, "delivery.discordMessageId"),
		discordThreadId: requiredString(value.discordThreadId, "delivery.discordThreadId"),
		codexThreadId: requiredString(value.codexThreadId, "delivery.codexThreadId"),
		turnId: optionalString(value.turnId),
		kind,
		outboundMessageIds: Array.isArray(value.outboundMessageIds)
			? value.outboundMessageIds.filter(
					(candidate): candidate is string => typeof candidate === "string",
				)
			: [],
		deliveredAt: requiredString(value.deliveredAt, "delivery.deliveredAt"),
	};
}

function requiredString(value: unknown, fieldName: string): string {
	const parsed = optionalString(value);
	if (!parsed) {
		throw new Error(`Invalid Discord bridge state ${fieldName}: expected string`);
	}
	return parsed;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseSessionMode(value: unknown): DiscordBridgeSession["mode"] {
	return value === "new" ||
			value === "resumed" ||
			value === "gateway" ||
			value === "delegated" ||
			value === "workspace"
		? value
		: undefined;
}

function uniqueStrings(values: unknown[]): string[] {
	return [...new Set(values.filter(
		(candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
	))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
