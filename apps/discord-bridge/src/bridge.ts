import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import type { JsonRpcNotification, JsonRpcRequest } from "@peezy.tech/codex-flows/rpc";
import type { JsonValue } from "@peezy.tech/codex-flows/generated/serde_json/JsonValue";
import type { v2 } from "@peezy.tech/codex-flows/generated";

import type { DiscordConsoleOutput } from "./console-output.ts";
import { DiscordThreadRunner, MessageDeduplicator } from "./runner.ts";
import {
	createDiscordBridgeLogger,
	type DiscordBridgeLogger,
} from "./logger.ts";
import type {
	CodexBridgeClient,
	DiscordBridgeConfig,
	DiscordGatewayDelegation,
	DiscordBridgeSession,
	DiscordBridgeState,
	DiscordBridgeStateStore,
	DiscordBridgeTransport,
	DiscordClearInbound,
	DiscordClearWebhooksInbound,
	DiscordInbound,
	DiscordMessageInbound,
	DiscordThreadStartInbound,
} from "./types.ts";

const maxDiscordMessageLength = 2000;
const gatewayToolsVersion = 1;

type ThreadSnapshot = {
	terminalTurnIds: string[];
	lastFinal?: {
		turnId: string;
		text: string;
	};
};

export class DiscordCodexBridge {
	readonly client: CodexBridgeClient;
	readonly transport: DiscordBridgeTransport;
	readonly store: DiscordBridgeStateStore;
	readonly config: DiscordBridgeConfig;
	#state: DiscordBridgeState | undefined;
	#runnersByDiscordThread = new Map<string, DiscordThreadRunner>();
	#runnersByCodexThread = new Map<string, DiscordThreadRunner>();
	#persistChain: Promise<void> = Promise.resolve();
	#now: () => Date;
	#dedupe: MessageDeduplicator;
	#logger: DiscordBridgeLogger;
	#consoleOutput: DiscordConsoleOutput | undefined;

	constructor(options: {
		client: CodexBridgeClient;
		transport: DiscordBridgeTransport;
		store: DiscordBridgeStateStore;
		config: DiscordBridgeConfig;
		now?: () => Date;
		logger?: DiscordBridgeLogger;
		consoleOutput?: DiscordConsoleOutput;
	}) {
		this.client = options.client;
		this.transport = options.transport;
		this.store = options.store;
		this.config = options.config;
		this.#now = options.now ?? (() => new Date());
		this.#dedupe = new MessageDeduplicator({ now: this.#now });
		this.#logger = options.logger ??
			createDiscordBridgeLogger({
				debug: this.config.debug,
				logLevel: this.config.logLevel,
				now: this.#now,
			});
		this.#consoleOutput = options.consoleOutput;
	}

