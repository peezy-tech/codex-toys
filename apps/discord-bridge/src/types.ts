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
	workspace?: DiscordWorkspaceConfig;
	flowBackendUrl?: string;
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
	hookSpoolDir?: string;
	progressMode?: DiscordProgressMode;
	consoleOutput?: DiscordConsoleOutputMode;
	logLevel?: DiscordBridgeLogLevelSetting;
	debug?: boolean;
};

export type DiscordProgressMode = "summary" | "commentary" | "none";
export type DiscordConsoleOutputMode = "messages" | "none";

export type DiscordWorkspaceConfig = {
	homeChannelId: string;
	mainThreadId?: string;
	workspaceForumChannelId?: string;
	taskThreadsChannelId?: string;
	surfaces?: DiscordWorkspaceSurfaceConfig[];
};

export type DiscordWorkspaceSurfaceConfig = {
	key: string;
	homeChannelId: string;
	workspaceForumChannelId?: string;
	taskThreadsChannelId?: string;
	workspaceCwds?: string[];
};

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

export type DiscordStatusInbound = {
	kind: "status";
	channelId: string;
	guildId?: string;
	author: DiscordAuthor;
	createdAt: string;
	reply?: (text: string) => Promise<void>;
	replyPicker?: (picker: DiscordEphemeralPicker) => Promise<void>;
};

export type DiscordThreadsInbound = {
	kind: "threads";
	channelId: string;
	guildId?: string;
	author: DiscordAuthor;
	createdAt: string;
	reply?: (text: string) => Promise<void>;
	replyPicker?: (picker: DiscordEphemeralPicker) => Promise<void>;
};

export type DiscordGoalsInbound = {
	kind: "goals";
	channelId: string;
	guildId?: string;
	author: DiscordAuthor;
	createdAt: string;
	objective?: string;
	goalStatus?: v2.ThreadGoalStatus;
	tokenBudget?: number;
	clear?: boolean;
	reply?: (text: string) => Promise<void>;
	replyPicker?: (picker: DiscordEphemeralPicker) => Promise<void>;
};

export type DiscordThreadPickerInbound = {
	kind: "threadPicker";
	channelId: string;
	guildId?: string;
	pickerId: string;
	optionId: string;
	author: DiscordAuthor;
	createdAt: string;
	reply?: (text: string) => Promise<void>;
	update?: (text: string) => Promise<void>;
	updatePicker?: (picker: DiscordEphemeralPicker) => Promise<void>;
};

export type DiscordReactionInbound = {
	kind: "reaction";
	channelId: string;
	guildId?: string;
	messageId: string;
	emoji: string;
	author: DiscordAuthor;
	createdAt: string;
};

export type DiscordInbound =
	| DiscordMessageInbound
	| DiscordThreadStartInbound
	| DiscordClearInbound
	| DiscordClearWebhooksInbound
	| DiscordStatusInbound
	| DiscordThreadsInbound
	| DiscordGoalsInbound
	| DiscordThreadPickerInbound
	| DiscordReactionInbound;

export type DiscordEphemeralPicker = {
	pickerId: string;
	text: string;
	options: DiscordEphemeralPickerOption[];
};

export type DiscordEphemeralPickerOption = {
	id: string;
	label: string;
};

export type DiscordBridgeTransportHandlers = {
	onInbound(inbound: DiscordInbound): void;
};

export type DiscordBridgeCommandRegistration = {
	channelIds?: string[];
};

export type DiscordBridgeTransport = {
	start(handlers: DiscordBridgeTransportHandlers): Promise<void>;
	stop(): Promise<void>;
	registerCommands(options?: DiscordBridgeCommandRegistration): Promise<void>;
	createForumPost?(
		channelId: string,
		name: string,
		message: string,
	): Promise<{ threadId: string; messageId?: string }>;
	createThread(
		channelId: string,
		name: string,
		sourceMessageId?: string,
	): Promise<string>;
	sendMessage(channelId: string, text: string): Promise<string[]>;
	updateMessage?(
		channelId: string,
		messageId: string,
		text: string,
	): Promise<void>;
	deleteMessage(channelId: string, messageId: string): Promise<void>;
	deleteWebhookMessages?(
		channelId: string,
		options?: { webhookUrl?: string },
	): Promise<{ deleted: number; failed: number }>;
	deleteThread?(channelId: string): Promise<void>;
	addThreadMembers?(channelId: string, userIds: string[]): Promise<void>;
	addReactions?(channelId: string, messageId: string, reactions: string[]): Promise<void>;
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
	injectThreadItems(params: v2.ThreadInjectItemsParams): Promise<v2.ThreadInjectItemsResponse>;
	listThreads(params: v2.ThreadListParams): Promise<v2.ThreadListResponse>;
	setThreadGoal(params: v2.ThreadGoalSetParams): Promise<v2.ThreadGoalSetResponse>;
	getThreadGoal(params: v2.ThreadGoalGetParams): Promise<v2.ThreadGoalGetResponse>;
	clearThreadGoal(params: v2.ThreadGoalClearParams): Promise<v2.ThreadGoalClearResponse>;
	respond(id: string | number, result: unknown): void;
	respondError(id: string | number, code: number, message: string, data?: unknown): void;
};

