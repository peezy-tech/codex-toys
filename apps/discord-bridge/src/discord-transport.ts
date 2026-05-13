import {
	Client,
	Events,
	GatewayIntentBits,
	type Interaction,
	type Message,
} from "discord.js";

import { splitDiscordMessage } from "./bridge.ts";
import {
	createDiscordBridgeLogger,
	type DiscordBridgeLogger,
} from "./logger.ts";
import type {
	DiscordBridgeTransport,
	DiscordBridgeTransportHandlers,
} from "./types.ts";

export type DiscordJsBridgeTransportOptions = {
	token: string;
	logger?: DiscordBridgeLogger;
};

export class DiscordJsBridgeTransport implements DiscordBridgeTransport {
	#token: string;
	#logger: DiscordBridgeLogger;
	#client: Client | undefined;
	#handlers: DiscordBridgeTransportHandlers | undefined;

	constructor(options: DiscordJsBridgeTransportOptions) {
		this.#token = options.token;
		this.#logger = options.logger ?? createDiscordBridgeLogger();
	}

	async start(handlers: DiscordBridgeTransportHandlers): Promise<void> {
		this.#handlers = handlers;
		if (this.#client) {
			return;
		}
		const client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.DirectMessages,
				GatewayIntentBits.MessageContent,
			],
		});
		this.#client = client;
		client.once(Events.ClientReady, (readyClient) => {
			this.#logger.info("discord.connected", {
				userId: readyClient.user.id,
				tag: readyClient.user.tag,
			});
		});
		client.on(Events.MessageCreate, (message) => this.#handleMessage(message));
		client.on(Events.InteractionCreate, (interaction) =>
			void this.#handleInteraction(interaction).catch((error) => {
				this.#logger.error("discord.interaction.failed", {
					error: errorMessage(error),
				});
			})
		);
		await client.login(this.#token);
	}

	async stop(): Promise<void> {
		this.#client?.destroy();
		this.#client = undefined;
	}

	async registerCommands(): Promise<void> {
		const application = this.#client?.application;
		if (!application) {
			return;
		}
		await application.commands.set([
			{
				name: "clear",
				description: "Delete inactive Codex bridge threads",
			},
			{
				name: "clear-webhooks",
				description: "Delete webhook-authored messages in this channel",
				options: [
					{
						name: "webhook_url",
						description: "Optional webhook URL to target a single webhook",
						type: 3,
						required: false,
					},
				],
			},
		]);
	}

	async createThread(
		channelId: string,
		name: string,
		sourceMessageId?: string,
	): Promise<string> {
		const channel = await this.#sendableChannel(channelId);
		if (sourceMessageId) {
			const messages = getMessagesManager(channel);
			if (messages) {
				const sourceMessage = await messages.fetch(sourceMessageId);
				if (sourceMessage.startThread) {
					const thread = await sourceMessage.startThread({
						name,
						autoArchiveDuration: 1440,
						reason: "Codex Discord bridge thread",
					});
					if (thread.id) {
						return thread.id;
					}
				}
			}
		}
		const threads = getThreadsManager(channel);
		if (!threads) {
			throw new Error(`Discord channel cannot create threads: ${channelId}`);
		}
		const thread = await threads.create({
			name,
			autoArchiveDuration: 1440,
			reason: "Codex Discord bridge thread",
		});
		if (!thread.id) {
			throw new Error("Discord did not return a thread id");
		}
		return thread.id;
	}

	async sendMessage(channelId: string, text: string): Promise<string[]> {
		const channel = await this.#sendableChannel(channelId);
		const messageIds: string[] = [];
		for (const chunk of splitDiscordMessage(text)) {
			const sent = await channel.send({
				content: chunk,
				allowedMentions: {
					parse: [],
					users: [],
					roles: [],
					repliedUser: false,
				},
			});
			if (typeof sent.id === "string") {
				messageIds.push(sent.id);
			}
		}
		return messageIds;
	}

	async updateMessage(
		channelId: string,
		messageId: string,
		text: string,
	): Promise<void> {
		const channel = await this.#sendableChannel(channelId);
		const messages = getMessagesManager(channel);
		if (!messages) {
			throw new Error(`Discord channel cannot fetch messages: ${channelId}`);
		}
		const message = await messages.fetch(messageId);
		await message.edit({
			content: splitDiscordMessage(text)[0] ?? "",
			allowedMentions: {
				parse: [],
				users: [],
				roles: [],
				repliedUser: false,
			},
		});
	}

	async deleteMessage(channelId: string, messageId: string): Promise<void> {
		const channel = await this.#sendableChannel(channelId);
		const messages = getMessagesManager(channel);
		if (!messages) {
			throw new Error(`Discord channel cannot fetch messages: ${channelId}`);
		}
		const message = await messages.fetch(messageId);
		await message.delete();
	}

	async deleteWebhookMessages(
		channelId: string,
		options: { webhookUrl?: string } = {},
	): Promise<{ deleted: number; failed: number }> {
		const channel = await this.#sendableChannel(channelId);
		const messages = getMessagesManager(channel);
		if (!messages) {
			throw new Error(`Discord channel cannot fetch messages: ${channelId}`);
		}
		const webhookId = options.webhookUrl
			? webhookIdFromUrl(options.webhookUrl)
			: undefined;
		let before: string | undefined;
		let deleted = 0;
		let failed = 0;
		for (;;) {
			const batch = await messages.fetch({ limit: 100, before });
			const fetched = [...batch.values()];
			if (fetched.length === 0) {
				break;
			}
			for (const message of fetched) {
				if (!message.webhookId) {
					continue;
				}
				if (webhookId && message.webhookId !== webhookId) {
					continue;
				}
				try {
					await message.delete();
					deleted += 1;
				} catch (error) {
					failed += 1;
					this.#logger.debug("discord.webhookMessage.deleteFailed", {
						channelId,
						messageId: message.id,
						error: errorMessage(error),
					});
				}
			}
			before = fetched[fetched.length - 1]?.id;
			if (fetched.length < 100 || !before) {
				break;
			}
		}
		return { deleted, failed };
	}

	async deleteThread(channelId: string): Promise<void> {
		const client = this.#client;
		if (!client) {
			throw new Error("Discord bridge is not connected");
		}
		const channel = await client.channels.fetch(channelId);
		if (!channel || !("delete" in channel) || typeof channel.delete !== "function") {
			throw new Error(`Discord channel cannot be deleted: ${channelId}`);
		}
		await channel.delete("Codex Discord bridge clear command");
	}

	async addThreadMembers(channelId: string, userIds: string[]): Promise<void> {
		const channel = await this.#sendableChannel(channelId);
		const members = getThreadMembersManager(channel);
		if (!members) {
			throw new Error(`Discord channel cannot add thread members: ${channelId}`);
		}
		for (const userId of userIds) {
			await members.add(userId);
		}
	}

	async pinMessage(channelId: string, messageId: string): Promise<void> {
		const channel = await this.#sendableChannel(channelId);
		const messages = getMessagesManager(channel);
		if (!messages) {
			throw new Error(`Discord channel cannot fetch messages: ${channelId}`);
		}
		const message = await messages.fetch(messageId);
		if (!message.pin) {
			throw new Error(`Discord message cannot be pinned: ${messageId}`);
		}
		if (message.pinned) {
			return;
		}
		await message.pin();
	}

	async sendTyping(channelId: string): Promise<void> {
		const channel = await this.#sendableChannel(channelId);
		await channel.sendTyping?.();
	}

	#handleMessage(message: Message): void {
		const botUserId = this.#client?.user?.id;
		if (
			botUserId &&
			!isThreadChannel(message.channel) &&
			message.mentions.users.has(botUserId)
		) {
			const mentionedUserIds = message.mentions.users
				.filter((user) => user.id !== botUserId && !user.bot)
				.map((user) => user.id);
			const prompt = stripUserMentions(message.content ?? "", [
				botUserId,
				...mentionedUserIds,
			]);
			this.#handlers?.onInbound({
				kind: "threadStart",
				sourceMessageId: message.id,
				channelId: message.channelId,
				guildId: message.guildId ?? undefined,
				author: {
					id: message.author.id,
					name: message.member?.displayName ||
						message.author.globalName ||
						message.author.username,
					isBot: message.author.bot,
				},
				prompt,
				mentionedUserIds,
				createdAt: message.createdAt.toISOString(),
			});
			return;
		}
		this.#handlers?.onInbound({
			kind: "message",
			channelId: message.channelId,
			guildId: message.guildId ?? undefined,
			messageId: message.id,
			author: {
				id: message.author.id,
				name: message.member?.displayName ||
					message.author.globalName ||
					message.author.username,
				isBot: message.author.bot,
			},
			content: message.content ?? "",
			createdAt: message.createdAt.toISOString(),
		});
	}

	async #handleInteraction(interaction: Interaction): Promise<void> {
		if (!interaction.isChatInputCommand()) {
			return;
		}
		if (
			interaction.commandName !== "clear" &&
			interaction.commandName !== "clear-webhooks"
		) {
			return;
		}
		const channelId = interaction.channelId;
		const reply = async (text: string) => {
			await interaction.reply({
				content: text,
				ephemeral: true,
				allowedMentions: {
					parse: [],
					users: [],
					roles: [],
					repliedUser: false,
				},
			});
		};
		if (interaction.commandName === "clear-webhooks") {
			const webhookUrl = interaction.options.getString("webhook_url") ?? undefined;
			this.#handlers?.onInbound({
				kind: "clearWebhooks",
				channelId,
				guildId: interaction.guildId ?? undefined,
				author: {
					id: interaction.user.id,
					name: interaction.member && "displayName" in interaction.member
						? String(interaction.member.displayName)
						: interaction.user.globalName || interaction.user.username,
					isBot: interaction.user.bot,
				},
				webhookUrl,
				createdAt: new Date().toISOString(),
				reply,
			});
			return;
		}
		this.#handlers?.onInbound({
			kind: "clear",
			channelId,
			guildId: interaction.guildId ?? undefined,
			author: {
				id: interaction.user.id,
				name: interaction.member && "displayName" in interaction.member
					? String(interaction.member.displayName)
					: interaction.user.globalName || interaction.user.username,
				isBot: interaction.user.bot,
			},
			createdAt: new Date().toISOString(),
			reply,
		});
	}

	async #sendableChannel(channelId: string): Promise<SendableChannel> {
		const client = this.#client;
		if (!client) {
			throw new Error("Discord bridge is not connected");
		}
		const channel = await client.channels.fetch(channelId);
		if (!channel || !("send" in channel)) {
			throw new Error(`Discord channel is not text-sendable: ${channelId}`);
		}
		return channel as unknown as SendableChannel;
	}
}