	async start(): Promise<void> {
		this.#state = await this.store.load();
		for (const session of this.#state.sessions) {
			this.#registerRunner(session);
		}
		this.#debug("bridge.start", {
			sessions: this.#state.sessions.length,
			queue: this.#state.queue.length,
			deliveries: this.#state.deliveries.length,
			allowedUsers: this.config.allowedUserIds.size,
			allowedChannels: this.config.allowedChannelIds.size,
			cwd: this.config.cwd,
			summary: this.config.summary,
		});
		this.client.on("notification", (message) => {
			void this.#handleNotification(message).catch((error) => {
				this.#debug("notification.error", {
					method: message.method,
					error: errorMessage(error),
				});
				this.#error("notification.failed", {
					method: message.method,
					error: errorMessage(error),
				});
			});
		});
		this.client.on("request", (message) => this.#handleServerRequest(message));
		await this.client.connect();
		this.#debug("client.connected");
		await this.#ensureGatewaySession();
		await this.transport.start({
			onInbound: (inbound) => {
				void this.#handleInbound(inbound).catch((error) => {
					this.#debug("inbound.error", {
						kind: inbound.kind,
						channelId: inbound.channelId,
						error: errorMessage(error),
					});
					this.#error("inbound.failed", {
						kind: inbound.kind,
						channelId: inbound.channelId,
						error: errorMessage(error),
					});
				});
			},
		});
		this.#debug("transport.started");
		await this.transport.registerCommands();
		this.#debug("commands.registered");
		for (const runner of this.#runnersByDiscordThread.values()) {
			runner.start();
		}
	}

	async stop(): Promise<void> {
		this.#debug("bridge.stop", {
			runners: this.#runnersByDiscordThread.size,
		});
		await Promise.all(
			[...this.#runnersByDiscordThread.values()].map((runner) => runner.stop()),
		);
		await this.#persistChain.catch(() => undefined);
		await this.transport.stop();
		this.client.close();
	}

	stateForTest(): DiscordBridgeState {
		return structuredClone(this.#requireState());
	}

	async flushSummariesForTest(): Promise<void> {
		await Promise.all(
			[...this.#runnersByDiscordThread.values()].map((runner) =>
				runner.flushSummariesForTest()
			),
		);
	}

	async #handleInbound(inbound: DiscordInbound): Promise<void> {
		this.#debug("inbound.received", {
			kind: inbound.kind,
			channelId: inbound.channelId,
			authorId: inbound.author.id,
			isBot: inbound.author.isBot,
			messageId: inbound.kind === "message" ? inbound.messageId : undefined,
			sourceMessageId: inbound.kind === "threadStart" ? inbound.sourceMessageId : undefined,
			contentLength: inbound.kind === "message"
				? inbound.content.length
				: inbound.kind === "threadStart"
				? inbound.prompt?.length
				: undefined,
			mentionedUserIds: inbound.kind === "threadStart"
				? inbound.mentionedUserIds?.length
				: undefined,
		});
		if (inbound.author.isBot) {
			this.#debug("inbound.ignored.bot", {
				kind: inbound.kind,
				channelId: inbound.channelId,
				authorId: inbound.author.id,
			});
			return;
		}

		if (inbound.kind === "clear") {
			await this.#handleClear(inbound);
			return;
		}
		if (inbound.kind === "clearWebhooks") {
			await this.#handleClearWebhooks(inbound);
			return;
		}

		if (inbound.kind === "threadStart") {
			if (this.config.gateway?.homeChannelId === inbound.channelId) {
				await this.#handleGatewayThreadStart(inbound);
				return;
			}
			if (!this.config.allowedUserIds.has(inbound.author.id)) {
				this.#debug("threadStart.ignored.user", {
					channelId: inbound.channelId,
					authorId: inbound.author.id,
				});
				return;
			}
			if (!this.#isAllowedInboundChannel(inbound)) {
				this.#debug("threadStart.ignored.channel", {
					channelId: inbound.channelId,
				});
				return;
			}
			await this.#handleThreadStart(inbound);
			return;
		}
		await this.#handleMessage(inbound);
	}

	async #handleClear(command: DiscordClearInbound): Promise<void> {
		if (!this.config.allowedUserIds.has(command.author.id)) {
			this.#debug("clear.ignored.user", {
				channelId: command.channelId,
				authorId: command.author.id,
			});
			await command.reply?.("Only globally allowed Discord users can clear bridge threads.");
			return;
		}
		if (!this.transport.deleteThread) {
			this.#debug("clear.unsupported", { channelId: command.channelId });
			await command.reply?.("This Discord transport cannot delete threads.");
			return;
		}
		const state = this.#requireState();
		const scopedSessions = state.sessions.filter((session) =>
			this.#isSessionInClearScope(session, command)
		);
		const inactive = scopedSessions.filter((session) =>
			!this.#isSessionRunning(session, state)
		);
		const runningCount = scopedSessions.length - inactive.length;
		const deletedThreadIds: string[] = [];
		const failed: Array<{ threadId: string; error: string }> = [];
		this.#debug("clear.start", {
			channelId: command.channelId,
			guildId: command.guildId,
			scoped: scopedSessions.length,
			inactive: inactive.length,
			running: runningCount,
		});
		for (const session of inactive) {
			try {
				await this.transport.deleteThread(session.discordThreadId);
				await this.#deleteSourceMessage(session);
				deletedThreadIds.push(session.discordThreadId);
				const runner = this.#runnersByDiscordThread.get(session.discordThreadId);
				await runner?.stop();
				this.#runnersByDiscordThread.delete(session.discordThreadId);
				this.#runnersByCodexThread.delete(session.codexThreadId);
				this.#debug("clear.threadDeleted", {
					discordThreadId: session.discordThreadId,
					codexThreadId: session.codexThreadId,
				});
			} catch (error) {
				const message = errorMessage(error);
				failed.push({ threadId: session.discordThreadId, error: message });
				this.#debug("clear.threadDeleteFailed", {
					discordThreadId: session.discordThreadId,
					codexThreadId: session.codexThreadId,
					error: message,
				});
			}
		}
		if (deletedThreadIds.length > 0) {
			const deleted = new Set(deletedThreadIds);
			state.sessions = state.sessions.filter(
				(session) => !deleted.has(session.discordThreadId),
			);
			state.queue = state.queue.filter(
				(item) => !deleted.has(item.discordThreadId),
			);
			state.activeTurns = state.activeTurns.filter(
				(active) => !deleted.has(active.discordThreadId),
			);
			state.deliveries = state.deliveries.filter(
				(delivery) => !deleted.has(delivery.discordThreadId),
			);
			await this.#persist();
		}
		await command.reply?.(clearSummary({
			deleted: deletedThreadIds.length,
			running: runningCount,
			failed: failed.length,
		}));
	}

	async #handleClearWebhooks(command: DiscordClearWebhooksInbound): Promise<void> {
		if (!this.config.allowedUserIds.has(command.author.id)) {
			this.#debug("clearWebhooks.ignored.user", {
				channelId: command.channelId,
				authorId: command.author.id,
			});
			await command.reply?.(
				"Only globally allowed Discord users can clear webhook messages.",
			);
			return;
		}
		if (!this.transport.deleteWebhookMessages) {
			this.#debug("clearWebhooks.unsupported", { channelId: command.channelId });
			await command.reply?.("This Discord transport cannot delete webhook messages.");
			return;
		}
		this.#debug("clearWebhooks.start", {
			channelId: command.channelId,
			guildId: command.guildId,
			filtered: Boolean(command.webhookUrl),
		});
		let result: { deleted: number; failed: number };
		try {
			result = await this.transport.deleteWebhookMessages(command.channelId, {
				webhookUrl: command.webhookUrl,
			});
		} catch (error) {
			const message = errorMessage(error);
			this.#debug("clearWebhooks.failed", {
				channelId: command.channelId,
				error: message,
			});
			await command.reply?.(`Failed to clear webhook messages: ${message}`);
			return;
		}
		this.#debug("clearWebhooks.complete", {
			channelId: command.channelId,
			deleted: result.deleted,
			failed: result.failed,
		});
		await command.reply?.(clearWebhooksSummary(result));
	}

	async #handleThreadStart(start: DiscordThreadStartInbound): Promise<void> {
		const state = this.#requireState();
		if (
			this.#dedupe.isDuplicate(start.sourceMessageId) ||
			isDuplicate(state, start.sourceMessageId)
		) {
			this.#debug("threadStart.ignored.duplicate", {
				channelId: start.channelId,
				sourceMessageId: start.sourceMessageId,
			});
			return;
		}
		const participantUserIds = normalizeParticipantUserIds(
			start.mentionedUserIds,
			start.author.id,
		);
		const intent = parseThreadStartIntent(threadPrompt(start));
		if (intent.kind === "invalid") {
			await start.reply?.(intent.message);
			this.#debug("threadStart.ignored.invalidIntent", {
				channelId: start.channelId,
				sourceMessageId: start.sourceMessageId,
				message: intent.message,
			});
			return;
		}
		const title = intent.kind === "resume"
			? resumeThreadTitle(start, intent.codexThreadId)
			: threadTitle(start, intent.prompt);
		this.#debug("threadStart.start", {
			channelId: start.channelId,
			sourceMessageId: start.sourceMessageId,
			title,
			intent: intent.kind,
			cwd: intent.cwd,
			hasPrompt: intent.kind === "new" && Boolean(intent.prompt),
			participantUserIds,
		});
		const discordThreadId = await this.transport.createThread(
			start.channelId,
			title,
			start.sourceMessageId,
		);
		this.#debug("discord.thread.created", {
			parentChannelId: start.channelId,
			discordThreadId,
			title,
		});
		const started = intent.kind === "resume"
			? await this.client.resumeThread(this.#threadResumeParams(intent.codexThreadId, intent.cwd))
			: await this.client.startThread(this.#threadStartParams(intent.cwd));
		const codexThreadId = started.thread.id;
		if (intent.kind === "new") {
			await this.client.setThreadName({
				threadId: codexThreadId,
				name: `[discord] ${title}`,
			});
		}
		const sessionCwd = intent.kind === "resume"
			? intent.cwd ?? resumeResponseCwd(started)
			: intent.cwd;
		const session: DiscordBridgeSession = {
			discordThreadId,
			parentChannelId: start.channelId,
			guildId: start.guildId,
			sourceMessageId: start.sourceMessageId,
			codexThreadId,
			title,
			createdAt: this.#now().toISOString(),
			ownerUserId: start.author.id,
			participantUserIds,
			cwd: sessionCwd,
			mode: intent.kind === "resume" ? "resumed" : "new",
		};
		await this.#addThreadMembers(discordThreadId, participantUserIds);
		state.sessions.push(session);
		const runner = this.#registerRunner(session);
		await this.#persist();
		await runner.ensureStatusMessage();
		await start.reply?.(`${intent.kind === "resume" ? "Resumed" : "Started"} Codex thread ${compactId(codexThreadId)} in <#${discordThreadId}>.`);
		this.#debug("threadStart.acknowledged", {
			discordThreadId,
			codexThreadId,
		});

		if (intent.kind === "resume") {
			const snapshot = mergeThreadSnapshots(
				await this.#readThreadSnapshot(codexThreadId),
				threadSnapshotFromThread(started.thread),
			);
			const outboundMessageIds = snapshot.lastFinal
				? await this.transport.sendMessage(discordThreadId, snapshot.lastFinal.text)
				: await this.transport.sendMessage(
						discordThreadId,
						"No final assistant message found for this Codex thread.",
					);
			this.#recordResumeHistoryDeliveries(
				session,
				start.sourceMessageId,
				snapshot,
				outboundMessageIds,
			);
			await this.#persist();
			if (snapshot.lastFinal) {
				this.#debug("threadStart.resumeFinalReplayed", {
					discordThreadId,
					codexThreadId,
					turnId: snapshot.lastFinal.turnId,
					outboundMessageIds,
					terminalTurns: snapshot.terminalTurnIds.length,
				});
			} else {
				this.#debug("threadStart.resumeFinalMissing", {
					discordThreadId,
					codexThreadId,
					terminalTurns: snapshot.terminalTurnIds.length,
				});
			}
			runner.start();
			return;
		}

		if (intent.prompt) {
			this.#debug("threadStart.enqueuePrompt", {
				discordThreadId,
				codexThreadId,
				promptLength: intent.prompt.length,
			});
			await runner.enqueueMessage({
				kind: "message",
				channelId: discordThreadId,
				messageId: start.sourceMessageId,
				author: start.author,
				content: intent.prompt,
				createdAt: start.createdAt,
			});
		} else {
			runner.start();
		}
	}

	async #handleMessage(message: DiscordMessageInbound): Promise<void> {
		if (this.#dedupe.isDuplicate(message.messageId)) {
			this.#debug("message.ignored.rawDuplicate", {
				channelId: message.channelId,
				messageId: message.messageId,
			});
			return;
		}
		if (this.config.gateway?.homeChannelId === message.channelId) {
			await this.#handleGatewayMessage(message);
			return;
		}
		const runner = this.#runnersByDiscordThread.get(message.channelId);
		if (!runner) {
			this.#debug("message.ignored.noSession", {
				channelId: message.channelId,
				messageId: message.messageId,
			});
			return;
		}
		if (!this.#isAllowedInboundChannel(message)) {
			this.#debug("message.ignored.channel", {
				channelId: message.channelId,
				messageId: message.messageId,
			});
			return;
		}
		if (!this.#isAllowedSessionUser(runner.session, message.author.id)) {
			this.#debug("message.ignored.user", {
				channelId: message.channelId,
				messageId: message.messageId,
				authorId: message.author.id,
				ownerUserId: runner.session.ownerUserId,
				participantUserIds: runner.session.participantUserIds,
			});
			return;
		}
		await runner.enqueueMessage(message);
	}

	async #handleGatewayThreadStart(start: DiscordThreadStartInbound): Promise<void> {
		await this.#handleGatewayMessage({
			kind: "message",
			channelId: start.channelId,
			guildId: start.guildId,
			messageId: start.sourceMessageId,
			author: start.author,
			content: threadPrompt(start),
			createdAt: start.createdAt,
		});
	}

	async #handleGatewayMessage(message: DiscordMessageInbound): Promise<void> {
		if (!this.config.allowedUserIds.has(message.author.id)) {
			this.#debug("gateway.message.ignored.user", {
				channelId: message.channelId,
				messageId: message.messageId,
				authorId: message.author.id,
			});
			return;
		}
		const command = parseGatewayCommand(message.content);
		if (command === "status") {
			await this.transport.sendMessage(
				message.channelId,
				this.#gatewayStatusMessage(),
			);
			addProcessedMessageId(this.#requireState(), message.messageId);
			await this.#persist();
			return;
		}
		const runner = this.#gatewayRunner();
		if (!runner) {
			this.#debug("gateway.message.ignored.noSession", {
				channelId: message.channelId,
				messageId: message.messageId,
			});
			return;
		}
		await runner.enqueueMessage(message);
	}

	#gatewayStatusMessage(): string {
		const state = this.#requireState();
		const gateway = state.gateway;
		const session = this.#gatewaySession();
		const delegations = gateway?.delegations ?? [];
		const activeDelegations = delegations.filter((delegation) =>
			delegation.status === "active"
		);
		return [
			"**Codex Gateway**",
			`Home channel: \`${this.config.gateway?.homeChannelId ?? "disabled"}\``,
			`Main thread: \`${session?.codexThreadId ?? gateway?.mainThreadId ?? "none"}\``,
			`Dir: \`${session?.cwd ?? this.config.cwd ?? "default"}\``,
			`Legacy thread bridge: \`enabled\``,
			`Delegations: ${delegations.length} tracked, ${activeDelegations.length} active`,
			"",
			"**Delegation Backend**",
			`Status: ${state.gateway?.toolsVersion === gatewayToolsVersion ? "privileged gateway tools available to the main Codex operator thread" : "waiting for a tool-enabled main Codex operator thread"}.`,
			`Flow backend: \`${this.config.flowBackendUrl ?? "not configured"}\``,
			"",
			"**Detail Threads**",
			"Status: optional detail-thread records are supported in state; automatic detail thread mirroring is not enabled yet.",
		].join("\n");
	}

	async #handleNotification(message: JsonRpcNotification): Promise<void> {
		const params = record(message.params);
		const threadId = stringValue(params.threadId);
		if (!threadId) {
			this.#debug("notification.ignored.missingThread", {
				method: message.method,
			});
			return;
		}
		const runner = this.#runnersByCodexThread.get(threadId);
		if (!runner) {
			this.#debug("notification.ignored.noRunner", {
				method: message.method,
				threadId,
			});
			return;
		}
		await runner.handleNotification(message);
	}

	#handleServerRequest(message: JsonRpcRequest): void {
		if (message.method === "item/tool/call") {
			void this.#handleDynamicToolCall(message).catch((error) => {
				this.client.respondError(
					message.id,
					-32603,
					errorMessage(error),
				);
			});
			return;
		}
		this.client.respondError(message.id, -32603, "Unsupported app-server request");
	}

	async #handleDynamicToolCall(message: JsonRpcRequest): Promise<void> {
		const params = record(message.params);
		const threadId = stringValue(params.threadId);
		const namespace = stringValue(params.namespace);
		const tool = stringValue(params.tool);
		if (
			!threadId ||
			threadId !== this.#gatewaySession()?.codexThreadId ||
			namespace !== "codex_gateway" ||
			!tool
		) {
			this.client.respondError(
				message.id,
				-32601,
				"Unknown dynamic tool request",
			);
			return;
		}
		const result = await this.#callGatewayTool(tool, record(params.arguments));
		this.client.respond(message.id, {
			contentItems: [
				{
					type: "inputText",
					text: JSON.stringify(result, null, 2),
				},
			],
			success: true,
		});
	}

	async #callGatewayTool(
		tool: string,
		args: Record<string, unknown>,
	): Promise<unknown> {
		if (tool === "list_delegations") {
			return {
				delegations: this.#gatewayDelegations(),
			};
		}
		if (tool === "start_delegation") {
			return await this.#startDelegation(args);
		}
		if (tool === "resume_delegation") {
			return await this.#resumeDelegation(args);
		}
		if (tool === "send_delegation") {
			return await this.#sendDelegation(args);
		}
		if (tool === "read_delegation") {
			return await this.#readDelegation(args);
		}
		if (tool === "list_flow_runs") {
			return await this.#flowBackendGet("/runs", args);
		}
		if (tool === "list_flow_events") {
			return await this.#flowBackendGet("/events", args);
		}
		throw new Error(`Unknown gateway tool: ${tool}`);
	}

	#registerRunner(session: DiscordBridgeSession): DiscordThreadRunner {
		const existing = this.#runnersByDiscordThread.get(session.discordThreadId);
		if (existing) {
			return existing;
		}
		const runner = new DiscordThreadRunner(session, {
			client: this.client,
			transport: this.transport,
			config: this.config,
			getState: () => this.#requireState(),
			persist: () => this.#persist(),
			now: () => this.#now(),
			debug: (event, fields = {}) => this.#debug(event, fields),
			consoleOutput: this.#consoleOutput,
		});
		this.#runnersByDiscordThread.set(session.discordThreadId, runner);
		this.#runnersByCodexThread.set(session.codexThreadId, runner);
		return runner;
	}

	async #ensureGatewaySession(): Promise<void> {
		const gatewayConfig = this.config.gateway;
		if (!gatewayConfig) {
			return;
		}
		const state = this.#requireState();
		const existing = this.#gatewaySession();
		const shouldReuseExisting =
			Boolean(gatewayConfig.mainThreadId) ||
			state.gateway?.toolsVersion === gatewayToolsVersion;
		if (existing && shouldReuseExisting) {
			state.gateway = {
				homeChannelId: gatewayConfig.homeChannelId,
				mainThreadId: existing.codexThreadId,
				statusMessageId: existing.statusMessageId,
				createdAt: existing.createdAt,
				toolsVersion: state.gateway?.toolsVersion,
				delegations: state.gateway?.delegations ?? [],
			};
			this.#registerRunner(existing);
			await this.#persist();
			return;
		}
		if (existing) {
			state.sessions = state.sessions.filter((session) => session !== existing);
			this.#runnersByDiscordThread.delete(existing.discordThreadId);
			this.#runnersByCodexThread.delete(existing.codexThreadId);
		}

		const configuredThreadId =
			gatewayConfig.mainThreadId ??
			(state.gateway?.toolsVersion === gatewayToolsVersion
				? state.gateway.mainThreadId
				: undefined);
		const title = "Codex Gateway";
		const started = configuredThreadId
			? await this.client.resumeThread(this.#threadResumeParams(
					configuredThreadId,
					this.config.cwd,
				))
			: await this.client.startThread({
					...this.#threadStartParams(this.config.cwd),
					dynamicTools: gatewayToolSpecs(),
				});
		const codexThreadId = started.thread.id;
		if (!configuredThreadId) {
			await this.client.setThreadName({
				threadId: codexThreadId,
				name: "[discord-gateway] Codex Gateway",
			});
		}
		const session: DiscordBridgeSession = {
			discordThreadId: gatewayConfig.homeChannelId,
			parentChannelId: gatewayConfig.homeChannelId,
			codexThreadId,
			title,
			createdAt: this.#now().toISOString(),
			cwd: resumeResponseCwd(started) ?? this.config.cwd,
			mode: "gateway",
		};
		state.gateway = {
			homeChannelId: gatewayConfig.homeChannelId,
			mainThreadId: codexThreadId,
			createdAt: session.createdAt,
			toolsVersion: configuredThreadId
				? state.gateway?.toolsVersion
				: gatewayToolsVersion,
			delegations: state.gateway?.delegations ?? [],
		};
		state.sessions.push(session);
		this.#registerRunner(session);
		await this.#persist();
		this.#debug("gateway.session.ready", {
			homeChannelId: gatewayConfig.homeChannelId,
			codexThreadId,
			resumed: Boolean(configuredThreadId),
		});
	}

	#gatewaySession(): DiscordBridgeSession | undefined {
		const gatewayConfig = this.config.gateway;
		if (!gatewayConfig) {
			return undefined;
		}
		return this.#requireState().sessions.find((session) =>
			session.mode === "gateway" &&
			session.discordThreadId === gatewayConfig.homeChannelId
		);
	}

	#gatewayRunner(): DiscordThreadRunner | undefined {
		const session = this.#gatewaySession();
		return session
			? this.#runnersByDiscordThread.get(session.discordThreadId)
			: undefined;
	}

	#gatewayDelegations(): DiscordGatewayDelegation[] {
		const state = this.#requireState();
		if (!state.gateway) {
			state.gateway = {
				homeChannelId: this.config.gateway?.homeChannelId ?? "",
				mainThreadId: this.#gatewaySession()?.codexThreadId,
				delegations: [],
			};
		}
		state.gateway.delegations ??= [];
		return state.gateway.delegations;
	}

	async #startDelegation(args: Record<string, unknown>): Promise<unknown> {
		const cwd = requiredArg(args, "cwd");
		const title = stringValue(args.title) ?? firstLine(stringValue(args.prompt)) ??
			`Delegated ${compactId(cwd)}`;
		const prompt = stringValue(args.prompt);
		const started = await this.client.startThread(this.#threadStartParams(cwd));
		const codexThreadId = started.thread.id;
		await this.client.setThreadName({
			threadId: codexThreadId,
			name: `[delegated] ${title}`,
		});
		const now = this.#now().toISOString();
		const delegation = this.#upsertDelegation({
			id: delegationId(codexThreadId),
			codexThreadId,
			title,
			status: prompt ? "active" : "idle",
			cwd,
			discordDetailThreadId: stringValue(args.discordDetailThreadId),
			parentDiscordMessageId: stringValue(args.parentDiscordMessageId),
			createdAt: now,
			updatedAt: now,
		});
		let turnId: string | undefined;
		if (prompt) {
			const turn = await this.client.startTurn({
				threadId: codexThreadId,
				input: [{ type: "text", text: prompt, text_elements: [] }],
				cwd,
				model: this.config.model ?? null,
				serviceTier: this.config.serviceTier ?? null,
				effort: this.config.effort ?? null,
				summary: this.config.summary ?? null,
				approvalPolicy: this.config.approvalPolicy ?? null,
				permissions: this.config.permissions ?? null,
				outputSchema: null,
			});
			turnId = turn.turn.id;
		}
		await this.#persist();
		return { delegation, turnId };
	}

	async #resumeDelegation(args: Record<string, unknown>): Promise<unknown> {
		const codexThreadId = requiredArg(args, "threadId");
		const cwd = stringValue(args.cwd);
		const resumed = await this.client.resumeThread(this.#threadResumeParams(codexThreadId, cwd));
		const now = this.#now().toISOString();
		const delegation = this.#upsertDelegation({
			id: stringValue(args.id) ?? delegationId(codexThreadId),
			codexThreadId,
			title: stringValue(args.title) ?? `Delegated ${compactId(codexThreadId)}`,
			status: "idle",
			cwd: cwd ?? resumeResponseCwd(resumed),
			discordDetailThreadId: stringValue(args.discordDetailThreadId),
			parentDiscordMessageId: stringValue(args.parentDiscordMessageId),
			createdAt: this.#delegationForThread(codexThreadId)?.createdAt ?? now,
			updatedAt: now,
		});
		await this.#persist();
		return { delegation };
	}

	async #sendDelegation(args: Record<string, unknown>): Promise<unknown> {
		const delegation = this.#requireDelegation(args);
		const prompt = requiredArg(args, "prompt");
		const turn = await this.client.startTurn({
			threadId: delegation.codexThreadId,
			input: [{ type: "text", text: prompt, text_elements: [] }],
			cwd: delegation.cwd ?? null,
			model: this.config.model ?? null,
			serviceTier: this.config.serviceTier ?? null,
			effort: this.config.effort ?? null,
			summary: this.config.summary ?? null,
			approvalPolicy: this.config.approvalPolicy ?? null,
			permissions: this.config.permissions ?? null,
			outputSchema: null,
		});
		delegation.status = "active";
		delegation.updatedAt = this.#now().toISOString();
		await this.#persist();
		return { delegation, turnId: turn.turn.id };
	}

	async #readDelegation(args: Record<string, unknown>): Promise<unknown> {
		const delegation = this.#requireDelegation(args);
		const response = await this.client.readThread({
			threadId: delegation.codexThreadId,
			includeTurns: true,
		});
		const snapshot = threadSnapshotFromThread(response.thread);
		const turns = Array.isArray(response.thread.turns) ? response.thread.turns : [];
		const latest = record(turns[turns.length - 1]);
		const latestStatus = stringValue(latest.status);
		if (latestStatus === "completed") {
			delegation.status = "idle";
		} else if (latestStatus === "failed" || latestStatus === "interrupted") {
			delegation.status = "failed";
		} else if (latestStatus) {
			delegation.status = "active";
		}
		delegation.updatedAt = this.#now().toISOString();
		await this.#persist();
		return {
			delegation,
			latestTurnId: stringValue(latest.id),
			latestStatus,
			lastFinal: snapshot.lastFinal,
			terminalTurnIds: snapshot.terminalTurnIds,
		};
	}

	async #flowBackendGet(
		pathname: string,
		args: Record<string, unknown>,
	): Promise<unknown> {
		const baseUrl = this.config.flowBackendUrl;
		if (!baseUrl) {
			throw new Error("No flow backend URL configured.");
		}
		const url = new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
		for (const [key, value] of Object.entries(args)) {
			if (value !== undefined && value !== null) {
				url.searchParams.set(key, String(value));
			}
		}
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`Flow backend ${url.pathname} failed with ${response.status}`);
		}
		return await response.json();
	}

	#upsertDelegation(input: DiscordGatewayDelegation): DiscordGatewayDelegation {
		const delegations = this.#gatewayDelegations();
		const index = delegations.findIndex((delegation) =>
			delegation.id === input.id ||
			delegation.codexThreadId === input.codexThreadId
		);
		if (index >= 0) {
			delegations[index] = { ...delegations[index], ...input };
			return delegations[index] as DiscordGatewayDelegation;
		}
		delegations.push(input);
		return input;
	}

	#requireDelegation(args: Record<string, unknown>): DiscordGatewayDelegation {
		const id = stringValue(args.delegationId) ?? stringValue(args.id);
		const threadId = stringValue(args.threadId);
		const delegation = this.#gatewayDelegations().find((candidate) =>
			(id && candidate.id === id) ||
			(threadId && candidate.codexThreadId === threadId)
		);
		if (!delegation) {
			throw new Error("Unknown gateway delegation.");
		}
		return delegation;
	}

	#delegationForThread(threadId: string): DiscordGatewayDelegation | undefined {
		return this.#gatewayDelegations().find((delegation) =>
			delegation.codexThreadId === threadId
		);
	}

	#isSessionRunning(
		session: DiscordBridgeSession,
		state: DiscordBridgeState,
	): boolean {
		const hasActiveTurn = state.activeTurns.some(
			(active) =>
				active.discordThreadId === session.discordThreadId &&
				active.codexThreadId === session.codexThreadId,
		);
		if (hasActiveTurn) {
			return true;
		}
		return state.queue.some(
			(item) =>
				item.discordThreadId === session.discordThreadId &&
				item.codexThreadId === session.codexThreadId &&
				item.status !== "failed",
		);
	}

	#isAllowedChannel(channelId: string): boolean {
		if (this.config.allowedChannelIds.size === 0) {
			return true;
		}
		if (this.config.allowedChannelIds.has(channelId)) {
			return true;
		}
		const session = this.#requireState().sessions.find(
			(candidate) => candidate.discordThreadId === channelId,
		);
		return Boolean(
			session && this.config.allowedChannelIds.has(session.parentChannelId),
		);
	}

	#isAllowedInboundChannel(
		inbound: DiscordMessageInbound | DiscordThreadStartInbound,
	): boolean {
		if (!inbound.guildId && this.config.allowedUserIds.has(inbound.author.id)) {
			return true;
		}
		return this.#isAllowedChannel(inbound.channelId);
	}

	#isAllowedSessionUser(session: DiscordBridgeSession, userId: string): boolean {
		return (
			this.config.allowedUserIds.has(userId) ||
			session.ownerUserId === userId ||
			Boolean(session.participantUserIds?.includes(userId))
		);
	}

	#isSessionInClearScope(
		session: DiscordBridgeSession,
		command: DiscordClearInbound,
	): boolean {
		if (!command.guildId) {
			return true;
		}
		return session.guildId === command.guildId ||
			(!session.guildId && session.parentChannelId === command.channelId);
	}

	async #addThreadMembers(
		discordThreadId: string,
		participantUserIds: string[],
	): Promise<void> {
		if (participantUserIds.length === 0 || !this.transport.addThreadMembers) {
			return;
		}
		try {
			await this.transport.addThreadMembers(discordThreadId, participantUserIds);
			this.#debug("discord.thread.members.added", {
				discordThreadId,
				participantUserIds,
			});
		} catch (error) {
			this.#debug("discord.thread.members.addFailed", {
				discordThreadId,
				participantUserIds,
				error: errorMessage(error),
			});
		}
	}

	async #deleteSourceMessage(session: DiscordBridgeSession): Promise<void> {
		if (!session.sourceMessageId) {
			return;
		}
		try {
			await this.transport.deleteMessage(
				session.parentChannelId,
				session.sourceMessageId,
			);
			this.#debug("clear.sourceMessageDeleted", {
				parentChannelId: session.parentChannelId,
				sourceMessageId: session.sourceMessageId,
				discordThreadId: session.discordThreadId,
			});
		} catch (error) {
			this.#debug("clear.sourceMessageDeleteFailed", {
				parentChannelId: session.parentChannelId,
				sourceMessageId: session.sourceMessageId,
				discordThreadId: session.discordThreadId,
				error: errorMessage(error),
			});
		}
	}

	#threadStartParams(cwd: string | undefined): v2.ThreadStartParams {
		return {
			cwd: cwd ?? this.config.cwd ?? null,
			model: this.config.model ?? null,
			modelProvider: this.config.modelProvider ?? null,
			serviceTier: this.config.serviceTier ?? null,
			approvalPolicy: this.config.approvalPolicy ?? null,
			sandbox: this.config.sandbox ?? null,
			permissions: this.config.permissions ?? null,
			threadSource: "user",
			experimentalRawEvents: false,
			persistExtendedHistory: false,
		};
	}

	#threadResumeParams(
		threadId: string,
		cwd: string | undefined,
	): v2.ThreadResumeParams {
		return {
			threadId,
			cwd: cwd ?? null,
			model: this.config.model ?? null,
			modelProvider: this.config.modelProvider ?? null,
			serviceTier: this.config.serviceTier ?? null,
			approvalPolicy: this.config.approvalPolicy ?? null,
			sandbox: this.config.sandbox ?? null,
			permissions: this.config.permissions ?? null,
			persistExtendedHistory: false,
		};
	}

	async #readThreadSnapshot(threadId: string): Promise<ThreadSnapshot> {
		try {
			const response = await this.client.readThread({
				threadId,
				includeTurns: true,
			});
			return threadSnapshotFromThread(response.thread);
		} catch (error) {
			this.#debug("thread.final.readFailed", {
				threadId,
				error: errorMessage(error),
			});
			return emptyThreadSnapshot();
		}
	}

	#recordResumeHistoryDeliveries(
		session: DiscordBridgeSession,
		sourceMessageId: string,
		snapshot: ThreadSnapshot,
		lastFinalOutboundMessageIds: string[],
	): void {
		const state = this.#requireState();
		addProcessedMessageId(state, sourceMessageId);
		for (const turnId of snapshot.terminalTurnIds) {
			if (
				state.deliveries.some((delivery) =>
					delivery.discordThreadId === session.discordThreadId &&
					delivery.codexThreadId === session.codexThreadId &&
					delivery.turnId === turnId &&
					delivery.kind === "final"
				)
			) {
				continue;
			}
			state.deliveries.push({
				discordMessageId: `resume:${sourceMessageId}:${turnId}`,
				discordThreadId: session.discordThreadId,
				codexThreadId: session.codexThreadId,
				turnId,
				kind: "final",
				outboundMessageIds: turnId === snapshot.lastFinal?.turnId
					? lastFinalOutboundMessageIds
					: [],
				deliveredAt: this.#now().toISOString(),
			});
		}
	}

	async #persist(): Promise<void> {
		const save = this.#persistChain
			.catch(() => undefined)
			.then(async () => {
				await this.store.save(this.#requireState());
				this.#debug("state.persisted", {
					sessions: this.#requireState().sessions.length,
					queue: this.#requireState().queue.length,
					deliveries: this.#requireState().deliveries.length,
					processed: this.#requireState().processedMessageIds.length,
				});
			});
		this.#persistChain = save;
		await save;
	}

	#requireState(): DiscordBridgeState {
		if (!this.#state) {
			throw new Error("Discord bridge is not started");
		}
		return this.#state;
	}

	#debug(event: string, fields: Record<string, unknown> = {}): void {
		this.#logger.debug(event, fields);
	}

	#error(event: string, fields: Record<string, unknown> = {}): void {
		this.#logger.error(event, fields);
	}
}