export type DiscordBridgeState = {
	version: 1;
	workspace?: DiscordWorkspaceState;
	sessions: DiscordBridgeSession[];
	queue: DiscordBridgeQueueItem[];
	activeTurns: DiscordBridgeActiveTurn[];
	processedMessageIds: string[];
	deliveries: DiscordBridgeDelivery[];
};

export type DiscordWorkspaceState = {
	homeChannelId: string;
	mainThreadId?: string;
	statusMessageId?: string;
	createdAt?: string;
	toolsVersion?: number;
	delegations: DiscordWorkspaceDelegation[];
	workspaces?: DiscordWorkspaceWorkspaceSurface[];
	observedThreads?: DiscordWorkspaceObservedThread[];
	pendingWakes?: DiscordWorkspacePendingWake[];
	processedHookEventIds?: string[];
	processedStopHookEventIds?: string[];
};

export type DiscordWorkspaceDelegationReturnMode =
	| "detached"
	| "record_only"
	| "wake_on_done"
	| "wake_on_group"
	| "manual";

export type DiscordWorkspaceDelegation = {
	id: string;
	codexThreadId: string;
	title: string;
	status: "active" | "idle" | "failed" | "complete" | "reported";
	cwd?: string;
	workspaceKey?: string;
	surfaceKey?: string;
	groupId?: string;
	returnMode?: DiscordWorkspaceDelegationReturnMode;
	discordDetailThreadId?: string;
	discordTaskThreadId?: string;
	discordWorkspaceThreadId?: string;
	parentDiscordMessageId?: string;
	lastTurnId?: string;
	lastStatus?: string;
	lastFinal?: string;
	completedAt?: string;
	injectedAt?: string;
	mirroredAt?: string;
	taskMirroredAt?: string;
	reportedAt?: string;
	createdAt: string;
	updatedAt: string;
};

export type DiscordWorkspaceWorkspaceSurface = {
	key: string;
	surfaceKey?: string;
	cwd: string;
	title: string;
	discordThreadId: string;
	statusMessageId?: string;
	delegationIds: string[];
	createdAt: string;
	updatedAt: string;
};

export type DiscordWorkspacePendingWake = {
	id: string;
	kind: "delegation" | "group";
	delegationIds: string[];
	groupId?: string;
	reason: string;
	createdAt: string;
	startedAt?: string;
};

export type DiscordWorkspaceHookEventName =
	| "SessionStart"
	| "UserPromptSubmit"
	| "PreToolUse"
	| "PermissionRequest"
	| "PostToolUse"
	| "Stop";

export type DiscordWorkspaceHookEvent = {
	version: 1;
	id: string;
	eventName: DiscordWorkspaceHookEventName;
	sessionId: string;
	turnId?: string;
	cwd?: string;
	transcriptPath?: string;
	model?: string;
	source?: string;
	promptPreview?: string;
	toolName?: string;
	toolUseId?: string;
	toolInputPreview?: string;
	toolResponsePreview?: string;
	permissionDescription?: string;
	lastAssistantMessage?: string;
	stopHookActive?: boolean;
	createdAt: string;
};

export type DiscordWorkspaceStopHookEvent = DiscordWorkspaceHookEvent & {
	eventName: "Stop";
};

export type DiscordWorkspaceObservedThreadStatus =
	| "starting"
	| "active"
	| "tool"
	| "waiting"
	| "idle";

export type DiscordWorkspaceObservedThread = {
	threadId: string;
	title?: string;
	status: DiscordWorkspaceObservedThreadStatus;
	cwd?: string;
	workspaceKey?: string;
	surfaceKey?: string;
	model?: string;
	transcriptPath?: string;
	lastTurnId?: string;
	lastHookEventName?: DiscordWorkspaceHookEventName;
	source?: string;
	promptPreview?: string;
	assistantPreview?: string;
	toolName?: string;
	toolUseId?: string;
	toolInputPreview?: string;
	toolResponsePreview?: string;
	permissionDescription?: string;
	firstSeenAt: string;
	lastSeenAt: string;
	updatedAt: string;
};

export type DiscordBridgeSession = {
	discordThreadId: string;
	parentChannelId: string;
	guildId?: string;
	surfaceKey?: string;
	sourceMessageId?: string;
	codexThreadId: string;
	title: string;
	createdAt: string;
	ownerUserId?: string;
	participantUserIds?: string[];
	cwd?: string;
	mode?: "new" | "resumed" | "operator" | "delegated" | "workspace";
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
