import type {
	ReasoningEffort,
	ReasoningSummary,
	v2,
} from "@peezy.tech/codex-flows/generated";
import type { JsonRpcNotification, JsonRpcRequest } from "@peezy.tech/codex-flows/rpc";
import type { DiscordBridgeLogLevelSetting } from "./logger.ts";

export type DiscordBridgeConfig = {
	allowedUserIds: Set<string>;
	allowedChannelIds: Set<string>;
	statePath: string;
	cwd?: string;
	model?: string;
	modelProvider?: string;
	serviceTier?: string;
	effort?: ReasoningEffort;
	summary?: ReasoningSummary;
	approvalPolicy?: v2.AskForApproval;
	sandbox?: v2.SandboxMode;
	permissions?: v2.PermissionProfileSelectionParams;
	typingIntervalMs?: number;
	reconcileIntervalMs?: number;
	progressMode?: DiscordProgressMode;
	consoleOutput?: DiscordConsoleOutputMode;
	logLevel?: DiscordBridgeLogLevelSetting;
	debug?: boolean;
};

export type DiscordProgressMode = "summary" | "commentary" | "none";
export type DiscordConsoleOutputMode = "messages" | "none";

export type DiscordAuthor = {
	id: string;
	name: string;
	isBot: boolean;
};

export type DiscordMessageInbound = {
	kind: "message";
	channelId: string;
	guildId?: string;
	messageId: string;
	author: DiscordAuthor;
	content: string;
	createdAt: string;
};

export type DiscordThreadStartInbound = {
	kind: "threadStart";
	sourceMessageId: string;
	channelId: string;
	guildId?: string;
	author: DiscordAuthor;
	prompt?: string;
	mentionedUserIds?: string[];
	title?: string;
	createdAt: string;
	reply?: (text: string) => Promise<void>;
};

export type DiscordClearInbound = {
	kind: "clear";
	channelId: string;
	guildId?: string;
	author: DiscordAuthor;
	createdAt: string;
	reply?: (text: string) => Promise<void>;
};

export type DiscordClearWebhooksInbound = {
	kind: "clearWebhooks";
	channelId: string;
	guildId?: string;
	author: DiscordAuthor;
	webhookUrl?: string;
	createdAt: string;
	reply?: (text: string) => Promise<void>;
};

export type DiscordInbound =
	| DiscordMessageInbound
	| DiscordThreadStartInbound
	| DiscordClearInbound
	| DiscordClearWebhooksInbound;

export type DiscordBridgeTransportHandlers = {
	onInbound(inbound: DiscordInbound): void;
};

export type DiscordBridgeTransport = {
	start(handlers: DiscordBridgeTransportHandlers): Promise<void>;
	stop(): Promise<void>;
	registerCommands(): Promise<void>;
	createThread(
		channelId: string,
		name: string,
		sourceMessageId?: string,
	): Promise<string>;
	sendMessage(channelId: string, text: string): Promise<string[]>;
	updateMessage?(channelId: string, messageId: string, text: string): Promise<void>;
	deleteMessage(channelId: string, messageId: string): Promise<void>;
	deleteWebhookMessages?(
		channelId: string,
		options?: { webhookUrl?: string },
	): Promise<{ deleted: number; failed: number }>;
	deleteThread?(channelId: string): Promise<void>;
	addThreadMembers?(channelId: string, userIds: string[]): Promise<void>;
	pinMessage?(channelId: string, messageId: string): Promise<void>;
	sendTyping(channelId: string): Promise<void>;
};

export type CodexBridgeClient = {
	connect(): Promise<void>;
	close(): void;
	on(event: "notification", listener: (message: JsonRpcNotification) => void): unknown;
	on(event: "request", listener: (message: JsonRpcRequest) => void): unknown;
	startThread(params: v2.ThreadStartParams): Promise<v2.ThreadStartResponse>;
	resumeThread(params: v2.ThreadResumeParams): Promise<v2.ThreadResumeResponse>;
	setThreadName(params: v2.ThreadSetNameParams): Promise<v2.ThreadSetNameResponse>;
	startTurn(params: v2.TurnStartParams): Promise<v2.TurnStartResponse>;
	steerTurn(params: v2.TurnSteerParams): Promise<v2.TurnSteerResponse>;
	readThread(params: v2.ThreadReadParams): Promise<v2.ThreadReadResponse>;
	getThreadGoal(params: v2.ThreadGoalGetParams): Promise<v2.ThreadGoalGetResponse>;
	respondError(id: string | number, code: number, message: string, data?: unknown): void;
};

export type DiscordBridgeState = {
	version: 1;
	sessions: DiscordBridgeSession[];
	queue: DiscordBridgeQueueItem[];
	activeTurns: DiscordBridgeActiveTurn[];
	processedMessageIds: string[];
	deliveries: DiscordBridgeDelivery[];
};

export type DiscordBridgeSession = {
	discordThreadId: string;
	parentChannelId: string;
	guildId?: string;
	sourceMessageId?: string;
	codexThreadId: string;
	title: string;
	createdAt: string;
	ownerUserId?: string;
	participantUserIds?: string[];
	cwd?: string;
	mode?: "new" | "resumed";
	statusMessageId?: string;
};

export type DiscordBridgeQueueItem = {
	id: string;
	status: "pending" | "processing" | "failed";
	discordMessageId: string;
	discordThreadId: string;
	codexThreadId: string;
	authorId: string;
	authorName: string;
	content: string;
	createdAt: string;
	receivedAt: string;
	attempts: number;
	turnId?: string;
	lastError?: string;
	nextAttemptAt?: string;
};

export type DiscordBridgeActiveTurn = {
	turnId: string;
	discordThreadId: string;
	codexThreadId: string;
	origin: "discord" | "external";
	queueItemId?: string;
	startedAt?: string;
	observedAt: string;
};

export type DiscordBridgeDelivery = {
	discordMessageId: string;
	discordThreadId: string;
	codexThreadId: string;
	turnId?: string;
	kind: "summary" | "commentary" | "final" | "error";
	outboundMessageIds: string[];
	deliveredAt: string;
};

export type DiscordBridgeStateStore = {
	load(): Promise<DiscordBridgeState>;
	save(state: DiscordBridgeState): Promise<void>;
};