export function splitDiscordMessage(text: string): string[] {
	const chunks: string[] = [];
	let remaining = text.trim();
	while (remaining.length > maxDiscordMessageLength) {
		const splitAt = bestSplitIndex(remaining, maxDiscordMessageLength);
		chunks.push(remaining.slice(0, splitAt).trimEnd());
		remaining = remaining.slice(splitAt).trimStart();
	}
	if (remaining) {
		chunks.push(remaining);
	}
	return chunks.length > 0 ? chunks : [""];
}

function threadTitle(command: DiscordThreadStartInbound, prompt = threadPrompt(command)): string {
	return truncateDiscordThreadName(
		command.title?.trim() ||
			firstLine(prompt) ||
			`Codex ${command.author.name}`,
	);
}

function threadPrompt(command: DiscordThreadStartInbound): string {
	let prompt = command.prompt ?? "";
	for (const userId of command.mentionedUserIds ?? []) {
		prompt = prompt.replace(new RegExp(`<@!?${escapeRegExp(userId)}>`, "g"), "");
	}
	return prompt.trim();
}

type ThreadStartIntent =
	| { kind: "new"; prompt: string; cwd?: string }
	| { kind: "resume"; codexThreadId: string; cwd?: string }
	| { kind: "invalid"; message: string };

