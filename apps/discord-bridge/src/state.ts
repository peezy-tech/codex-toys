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
	DiscordGatewayState,
} from "./types.ts";

const maxProcessedMessageIds = 1000;
const maxDeliveries = 500;

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
		status !== "complete"
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
		discordDetailThreadId: optionalString(value.discordDetailThreadId),
		parentDiscordMessageId: optionalString(value.parentDiscordMessageId),
		createdAt: requiredString(value.createdAt, "gateway.delegations.createdAt"),
		updatedAt: requiredString(value.updatedAt, "gateway.delegations.updatedAt"),
	};
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
	return value === "new" || value === "resumed" || value === "gateway"
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