type ThreadCreateOptions = {
	name: string;
	autoArchiveDuration?: number;
	reason?: string;
};

type SendableChannel = {
	id: string;
	send(options: Record<string, unknown>): Promise<{ id?: string }>;
	sendTyping?: () => Promise<void>;
	threads?: {
		create(options: ThreadCreateOptions): Promise<{ id?: string }>;
	};
	members?: {
		add(userId: string): Promise<unknown>;
	};
	messages?: {
		fetch(messageId: string): Promise<DiscordFetchedMessage>;
		fetch(options: {
			limit: number;
			before?: string;
		}): Promise<{ values(): IterableIterator<DiscordFetchedMessage> }>;
	};
};

type DiscordFetchedMessage = {
	id: string;
	webhookId?: string | null;
			delete(): Promise<unknown>;
			edit(options: Record<string, unknown>): Promise<unknown>;
			pinned?: boolean;
			pin?(): Promise<unknown>;
			startThread?(options: ThreadCreateOptions): Promise<{ id?: string }>;
};

function getThreadsManager(
	channel: SendableChannel,
): SendableChannel["threads"] | undefined {
	return channel.threads;
}

function getMessagesManager(
	channel: SendableChannel,
): SendableChannel["messages"] | undefined {
	return channel.messages;
}

function getThreadMembersManager(
	channel: SendableChannel,
): SendableChannel["members"] | undefined {
	return channel.members;
}

function isThreadChannel(channel: unknown): boolean {
	return Boolean(
		channel &&
			typeof channel === "object" &&
			"isThread" in channel &&
			typeof channel.isThread === "function" &&
			channel.isThread(),
	);
}

function stripUserMentions(content: string, userIds: string[]): string {
	let stripped = content;
	for (const userId of userIds) {
		stripped = stripped.replace(new RegExp(`<@!?${escapeRegExp(userId)}>`, "g"), "");
	}
	return stripped.trim();
}

function webhookIdFromUrl(webhookUrl: string): string {
	const parsed = new URL(webhookUrl);
	const match = parsed.pathname.match(/\/webhooks\/(\d+)(?:\/|$)/);
	if (!match?.[1]) {
		throw new Error("Discord webhook URL does not include a webhook id");
	}
	return match[1];
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