export function parseThreadStartIntent(text: string): ThreadStartIntent {
	const tokens = tokenize(text);
	const removeRanges: TextRange[] = [];
	let cwd: string | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token) {
			continue;
		}
		const inlineDir = inlineDirValue(token.value);
		if (inlineDir !== undefined) {
			cwd = resolveHomeDir(inlineDir);
			removeRanges.push({ start: token.start, end: token.end });
			continue;
		}
		if (token.value === "--dir" || token.value === "--cwd") {
			const next = tokens[index + 1];
			if (!next) {
				return { kind: "invalid", message: "Missing directory after --dir." };
			}
			cwd = resolveHomeDir(next.value);
			removeRanges.push({ start: token.start, end: next.end });
			index += 1;
		}
	}
	const remainingText = removeRangesFromText(text, removeRanges).trim();
	const remainingTokens = tokenize(remainingText);
	if (remainingTokens[0]?.value === "resume") {
		const codexThreadId = remainingTokens[1]?.value;
		if (!codexThreadId) {
			return {
				kind: "invalid",
				message: "Usage: @codex resume <codex-thread-id> [--dir path]",
			};
		}
		return { kind: "resume", codexThreadId, cwd };
	}
	return { kind: "new", prompt: remainingText, cwd };
}

function resumeThreadTitle(
	command: DiscordThreadStartInbound,
	codexThreadId: string,
): string {
	return truncateDiscordThreadName(
		command.title?.trim() || `Codex ${compactId(codexThreadId)}`,
	);
}

