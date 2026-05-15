import type {
	DiscordBridgeCommandRegistration,
	DiscordBridgeState,
	DiscordInbound,
} from "./types.ts";

export type CodexGatewayBackend = {
	start(): Promise<void>;
	startTransportDependentWork?(): Promise<void>;
	startBackgroundWork?(): Promise<void>;
	stop(): Promise<void>;
	handleInbound(inbound: DiscordInbound): Promise<void>;
	commandRegistration(): DiscordBridgeCommandRegistration;
	stateForTest?(): DiscordBridgeState;
	flushSummariesForTest?(): Promise<void>;
};

export type CodexGatewayPresenter = {
	createWorkspacePost?(
		locationId: string,
		title: string,
		body: string,
	): Promise<{ threadId: string; messageId?: string }>;
	createThread(
		locationId: string,
		title: string,
		sourceMessageId?: string,
	): Promise<string>;
	sendMessage(locationId: string, text: string): Promise<string[]>;
	updateMessage?(
		locationId: string,
		messageId: string,
		text: string,
	): Promise<void>;
	deleteMessage(locationId: string, messageId: string): Promise<void>;
	deleteWebhookMessages?(
		locationId: string,
		options?: { webhookUrl?: string },
	): Promise<{ deleted: number; failed: number }>;
	deleteThread?(locationId: string): Promise<void>;
	addThreadMembers?(threadId: string, userIds: string[]): Promise<void>;
	addReactions?(locationId: string, messageId: string, reactions: string[]): Promise<void>;
	pinMessage?(locationId: string, messageId: string): Promise<void>;
	sendTyping(locationId: string): Promise<void>;
};