type TextToken = {
	value: string;
	start: number;
	end: number;
};

type TextRange = {
	start: number;
	end: number;
};

function tokenize(text: string): TextToken[] {
	const tokens: TextToken[] = [];
	let index = 0;
	while (index < text.length) {
		while (index < text.length && /\s/.test(text[index] ?? "")) {
			index += 1;
		}
		if (index >= text.length) {
			break;
		}
		const start = index;
		const quote = text[index] === "\"" || text[index] === "'"
			? text[index]
			: undefined;
		let value = "";
		if (quote) {
			index += 1;
			while (index < text.length && text[index] !== quote) {
				value += text[index] ?? "";
				index += 1;
			}
			if (text[index] === quote) {
				index += 1;
			}
			tokens.push({ value, start, end: index });
			continue;
		}
		while (index < text.length && !/\s/.test(text[index] ?? "")) {
			value += text[index] ?? "";
			index += 1;
		}
		tokens.push({ value, start, end: index });
	}
	return tokens;
}

function inlineDirValue(value: string): string | undefined {
	if (value.startsWith("--dir=")) {
		return value.slice("--dir=".length);
	}
	if (value.startsWith("--cwd=")) {
		return value.slice("--cwd=".length);
	}
	return undefined;
}

function removeRangesFromText(text: string, ranges: TextRange[]): string {
	if (ranges.length === 0) {
		return text;
	}
	const sorted = [...ranges].sort((left, right) => left.start - right.start);
	let result = "";
	let cursor = 0;
	for (const range of sorted) {
		result += text.slice(cursor, range.start);
		cursor = Math.max(cursor, range.end);
	}
	result += text.slice(cursor);
	return result.replace(/[ \t]{2,}/g, " ");
}

function resolveHomeDir(value: string): string {
	if (value === "~") {
		return os.homedir();
	}
	if (value.startsWith("~/")) {
		return path.join(os.homedir(), value.slice(2));
	}
	if (path.isAbsolute(value)) {
		return value;
	}
	return path.join(os.homedir(), value);
}

function truncateDiscordThreadName(name: string): string {
	const trimmed = name.trim().replace(/\s+/g, " ");
	if (trimmed.length <= 90) {
		return trimmed || "Codex thread";
	}
	return `${trimmed.slice(0, 87).trimEnd()}...`;
}

function firstLine(value: string | undefined): string | undefined {
	const line = value?.split(/\r?\n/, 1)[0]?.trim();
	return line || undefined;
}

function bestSplitIndex(text: string, maxLength: number): number {
	const newline = text.lastIndexOf("\n", maxLength);
	if (newline > maxLength * 0.6) {
		return newline;
	}
	const space = text.lastIndexOf(" ", maxLength);
	if (space > maxLength * 0.6) {
		return space;
	}
	return maxLength;
}

function isDuplicate(state: DiscordBridgeState, messageId: string): boolean {
	return (
		state.processedMessageIds.includes(messageId) ||
		state.queue.some((item) => item.discordMessageId === messageId) ||
		state.deliveries.some((delivery) => delivery.discordMessageId === messageId)
	);
}

function gatewayToolSpecs(): v2.DynamicToolSpec[] {
	return [
		{
			namespace: "codex_gateway",
			name: "list_delegations",
			description: "List delegated Codex sessions tracked by the Discord gateway.",
			inputSchema: objectSchema({}),
		},
		{
			namespace: "codex_gateway",
			name: "start_delegation",
			description: "Start a delegated Codex session in a cwd and optionally start its first turn.",
			inputSchema: objectSchema({
				cwd: stringSchema("Workspace cwd for the delegated Codex session."),
				title: optionalStringSchema("Human title for the delegated work."),
				prompt: optionalStringSchema("Optional first prompt to send to the delegated session."),
				discordDetailThreadId: optionalStringSchema("Optional Discord detail thread id for noisy work."),
				parentDiscordMessageId: optionalStringSchema("Optional Discord message id that requested the delegation."),
			}, ["cwd"]),
		},
		{
			namespace: "codex_gateway",
			name: "resume_delegation",
			description: "Register an existing Codex thread as delegated work.",
			inputSchema: objectSchema({
				threadId: stringSchema("Existing Codex thread id to resume and track."),
				cwd: optionalStringSchema("Optional cwd override for the resumed thread."),
				title: optionalStringSchema("Human title for the delegated work."),
				discordDetailThreadId: optionalStringSchema("Optional Discord detail thread id for noisy work."),
				parentDiscordMessageId: optionalStringSchema("Optional Discord message id that requested the delegation."),
			}, ["threadId"]),
		},
		{
			namespace: "codex_gateway",
			name: "send_delegation",
			description: "Send a prompt as a new turn to a tracked delegated Codex session.",
			inputSchema: objectSchema({
				delegationId: optionalStringSchema("Tracked delegation id."),
				threadId: optionalStringSchema("Tracked delegated Codex thread id."),
				prompt: stringSchema("Prompt to send to the delegated session."),
			}, ["prompt"]),
		},
		{
			namespace: "codex_gateway",
			name: "read_delegation",
			description: "Read and summarize a tracked delegated Codex session.",
			inputSchema: objectSchema({
				delegationId: optionalStringSchema("Tracked delegation id."),
				threadId: optionalStringSchema("Tracked delegated Codex thread id."),
			}),
		},
		{
			namespace: "codex_gateway",
			name: "list_flow_runs",
			description: "List runs from the configured codex-flow-systemd-local backend.",
			inputSchema: objectSchema({
				eventId: optionalStringSchema("Optional event id filter."),
				status: optionalStringSchema("Optional run status filter."),
				limit: optionalStringSchema("Optional max result count."),
			}),
		},
		{
			namespace: "codex_gateway",
			name: "list_flow_events",
			description: "List events from the configured codex-flow-systemd-local backend.",
			inputSchema: objectSchema({
				type: optionalStringSchema("Optional event type filter."),
				limit: optionalStringSchema("Optional max result count."),
			}),
		},
	];
}

function objectSchema(
	properties: Record<string, JsonValue>,
	required: string[] = [],
): JsonValue {
	return {
		type: "object",
		properties,
		required,
		additionalProperties: false,
	};
}

function stringSchema(description: string): JsonValue {
	return { type: "string", description };
}

function optionalStringSchema(description: string): JsonValue {
	return stringSchema(description);
}

function requiredArg(args: Record<string, unknown>, name: string): string {
	const value = stringValue(args[name]);
	if (!value) {
		throw new Error(`Missing required argument: ${name}`);
	}
	return value;
}

function parseGatewayCommand(content: string): "status" | undefined {
	const normalized = content.trim().toLowerCase();
	return normalized === "status" || normalized === "/status"
		? "status"
		: undefined;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compactId(value: string): string {
	return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}

function delegationId(threadId: string): string {
	return `delegation-${createHash("sha256").update(threadId).digest("hex").slice(0, 12)}`;
}

function clearSummary(input: {
	deleted: number;
	running: number;
	failed: number;
}): string {
	const parts = [
		`Deleted ${input.deleted} inactive Discord thread${input.deleted === 1 ? "" : "s"}.`,
	];
	if (input.running > 0) {
		parts.push(`Left ${input.running} running thread${input.running === 1 ? "" : "s"} alone.`);
	}
	if (input.failed > 0) {
		parts.push(`Failed to delete ${input.failed} thread${input.failed === 1 ? "" : "s"}.`);
	}
	return parts.join(" ");
}

function clearWebhooksSummary(input: { deleted: number; failed: number }): string {
	const parts = [
		`Deleted ${input.deleted} webhook message${input.deleted === 1 ? "" : "s"}.`,
	];
	if (input.failed > 0) {
		parts.push(
			`Failed to delete ${input.failed} webhook message${input.failed === 1 ? "" : "s"}.`,
		);
	}
	return parts.join(" ");
}

function emptyThreadSnapshot(): ThreadSnapshot {
	return { terminalTurnIds: [] };
}

function mergeThreadSnapshots(
	first: ThreadSnapshot,
	second: ThreadSnapshot,
): ThreadSnapshot {
	const terminalTurnIds = [
		...new Set([...first.terminalTurnIds, ...second.terminalTurnIds]),
	];
	return {
		terminalTurnIds,
		lastFinal: first.lastFinal ?? second.lastFinal,
	};
}

function threadSnapshotFromThread(thread: { turns?: unknown[] }): ThreadSnapshot {
	const turns = Array.isArray(thread.turns) ? thread.turns : [];
	const terminalTurnIds: string[] = [];
	let lastFinal: ThreadSnapshot["lastFinal"];
	for (const turn of turns) {
		const parsed = record(turn);
		const turnId = stringValue(parsed.id);
		if (turnId && isTerminalTurnStatus(parsed.status)) {
			terminalTurnIds.push(turnId);
		}
	}
	for (const turn of [...turns].reverse()) {
		const parsed = record(turn);
		const turnId = stringValue(parsed.id);
		const text = lastFinalTextFromTurn(parsed);
		if (turnId && text) {
			lastFinal = { turnId, text };
			break;
		}
	}
	if (lastFinal && !terminalTurnIds.includes(lastFinal.turnId)) {
		terminalTurnIds.push(lastFinal.turnId);
	}
	return {
		terminalTurnIds: [...new Set(terminalTurnIds)],
		lastFinal,
	};
}

function resumeResponseCwd(response: unknown): string | undefined {
	const responseRecord = record(response);
	return stringValue(responseRecord.cwd) ??
		stringValue(record(responseRecord.thread).cwd);
}

function lastFinalTextFromTurn(turn: Record<string, unknown>): string {
	const items = Array.isArray(turn.items) ? turn.items : [];
	for (const item of [...items].reverse()) {
		const candidate = record(item);
		if (
			candidate.type === "agentMessage" &&
			candidate.phase === "final_answer"
		) {
			return stringValue(candidate.text)?.trim() ?? "";
		}
	}
	return "";
}

function isTerminalTurnStatus(value: unknown): boolean {
	return value === "completed" || value === "failed" || value === "interrupted";
}

function addProcessedMessageId(state: DiscordBridgeState, messageId: string): void {
	state.processedMessageIds = [
		...state.processedMessageIds.filter((candidate) => candidate !== messageId),
		messageId,
	].slice(-1000);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeParticipantUserIds(
	userIds: string[] | undefined,
	ownerUserId: string,
): string[] {
	return [...new Set((userIds ?? []).filter(
		(userId) => userId.length > 0 && userId !== ownerUserId,
	))];
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
