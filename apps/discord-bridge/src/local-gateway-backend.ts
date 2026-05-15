import { watch, type Dirent, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { JsonRpcNotification, JsonRpcRequest } from "@peezy.tech/codex-flows/rpc";
import type { JsonValue } from "@peezy.tech/codex-flows/generated/serde_json/JsonValue";
import type { v2 } from "@peezy.tech/codex-flows/generated";
import {
	createFlowBackendHttpClient,
	type FlowBackendClient,
} from "@peezy.tech/flow-runtime/backend-client";

import type { DiscordConsoleOutput } from "./console-output.ts";
import type {
	CodexGatewayBackend,
	CodexGatewayPresenter,
} from "./gateway-backend.ts";
import { DiscordThreadRunner, MessageDeduplicator } from "./runner.ts";
import {
	createDiscordBridgeLogger,
	type DiscordBridgeLogger,
} from "./logger.ts";
import {
	archiveStopHookSpoolFile,
	ensureStopHookSpool,
	readPendingStopHookSpoolFiles,
	stopHookSpoolPaths,
} from "./stop-hook-spool.ts";
import type {
	CodexBridgeClient,
	DiscordBridgeCommandRegistration,
	DiscordBridgeConfig,
	DiscordGatewayDelegation,
	DiscordGatewayDelegationReturnMode,
	DiscordGatewayHookEvent,
	DiscordGatewayObservedThread,
	DiscordGatewayPendingWake,
	DiscordGatewaySurfaceConfig,
	DiscordGatewayWorkspaceSurface,
	DiscordBridgeSession,
	DiscordBridgeState,
	DiscordBridgeStateStore,
	DiscordClearInbound,
	DiscordClearWebhooksInbound,
	DiscordGoalsInbound,
	DiscordInbound,
	DiscordMessageInbound,
	DiscordReactionInbound,
	DiscordStatusInbound,
	DiscordThreadPickerInbound,
	DiscordThreadsInbound,
	DiscordThreadStartInbound,
} from "./types.ts";

const maxDiscordMessageLength = 2000;
const gatewayToolsVersion = 1;
const stopHookDrainDebounceMs = 100;
const stopHookRetryMs = 1_000;
const threadPickerReactions = [
	"1️⃣",
	"2️⃣",
	"3️⃣",
	"4️⃣",
	"5️⃣",
	"6️⃣",
	"7️⃣",
	"8️⃣",
	"9️⃣",
	"🔟",
];

type ThreadSnapshot = {
	terminalTurnIds: string[];
	lastFinal?: {
		turnId: string;
		text: string;
	};
};

type WorkspaceThreadSummary = {
	id: string;
	title: string;
	cwd: string;
	status: string;
	updatedAt: number;
	discordThreadId?: string;
};

type WorkspaceThreadPicker = {
	channelId: string;
	authorId: string;
	entries: WorkspaceThreadSummary[];
};

type WorkspaceGoalSummary = WorkspaceThreadSummary & {
	goal?: v2.ThreadGoal | null;
	goalError?: string;
};

type WorkspaceGoalPicker = {
	channelId: string;
	authorId: string;
	workspace: DiscordGatewayWorkspaceSurface;
	entries: WorkspaceGoalSummary[];
};

type WorkspaceGoalActionPicker = {
	channelId: string;
	authorId: string;
	workspace: DiscordGatewayWorkspaceSurface;
	entry: WorkspaceGoalSummary;
};

type GatewaySurface = DiscordGatewaySurfaceConfig & {
	workspaceCwds?: string[];
};

type GatewayWorkbenchConfig = {
	surfaceKey: string;
	workspaceForumChannelId: string;
	taskThreadsChannelId: string;
};

const defaultGatewaySurfaceKey = "default";

export type LocalCodexGatewayBackendOptions = {
	client: CodexBridgeClient;
	presenter: CodexGatewayPresenter;
	store: DiscordBridgeStateStore;
	config: DiscordBridgeConfig;
	now?: () => Date;
	logger?: DiscordBridgeLogger;
	consoleOutput?: DiscordConsoleOutput;
	flowBackendClient?: FlowBackendClient;
};

export class LocalCodexGatewayBackend implements CodexGatewayBackend {
	readonly client: CodexBridgeClient;
	readonly presenter: CodexGatewayPresenter;
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
	#gatewayStopHookWatcher: FSWatcher | undefined;
	#gatewayStopHookDrainTimer: Timer | undefined;
	#gatewayStopHookDrainChain: Promise<void> = Promise.resolve();
	#flowBackendClient: FlowBackendClient | undefined;
	#transportStarted = false;
	#threadPickersByMessage = new Map<string, WorkspaceThreadPicker>();
	#threadPickersById = new Map<string, WorkspaceThreadPicker>();
	#goalPickersById = new Map<string, WorkspaceGoalPicker>();
	#goalActionPickersById = new Map<string, WorkspaceGoalActionPicker>();

	constructor(options: LocalCodexGatewayBackendOptions) {
		this.client = options.client;
		this.presenter = options.presenter;
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
		this.#flowBackendClient = options.flowBackendClient;
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
	}

	async startTransportDependentWork(): Promise<void> {
		this.#transportStarted = true;
		this.#debug("transport.started");
		await this.#reconcileGatewayWorkbench();
	}

	async startBackgroundWork(): Promise<void> {
		for (const runner of this.#runnersByDiscordThread.values()) {
			if (this.#shouldAutoStartRunner(runner.session)) {
				runner.start();
			}
		}
		await this.#startGatewayStopHookSpool();
	}

	async stop(): Promise<void> {
		this.#debug("bridge.stop", {
			runners: this.#runnersByDiscordThread.size,
		});
		if (this.#gatewayStopHookDrainTimer) {
			clearTimeout(this.#gatewayStopHookDrainTimer);
			this.#gatewayStopHookDrainTimer = undefined;
		}
		if (this.#gatewayStopHookWatcher) {
			this.#gatewayStopHookWatcher.close();
			this.#gatewayStopHookWatcher = undefined;
		}
		await Promise.all(
			[...this.#runnersByDiscordThread.values()].map((runner) => runner.stop()),
		);
		await this.#gatewayStopHookDrainChain.catch(() => undefined);
		await this.#persistChain.catch(() => undefined);
		this.#transportStarted = false;
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

	commandRegistration(): DiscordBridgeCommandRegistration {
		return { channelIds: this.#commandRegistrationChannelIds() };
	}

	async handleInbound(inbound: DiscordInbound): Promise<void> {
		await this.#handleInbound(inbound);
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
		if (inbound.kind === "status") {
			await this.#handleStatusCommand(inbound);
			return;
		}
		if (inbound.kind === "threads") {
			await this.#handleThreadsCommand(inbound);
			return;
		}
		if (inbound.kind === "goals") {
			await this.#handleGoalsCommand(inbound);
			return;
		}
		if (inbound.kind === "threadPicker") {
			await this.#handleThreadPickerSelection(inbound);
			return;
		}
		if (inbound.kind === "reaction") {
			await this.#handleThreadPickerReaction(inbound);
			return;
		}

		if (inbound.kind === "threadStart") {
			if (this.#gatewaySurfaceForHomeChannel(inbound.channelId)) {
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
		if (!this.presenter.deleteThread) {
			this.#debug("clear.unsupported", { channelId: command.channelId });
			await command.reply?.("This gateway presenter cannot delete threads.");
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
				await this.presenter.deleteThread(session.discordThreadId);
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
		if (!this.presenter.deleteWebhookMessages) {
			this.#debug("clearWebhooks.unsupported", { channelId: command.channelId });
			await command.reply?.("This gateway presenter cannot delete webhook messages.");
			return;
		}
		this.#debug("clearWebhooks.start", {
			channelId: command.channelId,
			guildId: command.guildId,
			filtered: Boolean(command.webhookUrl),
		});
		let result: { deleted: number; failed: number };
		try {
			result = await this.presenter.deleteWebhookMessages(command.channelId, {
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

	async #handleStatusCommand(command: DiscordStatusInbound): Promise<void> {
		if (!this.config.allowedUserIds.has(command.author.id)) {
			this.#debug("status.ignored.user", {
				channelId: command.channelId,
				authorId: command.author.id,
			});
			await command.reply?.("Only globally allowed Discord users can read gateway status.");
			return;
		}
		if (!this.#isAllowedChannel(command.channelId)) {
			this.#debug("status.ignored.channel", { channelId: command.channelId });
			await command.reply?.("This Discord channel is not allowed for the bridge.");
			return;
		}
		const surface = this.#gatewaySurfaceForChannel(command.channelId) ??
			this.#primaryGatewaySurface();
		const workbench = this.#gatewayWorkbenchConfig(surface);
		const activeThreads = await this.#listActiveCodexThreadSummaries(surface);
		const openableThreads = activeThreads.filter((thread) =>
			!thread.discordThreadId &&
			!this.#isGatewayMainThread(thread.id) &&
			Boolean(workbench)
		).slice(0, threadPickerReactions.length);
		const statusText = this.#gatewayStatusMessage({
			activeThreads,
			openableThreads,
		}, surface);
		if (openableThreads.length === 0 || !command.replyPicker) {
			await command.reply?.(statusText);
			return;
		}
		const pickerId = `status-${randomUUID()}`;
		this.#threadPickersById.set(pickerId, {
			channelId: command.channelId,
			authorId: command.author.id,
			entries: openableThreads,
		});
		try {
			await command.replyPicker({
				pickerId,
				text: statusText,
				options: openableThreads.map((_, index) => ({
					id: String(index),
					label: String(index + 1),
				})),
			});
		} catch (error) {
			this.#threadPickersById.delete(pickerId);
			await command.reply?.(
				`Failed to send active-thread picker: ${errorMessage(error)}`,
			);
		}
	}

	async #handleThreadsCommand(command: DiscordThreadsInbound): Promise<void> {
		if (!this.config.allowedUserIds.has(command.author.id)) {
			this.#debug("threads.ignored.user", {
				channelId: command.channelId,
				authorId: command.author.id,
			});
			await command.reply?.("Only globally allowed Discord users can list workspace threads.");
			return;
		}
		if (!this.#isAllowedChannel(command.channelId)) {
			this.#debug("threads.ignored.channel", { channelId: command.channelId });
			await command.reply?.("This Discord channel is not allowed for the bridge.");
			return;
		}
		const workspace = this.#workspaceForChannel(command.channelId);
		if (!workspace) {
			await command.reply?.("Run `/threads` in a workspace forum post or opened workspace thread.");
			return;
		}
		const threads = await this.#listWorkspaceThreads(workspace);
		if (threads.length === 0) {
			await command.reply?.(`No Codex threads found for ${workspace.title}.`);
			return;
		}
		if (!command.replyPicker) {
			await command.reply?.(
				"This gateway presenter cannot send ephemeral thread pickers.",
			);
			return;
		}
		const entries = threads.slice(0, threadPickerReactions.length);
		const pickerId = `threads-${randomUUID()}`;
		this.#threadPickersById.set(pickerId, {
			channelId: command.channelId,
			authorId: command.author.id,
			entries,
		});
		try {
			await command.replyPicker({
				pickerId,
				text: threadPickerText(workspace, entries, threads.length, {
					action: "Choose a number to open or resume that thread in Discord.",
				}),
				options: entries.map((_, index) => ({
					id: String(index),
					label: String(index + 1),
				})),
			});
		} catch (error) {
			this.#threadPickersById.delete(pickerId);
			await command.reply?.(
				`Failed to send the ephemeral thread picker: ${errorMessage(error)}`,
			);
			return;
		}
	}

	async #handleGoalsCommand(command: DiscordGoalsInbound): Promise<void> {
		if (!this.config.allowedUserIds.has(command.author.id)) {
			this.#debug("goals.ignored.user", {
				channelId: command.channelId,
				authorId: command.author.id,
			});
			await command.reply?.("Only globally allowed Discord users can manage goals.");
			return;
		}
		if (!this.#isAllowedChannel(command.channelId)) {
			this.#debug("goals.ignored.channel", { channelId: command.channelId });
			await command.reply?.("This Discord channel is not allowed for the bridge.");
			return;
		}
		const session = this.#sessionForDiscordThread(command.channelId);
		if (session) {
			await this.#handleThreadGoalsCommand(command, session);
			return;
		}
		const workspace = this.#workspaceForumForChannel(command.channelId);
		if (!workspace) {
			await command.reply?.(
				"Run `/goals` in a workspace forum post or opened Codex thread.",
			);
			return;
		}
		if (!command.replyPicker) {
			await command.reply?.(
				"This gateway presenter cannot send ephemeral goal pickers.",
			);
			return;
		}
		const entries = await this.#listWorkspaceGoalSummaries(workspace);
		if (entries.length === 0) {
			await command.reply?.(`No Codex threads found for ${workspace.title}.`);
			return;
		}
		const pickerEntries = entries.slice(0, threadPickerReactions.length);
		const pickerId = `goals-${randomUUID()}`;
		this.#goalPickersById.set(pickerId, {
			channelId: command.channelId,
			authorId: command.author.id,
			workspace,
			entries: pickerEntries,
		});
		try {
			await command.replyPicker({
				pickerId,
				text: goalPickerText(workspace, pickerEntries, entries.length),
				options: pickerEntries.map((_, index) => ({
					id: String(index),
					label: String(index + 1),
				})),
			});
		} catch (error) {
			this.#goalPickersById.delete(pickerId);
			await command.reply?.(
				`Failed to send the goal picker: ${errorMessage(error)}`,
			);
		}
	}

	async #handleThreadGoalsCommand(
		command: DiscordGoalsInbound,
		session: DiscordBridgeSession,
	): Promise<void> {
		const hasMutation = hasGoalMutation(command);
		if (command.clear && hasMutation) {
			await command.reply?.("Use either `clear` or goal updates, not both.");
			return;
		}
		const workspace = this.#workspaceForGoalSession(session);
		const picker = {
			channelId: command.channelId,
			authorId: command.author.id,
			workspace,
		};
		if (command.clear) {
			try {
				await this.client.clearThreadGoal({ threadId: session.codexThreadId });
				await command.reply?.(`Cleared goal for ${session.title}.`);
			} catch (error) {
				await command.reply?.(
					`Failed to clear goal for ${session.title}: ${errorMessage(error)}`,
				);
			}
			return;
		}
		if (hasMutation) {
			try {
				const response = await this.client.setThreadGoal({
					threadId: session.codexThreadId,
					objective: command.objective,
					status: command.goalStatus,
					tokenBudget: command.tokenBudget,
				});
				await this.#showGoalActionPicker(
					command,
					picker,
					this.#goalSummaryFromSession(session, { goal: response.goal }),
					{ prefix: command.objective ? "Saved goal." : "Updated goal." },
				);
			} catch (error) {
				await command.reply?.(
					`Failed to update goal for ${session.title}: ${errorMessage(error)}`,
				);
			}
			return;
		}
		const entry = await this.#goalSummaryForSession(session);
		await this.#showGoalActionPicker(command, picker, entry);
	}

	async #handleThreadPickerSelection(
		selection: DiscordThreadPickerInbound,
	): Promise<void> {
		if (!this.config.allowedUserIds.has(selection.author.id)) {
			return;
		}
		const picker = this.#threadPickersById.get(selection.pickerId);
		if (picker) {
			await this.#handleWorkspaceThreadPickerSelection(selection, picker);
			return;
		}
		const goalPicker = this.#goalPickersById.get(selection.pickerId);
		if (goalPicker) {
			await this.#handleGoalPickerSelection(selection, goalPicker);
			return;
		}
		const goalActionPicker = this.#goalActionPickersById.get(selection.pickerId);
		if (goalActionPicker) {
			await this.#handleGoalActionSelection(selection, goalActionPicker);
			return;
		}
		await selection.update?.("This picker is no longer active.");
	}

	async #handleWorkspaceThreadPickerSelection(
		selection: DiscordThreadPickerInbound,
		picker: WorkspaceThreadPicker,
	): Promise<void> {
		if (selection.author.id !== picker.authorId) {
			await selection.reply?.("Only the user who ran the command can use this picker.");
			return;
		}
		const index = Number.parseInt(selection.optionId, 10);
		const entry = Number.isInteger(index) ? picker.entries[index] : undefined;
		if (!entry) {
			await selection.update?.("That thread choice is no longer available.");
			return;
		}
		this.#threadPickersById.delete(selection.pickerId);
		try {
			const session = await this.#materializeWorkspaceThread(entry.id, {
				author: selection.author,
				surface: this.#gatewaySurfaceForChannel(picker.channelId),
			});
			await updateOrReply(
				selection,
				`Opened ${session.title}: <#${session.discordThreadId}>`,
			);
		} catch (error) {
			this.#error("threads.picker.openFailed", {
				channelId: selection.channelId,
				pickerId: selection.pickerId,
				threadId: entry.id,
				error: errorMessage(error),
			});
			await updateOrReply(
				selection,
				`Failed to open ${entry.title}: ${errorMessage(error)}`,
			);
		}
	}

	async #handleGoalPickerSelection(
		selection: DiscordThreadPickerInbound,
		picker: WorkspaceGoalPicker,
	): Promise<void> {
		if (selection.author.id !== picker.authorId) {
			await selection.reply?.("Only the user who ran `/goals` can use this picker.");
			return;
		}
		const index = Number.parseInt(selection.optionId, 10);
		const entry = Number.isInteger(index) ? picker.entries[index] : undefined;
		if (!entry) {
			await selection.update?.("That goal choice is no longer available.");
			return;
		}
		this.#goalPickersById.delete(selection.pickerId);
		await this.#showGoalActionPicker(selection, picker, entry);
	}

	async #handleGoalActionSelection(
		selection: DiscordThreadPickerInbound,
		picker: WorkspaceGoalActionPicker,
	): Promise<void> {
		if (selection.author.id !== picker.authorId) {
			await selection.reply?.("Only the user who ran `/goals` can use this picker.");
			return;
		}
		const action = selection.optionId;
		this.#goalActionPickersById.delete(selection.pickerId);
		if (action === "open") {
			try {
				const session = await this.#materializeWorkspaceThread(picker.entry.id, {
					author: selection.author,
					surface: this.#gatewaySurfaceForWorkspace(picker.workspace),
				});
				const updatedEntry = {
					...picker.entry,
					discordThreadId: session.discordThreadId,
				};
				await this.#showGoalActionPicker(selection, picker, updatedEntry, {
					prefix: `Opened ${session.title}: <#${session.discordThreadId}>`,
				});
			} catch (error) {
				await updateOrReply(
					selection,
					`Failed to open ${picker.entry.title}: ${errorMessage(error)}`,
				);
			}
			return;
		}
		if (action === "clear") {
			try {
				await this.client.clearThreadGoal({ threadId: picker.entry.id });
				await updateOrReply(
					selection,
					`Cleared goal for ${picker.entry.title}.`,
				);
			} catch (error) {
				await updateOrReply(
					selection,
					`Failed to clear goal for ${picker.entry.title}: ${errorMessage(error)}`,
				);
			}
			return;
		}
		const status = action.startsWith("status:")
			? action.slice("status:".length)
			: "";
		if (
			status === "active" ||
			status === "paused" ||
			status === "budgetLimited" ||
			status === "complete"
		) {
			try {
				const response = await this.client.setThreadGoal({
					threadId: picker.entry.id,
					status,
				});
				await this.#showGoalActionPicker(
					selection,
					picker,
					{ ...picker.entry, goal: response.goal },
					{ prefix: `Set goal status to ${status}.` },
				);
			} catch (error) {
				await updateOrReply(
					selection,
					`Failed to update goal for ${picker.entry.title}: ${errorMessage(error)}`,
				);
			}
			return;
		}
		await selection.update?.("That goal action is no longer available.");
	}

	async #showGoalActionPicker(
		selection: Pick<
			DiscordThreadPickerInbound,
			"update" | "updatePicker" | "reply"
		> & Pick<DiscordGoalsInbound, "replyPicker">,
		picker: Pick<WorkspaceGoalPicker, "channelId" | "authorId" | "workspace">,
		entry: WorkspaceGoalSummary,
		options: { prefix?: string } = {},
	): Promise<void> {
		const actions = goalActionOptions(entry);
		const text = goalActionText(picker.workspace, entry, options);
		const sendPicker = selection.updatePicker ?? selection.replyPicker;
		if (actions.length === 0 || !sendPicker) {
			await updateOrReply(selection, text);
			return;
		}
		const pickerId = `goal-actions-${randomUUID()}`;
		this.#goalActionPickersById.set(pickerId, {
			channelId: picker.channelId,
			authorId: picker.authorId,
			workspace: picker.workspace,
			entry,
		});
		await sendPicker({
			pickerId,
			text,
			options: actions,
		});
	}

	async #handleThreadPickerReaction(reaction: DiscordReactionInbound): Promise<void> {
		if (!this.config.allowedUserIds.has(reaction.author.id)) {
			return;
		}
		const pickerKey = threadPickerKey(reaction.channelId, reaction.messageId);
		const picker = this.#threadPickersByMessage.get(pickerKey);
		if (!picker) {
			return;
		}
		if (reaction.author.id !== picker.authorId) {
			return;
		}
		const index = threadPickerReactionIndex(reaction.emoji);
		const entry = index === undefined ? undefined : picker.entries[index];
		if (!entry) {
			return;
		}
		this.#threadPickersByMessage.delete(pickerKey);
		try {
			const session = await this.#materializeWorkspaceThread(entry.id, {
				author: reaction.author,
				surface: this.#gatewaySurfaceForChannel(picker.channelId),
			});
			await this.presenter.sendMessage(
				picker.channelId,
				`Opened ${session.title}: <#${session.discordThreadId}>`,
			);
		} catch (error) {
			this.#error("threads.reaction.openFailed", {
				channelId: reaction.channelId,
				messageId: reaction.messageId,
				threadId: entry.id,
				error: errorMessage(error),
			});
			await this.presenter.sendMessage(
				picker.channelId,
				`Failed to open ${entry.title}: ${errorMessage(error)}`,
			);
		}
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
		const discordThreadId = await this.presenter.createThread(
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
				? await this.presenter.sendMessage(discordThreadId, snapshot.lastFinal.text)
				: await this.presenter.sendMessage(
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
		if (this.#gatewaySurfaceForHomeChannel(message.channelId)) {
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

	#gatewayStatusMessage(
		options: {
			activeThreads?: WorkspaceThreadSummary[];
			openableThreads?: WorkspaceThreadSummary[];
		} = {},
		surface: GatewaySurface | undefined = this.#primaryGatewaySurface(),
	): string {
		const state = this.#requireState();
		const gateway = state.gateway;
		const session = this.#gatewaySession();
		const delegations = (gateway?.delegations ?? []).filter((delegation) =>
			this.#gatewaySurfaceForDelegation(delegation)?.key === surface?.key
		);
		const workspaces = (gateway?.workspaces ?? []).filter((workspace) =>
			this.#gatewaySurfaceForWorkspace(workspace)?.key === surface?.key
		);
		const activeDelegations = delegations.filter((delegation) =>
			delegation.status === "active"
		);
		const workbench = this.#gatewayWorkbenchConfig(surface);
		const activeThreads = options.activeThreads ?? [];
		const openableThreads = options.openableThreads ?? [];
		return [
			"**Codex Gateway**",
			surface ? `Surface: \`${surface.key}\`` : undefined,
			`Home channel: \`${surface?.homeChannelId ?? this.config.gateway?.homeChannelId ?? "disabled"}\``,
			`Main thread: \`${session?.codexThreadId ?? gateway?.mainThreadId ?? "none"}\``,
			`Dir: \`${session?.cwd ?? this.config.cwd ?? "default"}\``,
			`Legacy thread bridge: \`enabled\``,
			`Delegations: ${delegations.length} tracked, ${activeDelegations.length} active`,
			"",
			"**Delegation Backend**",
			`Status: ${state.gateway?.toolsVersion === gatewayToolsVersion ? "privileged gateway tools available to the main Codex operator thread" : "waiting for a tool-enabled main Codex operator thread"}.`,
			`Flow backend: \`${this.config.flowBackendUrl ?? "not configured"}\``,
			"",
			"**Workbench**",
			workbench
				? `Status: enabled; workspace forum <#${workbench.workspaceForumChannelId}>, task threads <#${workbench.taskThreadsChannelId}>`
				: "Status: disabled",
			`Workspaces: ${workspaces.length} tracked`,
			"",
			"**Active Codex Threads**",
			activeThreads.length > 0
				? activeThreadStatusLines(activeThreads, openableThreads).join("\n")
				: "None",
			openableThreads.length > 0
				? "Choose a number to create or reuse a Discord task thread."
				: undefined,
		].filter((line): line is string => line !== undefined).join("\n");
	}

	async #handleNotification(message: JsonRpcNotification): Promise<void> {
		if (!this.#transportStarted) {
			this.#debug("notification.ignored.transportNotStarted", {
				method: message.method,
			});
			return;
		}
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
		if (message.method === "turn/completed" && this.#isGatewayMainThread(threadId)) {
			await this.#processPendingWakes();
			await this.#persist();
		}
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
		if (tool === "set_delegation_policy") {
			return await this.#setDelegationPolicy(args);
		}
		if (tool === "flush_delegation_results") {
			return await this.#flushDelegationResults(args);
		}
		if (tool === "list_delegation_groups") {
			return {
				groups: this.#delegationGroups(),
			};
		}
		if (tool === "list_flow_runs") {
			return await this.#listFlowRuns(args);
		}
		if (tool === "list_flow_events") {
			return await this.#listFlowEvents(args);
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
			presenter: this.presenter,
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
		const explicitMainThread = Boolean(gatewayConfig.mainThreadId);
		let forceCreateGatewayThread = false;
		const shouldReuseExisting =
			explicitMainThread ||
			state.gateway?.toolsVersion === gatewayToolsVersion;
		if (existing && shouldReuseExisting) {
			try {
				const gatewayCwd = this.config.cwd ?? existing.cwd;
				const resumed = await this.client.resumeThread(this.#threadResumeParams(
					existing.codexThreadId,
					gatewayCwd,
				));
				const primarySurface = this.#primaryGatewaySurface();
				this.#runnersByDiscordThread.delete(existing.discordThreadId);
				this.#runnersByCodexThread.delete(existing.codexThreadId);
				existing.discordThreadId = gatewayConfig.homeChannelId;
				existing.parentChannelId = gatewayConfig.homeChannelId;
				existing.surfaceKey = primarySurface?.key;
				existing.cwd = gatewayCwd ?? resumeResponseCwd(resumed) ?? existing.cwd;
				state.gateway = {
					homeChannelId: gatewayConfig.homeChannelId,
					mainThreadId: existing.codexThreadId,
					statusMessageId: existing.statusMessageId,
					createdAt: existing.createdAt,
					toolsVersion: state.gateway?.toolsVersion,
					delegations: state.gateway?.delegations ?? [],
					workspaces: state.gateway?.workspaces ?? [],
					observedThreads: state.gateway?.observedThreads ?? [],
					pendingWakes: state.gateway?.pendingWakes ?? [],
					processedHookEventIds: state.gateway?.processedHookEventIds ?? [],
					processedStopHookEventIds: state.gateway?.processedStopHookEventIds ?? [],
				};
				this.#registerRunner(existing);
				await this.#persist();
				return;
			} catch (error) {
				if (explicitMainThread) {
					throw error;
				}
				forceCreateGatewayThread = true;
				this.#debug("gateway.session.recreateAfterResumeFailure", {
					codexThreadId: existing.codexThreadId,
					error: errorMessage(error),
				});
			}
		}
		if (existing) {
			state.sessions = state.sessions.filter((session) => session !== existing);
			this.#runnersByDiscordThread.delete(existing.discordThreadId);
			this.#runnersByCodexThread.delete(existing.codexThreadId);
		}

		const configuredThreadId =
			forceCreateGatewayThread
				? undefined
				: gatewayConfig.mainThreadId ??
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
			surfaceKey: this.#primaryGatewaySurface()?.key,
		};
		state.gateway = {
			homeChannelId: gatewayConfig.homeChannelId,
			mainThreadId: codexThreadId,
			createdAt: session.createdAt,
			toolsVersion: configuredThreadId
				? state.gateway?.toolsVersion
				: gatewayToolsVersion,
			delegations: state.gateway?.delegations ?? [],
			workspaces: state.gateway?.workspaces ?? [],
			observedThreads: state.gateway?.observedThreads ?? [],
			pendingWakes: state.gateway?.pendingWakes ?? [],
			processedHookEventIds: state.gateway?.processedHookEventIds ?? [],
			processedStopHookEventIds: state.gateway?.processedStopHookEventIds ?? [],
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

	#gatewaySurfaces(): GatewaySurface[] {
		const gateway = this.config.gateway;
		if (!gateway) {
			return [];
		}
		if (gateway.surfaces?.length) {
			return gateway.surfaces.map((surface) => ({
				...surface,
				workspaceCwds: surface.workspaceCwds?.map((cwd) =>
					workspaceCwdForPath(cwd, this.config.cwd)
				),
			}));
		}
		return [
			{
				key: defaultGatewaySurfaceKey,
				homeChannelId: gateway.homeChannelId,
				workspaceForumChannelId: gateway.workspaceForumChannelId,
				taskThreadsChannelId: gateway.taskThreadsChannelId,
			},
		];
	}

	#primaryGatewaySurface(): GatewaySurface | undefined {
		return this.#gatewaySurfaces()[0];
	}

	#gatewaySurfaceByKey(key: string | undefined): GatewaySurface | undefined {
		return key
			? this.#gatewaySurfaces().find((surface) => surface.key === key)
			: undefined;
	}

	#gatewaySurfaceForHomeChannel(channelId: string): GatewaySurface | undefined {
		return this.#gatewaySurfaces().find((surface) =>
			surface.homeChannelId === channelId
		);
	}

	#gatewaySurfaceForWorkspaceForumChannel(channelId: string): GatewaySurface | undefined {
		return this.#gatewaySurfaces().find((surface) =>
			surface.workspaceForumChannelId === channelId
		);
	}

	#gatewaySurfaceForTaskThreadsChannel(channelId: string): GatewaySurface | undefined {
		return this.#gatewaySurfaces().find((surface) =>
			surface.taskThreadsChannelId === channelId
		);
	}

	#gatewaySurfaceForChannel(channelId: string): GatewaySurface | undefined {
		return this.#gatewaySurfaceForHomeChannel(channelId) ??
			this.#gatewaySurfaceForWorkspaceForumChannel(channelId) ??
			this.#gatewaySurfaceForTaskThreadsChannel(channelId) ??
			this.#gatewaySurfaceForWorkspace(this.#workspaceForChannel(channelId)) ??
			this.#gatewaySurfaceForSession(this.#requireState().sessions.find((session) =>
				session.discordThreadId === channelId
			));
	}

	#gatewaySurfaceForCwd(cwd: string | undefined): GatewaySurface | undefined {
		const surfaces = this.#gatewaySurfaces();
		if (surfaces.length === 0) {
			return undefined;
		}
		const catchAll = surfaces.find((surface) =>
			!surface.workspaceCwds || surface.workspaceCwds.length === 0
		);
		if (cwd) {
			const workspaceCwd = workspaceCwdForPath(cwd, this.config.cwd);
			const exact = surfaces.find((surface) =>
				(surface.workspaceCwds ?? []).some((surfaceCwd) =>
					normalizeWorkspaceCwd(surfaceCwd) === workspaceCwd
				)
			);
			if (exact) {
				return exact;
			}
			return catchAll;
		}
		return catchAll ?? surfaces[0];
	}

	#gatewaySurfaceForWorkspace(
		workspace: DiscordGatewayWorkspaceSurface | undefined,
	): GatewaySurface | undefined {
		if (!workspace) {
			return undefined;
		}
		return this.#gatewaySurfaceByKey(workspace.surfaceKey) ??
			this.#gatewaySurfaceForCwd(workspace.cwd);
	}

	#gatewaySurfaceForDelegation(
		delegation: DiscordGatewayDelegation,
	): GatewaySurface | undefined {
		return this.#gatewaySurfaceByKey(delegation.surfaceKey) ??
			this.#gatewaySurfaceForCwd(delegation.cwd);
	}

	#gatewaySurfaceForObserved(
		observed: DiscordGatewayObservedThread,
	): GatewaySurface | undefined {
		return this.#gatewaySurfaceByKey(observed.surfaceKey) ??
			this.#gatewaySurfaceForCwd(observed.cwd);
	}

	#gatewaySurfaceForSession(
		session: DiscordBridgeSession | undefined,
	): GatewaySurface | undefined {
		if (!session) {
			return undefined;
		}
		return this.#gatewaySurfaceByKey(session.surfaceKey) ??
			this.#gatewaySurfaceForHomeChannel(session.discordThreadId) ??
			this.#gatewaySurfaceForTaskThreadsChannel(session.parentChannelId) ??
			this.#gatewaySurfaceForWorkspaceForumChannel(session.parentChannelId) ??
			this.#gatewaySurfaceForCwd(session.cwd);
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

	#shouldAutoStartRunner(session: DiscordBridgeSession): boolean {
		const workbench = this.#gatewayWorkbenchConfig(
			this.#gatewaySurfaceForSession(session),
		);
		return session.parentChannelId !== workbench?.taskThreadsChannelId;
	}

	#isGatewayMainThread(threadId: string): boolean {
		const session = this.#gatewaySession();
		return Boolean(
			(session && session.codexThreadId === threadId) ||
				this.#requireState().gateway?.mainThreadId === threadId,
		);
	}

	#gatewayWorkbenchConfig(
		surface: GatewaySurface | undefined = this.#primaryGatewaySurface(),
	): GatewayWorkbenchConfig | undefined {
		if (!surface?.workspaceForumChannelId || !surface.taskThreadsChannelId) {
			return undefined;
		}
		return {
			surfaceKey: surface.key,
			workspaceForumChannelId: surface.workspaceForumChannelId,
			taskThreadsChannelId: surface.taskThreadsChannelId,
		};
	}

	#gatewayStopHookSpoolDir(): string {
		return this.config.hookSpoolDir ??
			path.join(path.dirname(this.config.statePath), "stop-hooks");
	}

	#gatewayDelegations(): DiscordGatewayDelegation[] {
		const state = this.#requireState();
		if (!state.gateway) {
			state.gateway = {
				homeChannelId: this.config.gateway?.homeChannelId ?? "",
				mainThreadId: this.#gatewaySession()?.codexThreadId,
				delegations: [],
				workspaces: [],
				observedThreads: [],
				pendingWakes: [],
				processedHookEventIds: [],
				processedStopHookEventIds: [],
			};
		}
		state.gateway.delegations ??= [];
		return state.gateway.delegations;
	}

	#gatewayWorkspaces(): DiscordGatewayWorkspaceSurface[] {
		const state = this.#requireState();
		if (!state.gateway) {
			state.gateway = {
				homeChannelId: this.config.gateway?.homeChannelId ?? "",
				mainThreadId: this.#gatewaySession()?.codexThreadId,
				delegations: [],
				workspaces: [],
				observedThreads: [],
				pendingWakes: [],
				processedHookEventIds: [],
				processedStopHookEventIds: [],
			};
		}
		state.gateway.workspaces ??= [];
		return state.gateway.workspaces;
	}

	#gatewayPendingWakes(): DiscordGatewayPendingWake[] {
		const state = this.#requireState();
		if (!state.gateway) {
			state.gateway = {
				homeChannelId: this.config.gateway?.homeChannelId ?? "",
				mainThreadId: this.#gatewaySession()?.codexThreadId,
				delegations: [],
				workspaces: [],
				observedThreads: [],
				pendingWakes: [],
				processedHookEventIds: [],
				processedStopHookEventIds: [],
			};
		}
		state.gateway.pendingWakes ??= [];
		return state.gateway.pendingWakes;
	}

	#gatewayObservedThreads(): DiscordGatewayObservedThread[] {
		const state = this.#requireState();
		if (!state.gateway) {
			state.gateway = {
				homeChannelId: this.config.gateway?.homeChannelId ?? "",
				mainThreadId: this.#gatewaySession()?.codexThreadId,
				delegations: [],
				workspaces: [],
				observedThreads: [],
				pendingWakes: [],
				processedHookEventIds: [],
				processedStopHookEventIds: [],
			};
		}
		state.gateway.observedThreads ??= [];
		return state.gateway.observedThreads;
	}

	#gatewayProcessedHookEventIds(): string[] {
		const state = this.#requireState();
		if (!state.gateway) {
			state.gateway = {
				homeChannelId: this.config.gateway?.homeChannelId ?? "",
				mainThreadId: this.#gatewaySession()?.codexThreadId,
				delegations: [],
				workspaces: [],
				observedThreads: [],
				pendingWakes: [],
				processedHookEventIds: [],
				processedStopHookEventIds: [],
			};
		}
		state.gateway.processedHookEventIds ??= [
			...(state.gateway.processedStopHookEventIds ?? []),
		];
		return state.gateway.processedHookEventIds;
	}

	async #startDelegation(args: Record<string, unknown>): Promise<unknown> {
		const cwd = requiredArg(args, "cwd");
		const title = stringValue(args.title) ?? firstLine(stringValue(args.prompt)) ??
			`Delegated ${compactId(cwd)}`;
		const prompt = stringValue(args.prompt);
		const groupId = stringValue(args.groupId);
		const returnMode = returnModeFromArgs(
			args,
			groupId ? "wake_on_group" : "wake_on_done",
		);
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
			groupId,
			surfaceKey: this.#gatewaySurfaceForCwd(cwd)?.key,
			returnMode,
			discordDetailThreadId: stringValue(args.discordDetailThreadId),
			parentDiscordMessageId: stringValue(args.parentDiscordMessageId),
			createdAt: now,
			updatedAt: now,
		});
		const workbench = await this.#ensureDelegationWorkbench(delegation);
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
			delegation.lastTurnId = turnId;
		}
		await this.#persist();
		return { delegation, turnId, workbench };
	}

	async #resumeDelegation(args: Record<string, unknown>): Promise<unknown> {
		const codexThreadId = requiredArg(args, "threadId");
		const cwd = stringValue(args.cwd);
		const groupId = stringValue(args.groupId);
		const resumed = await this.client.resumeThread(this.#threadResumeParams(codexThreadId, cwd));
		const now = this.#now().toISOString();
		const delegation = this.#upsertDelegation({
			id: stringValue(args.id) ?? delegationId(codexThreadId),
			codexThreadId,
			title: stringValue(args.title) ?? `Delegated ${compactId(codexThreadId)}`,
			status: "idle",
			cwd: cwd ?? resumeResponseCwd(resumed),
			surfaceKey: this.#gatewaySurfaceForCwd(
				cwd ?? resumeResponseCwd(resumed) ?? this.config.cwd,
			)?.key,
			groupId,
			returnMode: returnModeFromArgs(args, "manual"),
			discordDetailThreadId: stringValue(args.discordDetailThreadId),
			parentDiscordMessageId: stringValue(args.parentDiscordMessageId),
			createdAt: this.#delegationForThread(codexThreadId)?.createdAt ?? now,
			updatedAt: now,
		});
		const workbench = await this.#ensureDelegationWorkbench(delegation);
		await this.#persist();
		return { delegation, workbench };
	}

	async #sendDelegation(args: Record<string, unknown>): Promise<unknown> {
		const delegation = this.#requireDelegation(args);
		const prompt = requiredArg(args, "prompt");
		const groupId = stringValue(args.groupId);
		if (groupId) {
			delegation.groupId = groupId;
		}
		delegation.returnMode = returnModeFromArgs(
			args,
			delegation.returnMode ?? (delegation.groupId ? "wake_on_group" : "wake_on_done"),
		);
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
		delegation.lastTurnId = turn.turn.id;
		delegation.lastStatus = undefined;
		delegation.lastFinal = undefined;
		delegation.completedAt = undefined;
		delegation.injectedAt = undefined;
		delegation.mirroredAt = undefined;
		delegation.taskMirroredAt = undefined;
		delegation.reportedAt = undefined;
		delegation.updatedAt = this.#now().toISOString();
		const workbench = await this.#syncDelegationWorkbench(delegation, {
			includeTaskResult: false,
		});
		await this.#persist();
		return { delegation, turnId: turn.turn.id, workbench };
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
			delegation.status = "complete";
		} else if (latestStatus === "failed" || latestStatus === "interrupted") {
			delegation.status = "failed";
		} else if (latestStatus) {
			delegation.status = "active";
		}
		delegation.lastTurnId = stringValue(latest.id) ?? delegation.lastTurnId;
		delegation.lastStatus = latestStatus ?? delegation.lastStatus;
		delegation.lastFinal = snapshot.lastFinal?.text ?? delegation.lastFinal;
		if (latestStatus && isTerminalTurnStatus(latestStatus)) {
			delegation.completedAt ??= this.#now().toISOString();
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

	async #setDelegationPolicy(args: Record<string, unknown>): Promise<unknown> {
		const groupId = stringValue(args.groupId);
		const mode = returnModeFromArgs(args, undefined);
		if (!mode) {
			throw new Error("Missing required argument: returnMode");
		}
		const delegations = groupId
			? this.#gatewayDelegations().filter((delegation) => delegation.groupId === groupId)
			: [this.#requireDelegation(args)];
		if (delegations.length === 0) {
			throw new Error("No matching gateway delegations.");
		}
		const now = this.#now().toISOString();
		for (const delegation of delegations) {
			delegation.returnMode = mode;
			delegation.updatedAt = now;
		}
		await this.#persist();
		return { delegations };
	}

	async #flushDelegationResults(args: Record<string, unknown>): Promise<unknown> {
		const groupId = stringValue(args.groupId);
		const delegations = groupId
			? this.#gatewayDelegations().filter((delegation) => delegation.groupId === groupId)
			: stringValue(args.delegationId) || stringValue(args.threadId) || stringValue(args.id)
			? [this.#requireDelegation(args)]
			: this.#gatewayDelegations();
		const flushed: DiscordGatewayDelegation[] = [];
		for (const delegation of delegations) {
			if (!isTerminalDelegation(delegation)) {
				continue;
			}
			await this.#recordDelegationResult(delegation);
			await this.#mirrorDelegationResult(delegation);
			flushed.push(delegation);
		}
		if (flushed.length > 0 && stringValue(args.wake) !== "false") {
			this.#enqueueWake({
				kind: groupId ? "group" : "delegation",
				groupId,
				delegationIds: flushed.map((delegation) => delegation.id),
				reason: groupId
					? `Delegation group ${groupId} was manually flushed.`
					: "Delegation results were manually flushed.",
			});
			await this.#processPendingWakes();
		}
		await this.#persist();
		return { flushed };
	}

	#delegationGroups(): Array<{
		groupId: string;
		total: number;
		active: number;
		terminal: number;
		pendingWake: boolean;
	}> {
		const groups = new Map<string, DiscordGatewayDelegation[]>();
		for (const delegation of this.#gatewayDelegations()) {
			if (!delegation.groupId) {
				continue;
			}
			const existing = groups.get(delegation.groupId) ?? [];
			existing.push(delegation);
			groups.set(delegation.groupId, existing);
		}
		return [...groups.entries()].map(([groupId, delegations]) => ({
			groupId,
			total: delegations.length,
			active: delegations.filter((delegation) => delegation.status === "active").length,
			terminal: delegations.filter(isTerminalDelegation).length,
			pendingWake: this.#gatewayPendingWakes().some((wake) =>
				wake.groupId === groupId && !wake.startedAt
			),
		}));
	}

	async #ensureDelegationWorkbench(
		delegation: DiscordGatewayDelegation,
	): Promise<unknown> {
		return await this.#syncDelegationWorkbench(delegation, {
			includeTaskResult: false,
		});
	}

	async #syncDelegationWorkbench(
		delegation: DiscordGatewayDelegation,
		options: { includeTaskResult: boolean },
	): Promise<unknown> {
		const surface = this.#gatewaySurfaceForDelegation(delegation);
		if (surface) {
			delegation.surfaceKey ??= surface.key;
		}
		const config = this.#gatewayWorkbenchConfig(surface);
		if (!config) {
			return { enabled: false };
		}
		try {
			const workspace = await this.#ensureWorkspaceSurface(delegation, config);
			if (delegation.discordTaskThreadId) {
				await this.#ensureDelegationTaskThread(delegation, workspace, config);
			}
			if (options.includeTaskResult) {
				await this.#mirrorDelegationResultToTaskThread(delegation);
			}
			await this.#updateWorkspaceSurface(workspace);
			return {
				enabled: true,
				workspace: {
					key: workspace.key,
					cwd: workspace.cwd,
					threadId: workspace.discordThreadId,
				},
				taskThreadId: delegation.discordTaskThreadId,
			};
		} catch (error) {
			const message = errorMessage(error);
			this.#debug("gateway.workbench.sync.failed", {
				delegationId: delegation.id,
				codexThreadId: delegation.codexThreadId,
				error: message,
			});
			return { enabled: true, error: message };
		}
	}

	async #materializeWorkspaceThread(
		codexThreadId: string,
		input: { author: { id: string }; surface?: GatewaySurface },
	): Promise<DiscordBridgeSession> {
		const delegation = this.#delegationForThread(codexThreadId);
		const observed = this.#observedThreadForThread(codexThreadId);
		let surface = input.surface ??
			(delegation ? this.#gatewaySurfaceForDelegation(delegation) : undefined) ??
			(observed ? this.#gatewaySurfaceForObserved(observed) : undefined);
		let config = this.#gatewayWorkbenchConfig(surface);
		const existing = this.#requireState().sessions.find((session) =>
			session.codexThreadId === codexThreadId &&
			(!config || session.parentChannelId === config.taskThreadsChannelId)
		);
		if (existing) {
			existing.surfaceKey ??= this.#gatewaySurfaceForSession(existing)?.key;
			this.#registerRunner(existing).start();
			return existing;
		}

		const resumed = await this.client.resumeThread(
			this.#threadResumeParams(codexThreadId, delegation?.cwd ?? observed?.cwd),
		);
		const thread = threadFromResponse(resumed);
		const cwd = resumeResponseCwd(resumed) ?? thread?.cwd ?? delegation?.cwd ??
			observed?.cwd ??
			this.config.cwd;
		surface = surface ?? this.#gatewaySurfaceForCwd(cwd);
		if (surface) {
			if (delegation) {
				delegation.surfaceKey ??= surface.key;
			}
			if (observed) {
				observed.surfaceKey ??= surface.key;
			}
		}
		config = this.#gatewayWorkbenchConfig(surface);
		if (!config) {
			throw new Error("Gateway workbench is not enabled for this surface.");
		}
		const existingForSurface = this.#requireState().sessions.find((session) =>
			session.codexThreadId === codexThreadId &&
			session.parentChannelId === config.taskThreadsChannelId
		);
		if (existingForSurface) {
			existingForSurface.surfaceKey ??= surface?.key;
			this.#registerRunner(existingForSurface).start();
			return existingForSurface;
		}
		const title = delegation?.title ?? observed?.title ?? (thread
			? codexThreadTitle(thread)
			: `Codex ${compactId(codexThreadId)}`);
		const workspace = await this.#ensureWorkspaceSurfaceForCwd(
			workspaceCwdForPath(cwd, this.config.cwd),
			config,
		);
		const discordThreadId = await this.presenter.createThread(
			config.taskThreadsChannelId,
			truncateDiscordThreadName(`${workspace.title}: ${title}`),
		);
		const session: DiscordBridgeSession = {
			discordThreadId,
			parentChannelId: config.taskThreadsChannelId,
			codexThreadId,
			title,
			createdAt: this.#now().toISOString(),
			ownerUserId: input.author.id,
			cwd,
			mode: "workspace",
			surfaceKey: surface?.key,
		};
		this.#requireState().sessions.push(session);
		this.#registerRunner(session).start();

		if (delegation) {
			delegation.workspaceKey = workspace.key;
			delegation.discordWorkspaceThreadId = workspace.discordThreadId;
			delegation.discordTaskThreadId = discordThreadId;
			delegation.discordDetailThreadId ??= discordThreadId;
			delegation.updatedAt = this.#now().toISOString();
			await this.#mirrorDelegationResultToTaskThread(delegation);
		}
		await this.#updateWorkspaceSurface(workspace);
		await this.#persist();
		this.#debug("gateway.workbench.thread.opened", {
			codexThreadId,
			discordThreadId,
			workspaceKey: workspace.key,
		});
		return session;
	}

	async #reconcileGatewayWorkbench(): Promise<void> {
		if (
			this.#gatewaySurfaces().every((surface) =>
				!this.#gatewayWorkbenchConfig(surface)
			)
		) {
			return;
		}
		for (const cwd of await this.#discoverGatewayWorkspaceCwds()) {
			try {
				const surface = this.#gatewaySurfaceForCwd(cwd);
				const config = this.#gatewayWorkbenchConfig(surface);
				if (!config) {
					continue;
				}
				const workspace = await this.#ensureWorkspaceSurfaceForCwd(cwd, config);
				await this.#updateWorkspaceSurface(workspace);
			} catch (error) {
				this.#error("gateway.workbench.workspaceDiscovery.failed", {
					cwd,
					error: errorMessage(error),
				});
			}
		}
		for (const delegation of this.#gatewayDelegations()) {
			await this.#syncDelegationWorkbench(delegation, {
				includeTaskResult: false,
			});
		}
		await this.#persist();
	}

	async #discoverGatewayWorkspaceCwds(): Promise<string[]> {
		const root = normalizeWorkspaceCwd(this.config.cwd);
		let entries: Dirent[];
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch (error) {
			this.#debug("gateway.workbench.workspaceDiscovery.skipped", {
				root,
				error: errorMessage(error),
			});
			return [];
		}
		const cwds: string[] = [];
		for (const entry of entries) {
			if (!isDiscoverableWorkspaceEntry(entry.name)) {
				continue;
			}
			const fullPath = path.join(root, entry.name);
			if (entry.isDirectory()) {
				cwds.push(fullPath);
				continue;
			}
			if (!entry.isSymbolicLink()) {
				continue;
			}
			try {
				if ((await stat(fullPath)).isDirectory()) {
					cwds.push(fullPath);
				}
			} catch {
				continue;
			}
		}
		return uniqueStringList(cwds.map((cwd) => normalizeWorkspaceCwd(cwd))).sort(
			(left, right) =>
				workspaceTitle(left).localeCompare(workspaceTitle(right)) ||
				left.localeCompare(right),
		);
	}

	async #ensureWorkspaceSurface(
		delegation: DiscordGatewayDelegation,
		config: GatewayWorkbenchConfig,
	): Promise<DiscordGatewayWorkspaceSurface> {
		const workspace = await this.#ensureWorkspaceSurfaceForCwd(
			workspaceCwdForPath(delegation.cwd ?? this.config.cwd, this.config.cwd),
			config,
			[delegation],
		);
		delegation.workspaceKey = workspace.key;
		delegation.surfaceKey = workspace.surfaceKey;
		delegation.discordWorkspaceThreadId = workspace.discordThreadId;
		return workspace;
	}

	async #ensureWorkspaceSurfaceForCwd(
		cwd: string,
		config: GatewayWorkbenchConfig,
		delegations: DiscordGatewayDelegation[] = [],
	): Promise<DiscordGatewayWorkspaceSurface> {
		if (!this.presenter.createWorkspacePost) {
			throw new Error("Gateway presenter cannot create workspace posts.");
		}
		const normalizedCwd = normalizeWorkspaceCwd(cwd);
		const key = workspaceKey(normalizedCwd);
		const now = this.#now().toISOString();
		const delegationIds = delegations.map((delegation) => delegation.id);
		let workspace = this.#gatewayWorkspaces().find((candidate) =>
			candidate.key === key &&
			(candidate.surfaceKey ?? config.surfaceKey) === config.surfaceKey
		);
		if (!workspace) {
			const title = workspaceTitle(normalizedCwd);
			const created = await this.presenter.createWorkspacePost(
				config.workspaceForumChannelId,
				truncateDiscordThreadName(title),
				workspaceDashboardText({
					key,
					surfaceKey: config.surfaceKey,
					cwd: normalizedCwd,
					title,
					discordThreadId: "pending",
					statusMessageId: undefined,
					delegationIds,
					createdAt: now,
					updatedAt: now,
				}, { delegations }),
			);
			workspace = {
				key,
				surfaceKey: config.surfaceKey,
				cwd: normalizedCwd,
				title,
				discordThreadId: created.threadId,
				statusMessageId: created.messageId,
				delegationIds,
				createdAt: now,
				updatedAt: now,
			};
			this.#gatewayWorkspaces().push(workspace);
			this.#debug("gateway.workbench.workspace.created", {
				key,
				cwd: normalizedCwd,
				discordThreadId: workspace.discordThreadId,
			});
			if (workspace.statusMessageId) {
				await this.#pinMessage(workspace.discordThreadId, workspace.statusMessageId);
			}
		}
		workspace.surfaceKey ??= config.surfaceKey;
		workspace.delegationIds = uniqueStringList([
			...workspace.delegationIds,
			...delegationIds,
		]);
		for (const delegation of delegations) {
			delegation.surfaceKey ??= config.surfaceKey;
		}
		workspace.updatedAt = now;
		return workspace;
	}

	async #ensureDelegationTaskThread(
		delegation: DiscordGatewayDelegation,
		workspace: DiscordGatewayWorkspaceSurface,
		config: GatewayWorkbenchConfig,
	): Promise<void> {
		if (!delegation.discordTaskThreadId) {
			delegation.discordWorkspaceThreadId = workspace.discordThreadId;
			return;
		}
		const existingSession = delegation.discordTaskThreadId
			? this.#requireState().sessions.find((session) =>
					session.discordThreadId === delegation.discordTaskThreadId &&
					session.codexThreadId === delegation.codexThreadId
				)
			: undefined;
		if (existingSession) {
			existingSession.surfaceKey ??= config.surfaceKey;
			delegation.discordDetailThreadId ??= delegation.discordTaskThreadId;
			delegation.surfaceKey ??= config.surfaceKey;
			delegation.discordWorkspaceThreadId = workspace.discordThreadId;
			this.#registerRunner(existingSession);
			return;
		}
		if (delegation.discordTaskThreadId) {
			const recovered: DiscordBridgeSession = {
				discordThreadId: delegation.discordTaskThreadId,
				parentChannelId: config.taskThreadsChannelId,
				codexThreadId: delegation.codexThreadId,
				title: delegation.title,
				createdAt: delegation.createdAt,
				cwd: delegation.cwd,
				mode: "delegated",
				surfaceKey: config.surfaceKey,
			};
			delegation.discordDetailThreadId ??= delegation.discordTaskThreadId;
			delegation.surfaceKey ??= config.surfaceKey;
			delegation.discordWorkspaceThreadId = workspace.discordThreadId;
			this.#requireState().sessions.push(recovered);
			this.#registerRunner(recovered);
			return;
		}
	}

	async #updateWorkspaceSurface(
		workspace: DiscordGatewayWorkspaceSurface,
	): Promise<void> {
		if (!this.presenter.updateMessage) {
			return;
		}
		if (!workspace.statusMessageId) {
			return;
		}
		const delegations = this.#gatewayDelegations().filter((delegation) =>
			workspace.delegationIds.includes(delegation.id)
		);
		const threads = this.#listWorkspaceDashboardThreads(workspace);
		await this.presenter.updateMessage(
			workspace.discordThreadId,
			workspace.statusMessageId,
			workspaceDashboardText(workspace, {
				delegations,
				threads,
			}),
		);
		if (workspace.statusMessageId) {
			await this.#pinMessage(workspace.discordThreadId, workspace.statusMessageId);
		}
	}

	#listWorkspaceDashboardThreads(
		workspace: DiscordGatewayWorkspaceSurface,
	): WorkspaceThreadSummary[] {
		const byId = new Map<string, WorkspaceThreadSummary>();
		const put = (thread: WorkspaceThreadSummary) => {
			const existing = byId.get(thread.id);
			byId.set(thread.id, {
				...existing,
				...thread,
				updatedAt: Math.max(existing?.updatedAt ?? 0, thread.updatedAt),
				discordThreadId: existing?.discordThreadId ?? thread.discordThreadId,
			});
		};

		for (const thread of this.#listOpenWorkspaceThreads(workspace)) {
			put(thread);
		}
		for (const delegation of this.#gatewayDelegations()) {
			if (this.#gatewaySurfaceForDelegation(delegation)?.key !==
					this.#gatewaySurfaceForWorkspace(workspace)?.key) {
				continue;
			}
			const delegationWorkspaceKey = delegation.workspaceKey ??
				workspaceKey(workspaceCwdForPath(delegation.cwd, this.config.cwd));
			if (
				delegationWorkspaceKey !== workspace.key ||
				(delegation.status !== "active" && delegation.lastStatus !== "in_progress")
			) {
				continue;
			}
			put({
				id: delegation.codexThreadId,
				title: delegation.title,
				cwd: delegation.cwd ?? workspace.cwd,
				status: delegation.lastStatus ?? delegation.status,
				updatedAt: Date.parse(delegation.updatedAt) / 1000,
				discordThreadId: delegation.discordTaskThreadId,
			});
		}
		for (const observed of this.#gatewayObservedThreads()) {
			if (this.#gatewaySurfaceForObserved(observed)?.key !==
					this.#gatewaySurfaceForWorkspace(workspace)?.key) {
				continue;
			}
			const observedWorkspaceKey = observed.workspaceKey ??
				workspaceKey(workspaceCwdForPath(observed.cwd, this.config.cwd));
			if (
				observedWorkspaceKey !== workspace.key ||
				!isObservedThreadActive(observed)
			) {
				continue;
			}
			put({
				id: observed.threadId,
				title: observed.title ?? `Codex ${compactId(observed.threadId)}`,
				cwd: observed.cwd ?? workspace.cwd,
				status: observedThreadStatusText(observed),
				updatedAt: Date.parse(observed.lastSeenAt) / 1000,
				discordThreadId: this.#workspaceDiscordThreadForCodexThread(
					observed.threadId,
					this.#gatewaySurfaceForWorkspace(workspace),
				)?.discordThreadId,
			});
		}

		return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
	}

	async #listWorkspaceThreads(
		workspace: DiscordGatewayWorkspaceSurface,
	): Promise<WorkspaceThreadSummary[]> {
		const byId = new Map<string, WorkspaceThreadSummary>();
		const surface = this.#gatewaySurfaceForWorkspace(workspace);
		for (const thread of await this.#listCodexThreadSummaries()) {
			if (
				workspaceKey(workspaceCwdForPath(thread.cwd, this.config.cwd)) ===
					workspace.key &&
				this.#gatewaySurfaceForCwd(thread.cwd)?.key === surface?.key
			) {
				byId.set(thread.id, {
					...thread,
					discordThreadId: this.#workspaceDiscordThreadForCodexThread(
						thread.id,
						surface,
					)?.discordThreadId,
				});
			}
		}
		for (const delegation of this.#gatewayDelegations()) {
			if (this.#gatewaySurfaceForDelegation(delegation)?.key !== surface?.key) {
				continue;
			}
			const delegationWorkspaceKey = delegation.workspaceKey ??
				workspaceKey(workspaceCwdForPath(delegation.cwd, this.config.cwd));
			if (
				delegationWorkspaceKey !== workspace.key ||
				byId.has(delegation.codexThreadId)
			) {
				continue;
			}
			byId.set(delegation.codexThreadId, {
				id: delegation.codexThreadId,
				title: delegation.title,
				cwd: delegation.cwd ?? workspace.cwd,
				status: delegation.lastStatus ?? delegation.status,
				updatedAt: Date.parse(delegation.updatedAt) / 1000,
				discordThreadId: delegation.discordTaskThreadId,
			});
		}
		for (const observed of this.#gatewayObservedThreads()) {
			if (this.#gatewaySurfaceForObserved(observed)?.key !== surface?.key) {
				continue;
			}
			const observedWorkspaceKey = observed.workspaceKey ??
				workspaceKey(workspaceCwdForPath(observed.cwd, this.config.cwd));
			if (observedWorkspaceKey !== workspace.key) {
				continue;
			}
			const existing = byId.get(observed.threadId);
			const observedSummary: WorkspaceThreadSummary = {
				id: observed.threadId,
				title: observed.title ?? `Codex ${compactId(observed.threadId)}`,
				cwd: observed.cwd ?? workspace.cwd,
				status: observedThreadStatusText(observed),
				updatedAt: Date.parse(observed.lastSeenAt) / 1000,
				discordThreadId: this.#workspaceDiscordThreadForCodexThread(
					observed.threadId,
					surface,
				)?.discordThreadId,
			};
			byId.set(
				observed.threadId,
				existing
					? {
							...existing,
							status: observedSummary.status,
							updatedAt: Math.max(existing.updatedAt, observedSummary.updatedAt),
							discordThreadId: existing.discordThreadId ??
								observedSummary.discordThreadId,
						}
					: observedSummary,
			);
		}
		return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
	}

	async #listWorkspaceGoalSummaries(
		workspace: DiscordGatewayWorkspaceSurface,
	): Promise<WorkspaceGoalSummary[]> {
		const threads = (await this.#listWorkspaceThreads(workspace)).slice(
			0,
			threadPickerReactions.length,
		);
		return await Promise.all(
			threads.map(async (thread) => {
				try {
					const response = await this.client.getThreadGoal({
						threadId: thread.id,
					});
					return { ...thread, goal: response.goal };
				} catch (error) {
					return { ...thread, goalError: errorMessage(error) };
				}
			}),
		);
	}

	async #goalSummaryForSession(
		session: DiscordBridgeSession,
	): Promise<WorkspaceGoalSummary> {
		try {
			const response = await this.client.getThreadGoal({
				threadId: session.codexThreadId,
			});
			return this.#goalSummaryFromSession(session, { goal: response.goal });
		} catch (error) {
			return this.#goalSummaryFromSession(session, {
				goalError: errorMessage(error),
			});
		}
	}

	#goalSummaryFromSession(
		session: DiscordBridgeSession,
		options: Pick<WorkspaceGoalSummary, "goal" | "goalError"> = {},
	): WorkspaceGoalSummary {
		return {
			id: session.codexThreadId,
			title: session.title,
			cwd: session.cwd ?? this.config.cwd ?? process.cwd(),
			status: this.#isSessionRunning(session, this.#requireState())
				? "active"
				: "open",
			updatedAt: Date.parse(session.createdAt) / 1000,
			discordThreadId: session.discordThreadId,
			...options,
		};
	}

	async #listActiveCodexThreadSummaries(
		surface: GatewaySurface | undefined = this.#primaryGatewaySurface(),
	): Promise<WorkspaceThreadSummary[]> {
		const byId = new Map<string, WorkspaceThreadSummary>();
		const put = (summary: WorkspaceThreadSummary) => {
			if (this.#gatewaySurfaceForCwd(summary.cwd)?.key !== surface?.key) {
				return;
			}
			const existing = byId.get(summary.id);
			byId.set(summary.id, {
				...existing,
				...summary,
				title: summary.title || existing?.title || `Codex ${compactId(summary.id)}`,
				cwd: summary.cwd || existing?.cwd || this.config.cwd || process.cwd(),
				status: summary.status || existing?.status || "active",
				updatedAt: Math.max(existing?.updatedAt ?? 0, summary.updatedAt),
				discordThreadId: existing?.discordThreadId ??
					summary.discordThreadId ??
					this.#discordChannelForCodexThread(summary.id, surface),
			});
		};

		for (const thread of await this.#listCodexThreadSummaries()) {
			if (thread.status === "active") {
				put({
					...thread,
					discordThreadId: this.#discordChannelForCodexThread(thread.id, surface),
				});
			}
		}

		const state = this.#requireState();
		for (const session of state.sessions) {
			if (!this.#isSessionRunning(session, state)) {
				continue;
			}
			put({
				id: session.codexThreadId,
				title: session.title,
				cwd: session.cwd ?? this.config.cwd ?? process.cwd(),
				status: "active",
				updatedAt: Date.parse(session.createdAt) / 1000,
				discordThreadId: session.discordThreadId,
			});
		}

		for (const delegation of this.#gatewayDelegations()) {
			if (delegation.status !== "active" && delegation.lastStatus !== "in_progress") {
				continue;
			}
			put({
				id: delegation.codexThreadId,
				title: delegation.title,
				cwd: delegation.cwd ?? this.config.cwd ?? process.cwd(),
				status: delegation.lastStatus ?? delegation.status,
				updatedAt: Date.parse(delegation.updatedAt) / 1000,
				discordThreadId: this.#discordChannelForCodexThread(
					delegation.codexThreadId,
					surface,
				),
			});
		}

		for (const observed of this.#gatewayObservedThreads()) {
			if (!isObservedThreadActive(observed)) {
				continue;
			}
			put({
				id: observed.threadId,
				title: observed.title ?? `Codex ${compactId(observed.threadId)}`,
				cwd: observed.cwd ?? this.config.cwd ?? process.cwd(),
				status: observedThreadStatusText(observed),
				updatedAt: Date.parse(observed.lastSeenAt) / 1000,
				discordThreadId: this.#discordChannelForCodexThread(observed.threadId, surface),
			});
		}

		return [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt);
	}

	#listOpenWorkspaceThreads(
		workspace: DiscordGatewayWorkspaceSurface,
	): WorkspaceThreadSummary[] {
		const surface = this.#gatewaySurfaceForWorkspace(workspace);
		const workbench = this.#gatewayWorkbenchConfig(surface);
		if (!workbench) {
			return [];
		}
		const sessions = this.#requireState().sessions.filter((session) =>
			session.parentChannelId === workbench.taskThreadsChannelId &&
			workspaceKey(workspaceCwdForPath(session.cwd, this.config.cwd)) ===
				workspace.key &&
			this.#gatewaySurfaceForSession(session)?.key === surface?.key
		);
		return sessions.map((session) => ({
			id: session.codexThreadId,
			title: session.title,
			cwd: session.cwd ?? workspace.cwd,
			status: this.#isSessionRunning(session, this.#requireState())
				? "active"
				: "open",
			updatedAt: Date.parse(session.createdAt) / 1000,
			discordThreadId: session.discordThreadId,
		})).sort((left, right) => right.updatedAt - left.updatedAt);
	}

	async #listCodexThreadSummaries(): Promise<WorkspaceThreadSummary[]> {
		const summaries: WorkspaceThreadSummary[] = [];
		let cursor: string | null | undefined;
		for (let page = 0; page < 10; page += 1) {
			let response: v2.ThreadListResponse;
			try {
				response = await this.client.listThreads({
					cursor: cursor ?? null,
					limit: 100,
					sortKey: "updated_at",
					sortDirection: "desc",
					archived: false,
					sourceKinds: [],
					useStateDbOnly: false,
				});
			} catch (error) {
				this.#debug("gateway.workbench.threadList.failed", {
					error: errorMessage(error),
				});
				return summaries;
			}
			for (const thread of response.data) {
				summaries.push({
					id: thread.id,
					title: codexThreadTitle(thread),
					cwd: thread.cwd,
					status: threadStatusText(thread.status),
					updatedAt: thread.updatedAt,
					discordThreadId: this.#workspaceDiscordThreadForCodexThread(thread.id)
						?.discordThreadId,
				});
			}
			if (!response.nextCursor) {
				break;
			}
			cursor = response.nextCursor;
		}
		return summaries;
	}

	#workspaceDiscordThreadForCodexThread(
		codexThreadId: string,
		surface?: GatewaySurface,
	): DiscordBridgeSession | undefined {
		const workbench = this.#gatewayWorkbenchConfig(surface);
		return this.#requireState().sessions.find((session) =>
			session.codexThreadId === codexThreadId &&
			session.parentChannelId === workbench?.taskThreadsChannelId
		);
	}

	#discordChannelForCodexThread(
		codexThreadId: string,
		surface: GatewaySurface | undefined = this.#primaryGatewaySurface(),
	): string | undefined {
		if (this.#isGatewayMainThread(codexThreadId)) {
			return surface?.homeChannelId ?? this.config.gateway?.homeChannelId;
		}
		const session = this.#requireState().sessions.find((candidate) =>
			candidate.codexThreadId === codexThreadId &&
			this.#gatewaySurfaceForSession(candidate)?.key === surface?.key
		);
		const delegation = this.#delegationForThread(codexThreadId);
		const delegationChannel = delegation &&
				this.#gatewaySurfaceForDelegation(delegation)?.key === surface?.key
			? delegation.discordTaskThreadId ?? delegation.discordDetailThreadId
			: undefined;
		return session?.discordThreadId ??
			delegationChannel;
	}

	#workspaceForChannel(channelId: string): DiscordGatewayWorkspaceSurface | undefined {
		const workspaces = this.#requireState().gateway?.workspaces ?? [];
		const direct = workspaces.find((workspace) =>
			workspace.discordThreadId === channelId
		);
		if (direct) {
			return direct;
		}
		const session = this.#requireState().sessions.find((candidate) =>
			candidate.discordThreadId === channelId
		);
		if (!session?.cwd) {
			return undefined;
		}
		const key = workspaceKey(workspaceCwdForPath(session.cwd, this.config.cwd));
		const surface = this.#gatewaySurfaceForSession(session);
		return workspaces.find((workspace) =>
			workspace.key === key &&
			this.#gatewaySurfaceForWorkspace(workspace)?.key === surface?.key
		);
	}

	#sessionForDiscordThread(channelId: string): DiscordBridgeSession | undefined {
		const session = this.#requireState().sessions.find((candidate) =>
			candidate.discordThreadId === channelId
		);
		if (
			!session ||
			session.mode === "gateway" ||
			session.discordThreadId === session.parentChannelId
		) {
			return undefined;
		}
		return session;
	}

	#workspaceForGoalSession(
		session: DiscordBridgeSession,
	): DiscordGatewayWorkspaceSurface {
		const existing = this.#workspaceForChannel(session.discordThreadId);
		if (existing) {
			return existing;
		}
		const cwd = workspaceCwdForPath(session.cwd, this.config.cwd);
		const surface = this.#gatewaySurfaceForSession(session);
		return {
			key: workspaceKey(cwd),
			surfaceKey: surface?.key,
			cwd,
			title: workspaceTitle(cwd),
			discordThreadId: session.parentChannelId,
			delegationIds: [],
			createdAt: session.createdAt,
			updatedAt: session.createdAt,
		};
	}

	#workspaceForumForChannel(
		channelId: string,
	): DiscordGatewayWorkspaceSurface | undefined {
		return this.#requireState().gateway?.workspaces?.find((workspace) =>
			workspace.discordThreadId === channelId
		);
	}

	async #mirrorDelegationResultToTaskThread(
		delegation: DiscordGatewayDelegation,
	): Promise<void> {
		if (
			!delegation.discordTaskThreadId ||
			!delegation.lastFinal ||
			delegation.taskMirroredAt ||
			this.#hasDelegationTaskFinalDelivery(delegation)
		) {
			return;
		}
		const outboundMessageIds = await this.presenter.sendMessage(
			delegation.discordTaskThreadId,
			delegationTaskResultText(delegation),
		);
		const deliveredAt = this.#now().toISOString();
		this.#requireState().deliveries.push({
			discordMessageId: `gateway-workbench:${delegation.id}:${delegation.lastTurnId ?? "latest"}`,
			discordThreadId: delegation.discordTaskThreadId,
			codexThreadId: delegation.codexThreadId,
			turnId: delegation.lastTurnId,
			kind: "final",
			outboundMessageIds,
			deliveredAt,
		});
		delegation.taskMirroredAt = deliveredAt;
		delegation.updatedAt = deliveredAt;
	}

	#hasDelegationTaskFinalDelivery(delegation: DiscordGatewayDelegation): boolean {
		if (!delegation.discordTaskThreadId) {
			return false;
		}
		return this.#requireState().deliveries.some((delivery) =>
			delivery.kind === "final" &&
			delivery.discordThreadId === delegation.discordTaskThreadId &&
			delivery.codexThreadId === delegation.codexThreadId &&
			(!delegation.lastTurnId || delivery.turnId === delegation.lastTurnId)
		);
	}

	async #startGatewayStopHookSpool(): Promise<void> {
		if (!this.config.gateway || this.#gatewayStopHookWatcher) {
			return;
		}
		const spoolDir = this.#gatewayStopHookSpoolDir();
		await ensureStopHookSpool(spoolDir);
		const pendingDir = stopHookSpoolPaths(spoolDir).pending;
		this.#gatewayStopHookWatcher = watch(pendingDir, { persistent: false }, () => {
			this.#scheduleGatewayStopHookDrain();
		});
		this.#gatewayStopHookWatcher.on("error", (error) => {
			this.#debug("gateway.stopHook.watch.failed", {
				error: errorMessage(error),
			});
		});
		await this.#drainGatewayStopHookSpool();
	}

	#scheduleGatewayStopHookDrain(delayMs = stopHookDrainDebounceMs): void {
		if (!this.config.gateway) {
			return;
		}
		if (this.#gatewayStopHookDrainTimer) {
			clearTimeout(this.#gatewayStopHookDrainTimer);
		}
		this.#gatewayStopHookDrainTimer = setTimeout(() => {
			this.#gatewayStopHookDrainTimer = undefined;
			void this.#drainGatewayStopHookSpool().catch((error) => {
				this.#debug("gateway.stopHook.drain.failed", {
					error: errorMessage(error),
				});
			});
		}, delayMs);
		this.#gatewayStopHookDrainTimer.unref?.();
	}

	async #drainGatewayStopHookSpool(): Promise<void> {
		const drain = this.#gatewayStopHookDrainChain
			.catch(() => undefined)
			.then(() => this.#drainGatewayStopHookSpoolOnce());
		this.#gatewayStopHookDrainChain = drain.catch(() => undefined);
		await drain;
	}

	async #drainGatewayStopHookSpoolOnce(): Promise<void> {
		if (!this.config.gateway) {
			return;
		}
		const spoolDir = this.#gatewayStopHookSpoolDir();
		const files = await readPendingStopHookSpoolFiles(spoolDir);
		let shouldRetry = false;
		for (const file of files) {
			if ("error" in file) {
				this.#debug("gateway.stopHook.file.invalid", {
					fileName: file.fileName,
					error: file.error.message,
				});
				await archiveStopHookSpoolFile(file, spoolDir, "failed");
				continue;
			}
			const processedIds = this.#gatewayProcessedHookEventIds();
			if (processedIds.includes(file.event.id)) {
				await archiveStopHookSpoolFile(file, spoolDir, "ignored");
				continue;
			}
			const result = await this.#handleGatewayHookEvent(file.event);
			if (result === "retry") {
				shouldRetry = true;
				continue;
			}
			processedIds.push(file.event.id);
			if (file.event.eventName === "Stop") {
				const gateway = this.#requireState().gateway;
				const stopIds = gateway?.processedStopHookEventIds ?? [];
				if (!stopIds.includes(file.event.id)) {
					stopIds.push(file.event.id);
				}
				if (gateway) {
					gateway.processedStopHookEventIds = stopIds;
				}
			}
			await this.#persist();
			await archiveStopHookSpoolFile(
				file,
				spoolDir,
				result === "processed" ? "processed" : "ignored",
			);
		}
		if (shouldRetry) {
			this.#scheduleGatewayStopHookDrain(stopHookRetryMs);
		}
	}

	async #handleGatewayHookEvent(
		event: DiscordGatewayHookEvent,
	): Promise<"processed" | "ignored" | "retry"> {
		const isGatewayMain = this.#isGatewayMainThread(event.sessionId);
		if (!isGatewayMain) {
			await this.#recordObservedThreadEvent(event);
		}
		if (event.eventName !== "Stop") {
			return "processed";
		}
		if (isGatewayMain) {
			const started = await this.#processPendingWakes({
				completedThreadId: event.sessionId,
				completedTurnId: event.turnId,
			});
			return started || !this.#gatewayPendingWakes().some((wake) => !wake.startedAt)
				? "processed"
				: "retry";
		}
		const delegation = this.#delegationForThread(event.sessionId);
		if (!delegation) {
			return "processed";
		}
		const completedAt = this.#now().toISOString();
		delegation.status = "complete";
		delegation.lastTurnId = event.turnId ?? delegation.lastTurnId;
		delegation.lastStatus = "completed";
		delegation.lastFinal = event.lastAssistantMessage ?? delegation.lastFinal;
		delegation.completedAt = completedAt;
		delegation.updatedAt = completedAt;
		await this.#syncDelegationWorkbench(delegation, { includeTaskResult: true });
		await this.#applyDelegationReturnPolicy(delegation);
		await this.#processPendingWakes();
		return "processed";
	}

	async #recordObservedThreadEvent(
		event: DiscordGatewayHookEvent,
	): Promise<void> {
		const observedThreads = this.#gatewayObservedThreads();
		const seenAt = event.createdAt || this.#now().toISOString();
		let observed = observedThreads.find((thread) =>
			thread.threadId === event.sessionId
		);
		if (!observed) {
			observed = {
				threadId: event.sessionId,
				title: observedThreadTitle(event),
				status: observedStatusForHookEvent(event),
				firstSeenAt: seenAt,
				lastSeenAt: seenAt,
				updatedAt: seenAt,
			};
			observedThreads.push(observed);
		}

		const cwd = event.cwd ?? observed.cwd;
		const surface = this.#gatewaySurfaceForCwd(cwd);
		observed.status = observedStatusForHookEvent(event);
		observed.cwd = cwd;
		observed.workspaceKey = cwd
			? workspaceKey(workspaceCwdForPath(cwd, this.config.cwd))
			: observed.workspaceKey;
		observed.surfaceKey = surface?.key ?? observed.surfaceKey;
		observed.model = event.model ?? observed.model;
		observed.transcriptPath = event.transcriptPath ?? observed.transcriptPath;
		observed.lastTurnId = event.turnId ?? observed.lastTurnId;
		observed.lastHookEventName = event.eventName;
		observed.source = event.source ?? observed.source;
		observed.promptPreview = event.promptPreview ?? observed.promptPreview;
		observed.assistantPreview = event.lastAssistantMessage
			? previewText(event.lastAssistantMessage)
			: observed.assistantPreview;
		observed.toolName = event.toolName ?? observed.toolName;
		observed.toolUseId = event.toolUseId ?? observed.toolUseId;
		observed.toolInputPreview = event.toolInputPreview ?? observed.toolInputPreview;
		observed.toolResponsePreview = event.toolResponsePreview ??
			observed.toolResponsePreview;
		observed.permissionDescription = event.permissionDescription ??
			observed.permissionDescription;
		observed.title = observedThreadTitle(event, observed);
		observed.lastSeenAt = seenAt;
		observed.updatedAt = seenAt;

		const config = this.#gatewayWorkbenchConfig(surface);
		if (config && cwd) {
			const workspace = await this.#ensureWorkspaceSurfaceForCwd(
				workspaceCwdForPath(cwd, this.config.cwd),
				config,
			);
			try {
				await this.#updateWorkspaceSurface(workspace);
			} catch (error) {
				this.#debug("gateway.observed.workspaceUpdate.failed", {
					workspaceKey: workspace.key,
					threadId: observed.threadId,
					error: errorMessage(error),
				});
			}
		}
	}

	async #applyDelegationReturnPolicy(
		delegation: DiscordGatewayDelegation,
	): Promise<void> {
		if (!isTerminalDelegation(delegation)) {
			return;
		}
		const mode = delegation.returnMode ?? "manual";
		if (mode === "detached" || mode === "manual") {
			return;
		}
		await this.#recordDelegationResult(delegation);
		await this.#mirrorDelegationResult(delegation);
		if (mode === "wake_on_done") {
			this.#enqueueWake({
				kind: "delegation",
				delegationIds: [delegation.id],
				reason: `Delegation ${delegation.title} completed.`,
			});
		}
		if (mode === "wake_on_group" && delegation.groupId) {
			const group = this.#gatewayDelegations().filter((candidate) =>
				candidate.groupId === delegation.groupId
			);
			if (group.length > 0 && group.every(isTerminalDelegation)) {
				this.#enqueueWake({
					kind: "group",
					groupId: delegation.groupId,
					delegationIds: group.map((candidate) => candidate.id),
					reason: `Delegation group ${delegation.groupId} completed.`,
				});
			}
		}
	}

	async #recordDelegationResult(delegation: DiscordGatewayDelegation): Promise<void> {
		const gatewaySession = this.#gatewaySession();
		if (!gatewaySession || delegation.injectedAt) {
			return;
		}
		await this.client.injectThreadItems({
			threadId: gatewaySession.codexThreadId,
			items: [
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_text",
							text: delegationResultText(delegation),
						},
					],
				},
			],
		});
		delegation.injectedAt = this.#now().toISOString();
		delegation.updatedAt = delegation.injectedAt;
	}

	async #mirrorDelegationResult(delegation: DiscordGatewayDelegation): Promise<void> {
		const surface = this.#gatewaySurfaceForDelegation(delegation);
		const homeChannelId = surface?.homeChannelId ??
			(this.config.gateway?.surfaces?.length ? undefined : this.config.gateway?.homeChannelId);
		if (!homeChannelId || delegation.mirroredAt) {
			return;
		}
		await this.#syncDelegationWorkbench(delegation, { includeTaskResult: true });
		const hasWorkbenchLinks = Boolean(
			delegation.discordWorkspaceThreadId || delegation.discordTaskThreadId,
		);
		await this.presenter.sendMessage(
			homeChannelId,
			this.#gatewayWorkbenchConfig(surface) && hasWorkbenchLinks
				? compactDelegationResultText(delegation)
				: delegationResultText(delegation),
		);
		delegation.mirroredAt = this.#now().toISOString();
		delegation.updatedAt = delegation.mirroredAt;
	}

	#enqueueWake(input: {
		kind: DiscordGatewayPendingWake["kind"];
		delegationIds: string[];
		groupId?: string;
		reason: string;
	}): void {
		const delegationIds = [...new Set(input.delegationIds)].sort();
		if (delegationIds.length === 0) {
			return;
		}
		const wakes = this.#gatewayPendingWakes();
		if (wakes.some((wake) =>
			wake.kind === input.kind &&
			wake.groupId === input.groupId &&
			sameStringSet(wake.delegationIds, delegationIds)
		)) {
			return;
		}
		wakes.push({
			id: wakeId(input.kind, input.groupId, delegationIds),
			kind: input.kind,
			groupId: input.groupId,
			delegationIds,
			reason: input.reason,
			createdAt: this.#now().toISOString(),
		});
	}

	async #processPendingWakes(options: {
		completedThreadId?: string;
		completedTurnId?: string;
	} = {}): Promise<boolean> {
		const gatewaySession = this.#gatewaySession();
		if (
			!gatewaySession ||
			this.#isSessionRunning(gatewaySession, this.#requireState(), options)
		) {
			return false;
		}
		const wake = this.#gatewayPendingWakes().find((candidate) => !candidate.startedAt);
		if (!wake) {
			return false;
		}
		const prompt = wakePrompt(wake, this.#gatewayDelegations());
		let turn: v2.TurnStartResponse;
		try {
			turn = await this.client.startTurn({
				threadId: gatewaySession.codexThreadId,
				input: [{ type: "text", text: prompt, text_elements: [] }],
				cwd: gatewaySession.cwd ?? this.config.cwd ?? null,
				model: this.config.model ?? null,
				serviceTier: this.config.serviceTier ?? null,
				effort: this.config.effort ?? null,
				summary: this.config.summary ?? null,
				approvalPolicy: this.config.approvalPolicy ?? null,
				permissions: this.config.permissions ?? null,
				outputSchema: null,
			});
		} catch (error) {
			if (errorMessage(error).includes("already has an active turn")) {
				this.#debug("gateway.wake.deferred.activeTurn", {
					wakeId: wake.id,
					error: errorMessage(error),
				});
				return false;
			}
			throw error;
		}
		wake.startedAt = this.#now().toISOString();
		for (const delegation of this.#gatewayDelegations()) {
			if (wake.delegationIds.includes(delegation.id)) {
				delegation.reportedAt = wake.startedAt;
				delegation.updatedAt = wake.startedAt;
			}
		}
		this.#debug("gateway.wake.started", {
			wakeId: wake.id,
			turnId: turn.turn.id,
			kind: wake.kind,
			groupId: wake.groupId,
		});
		return true;
	}

	async #listFlowRuns(args: Record<string, unknown>): Promise<unknown> {
		const result = await this.#requireFlowBackendClient().listRuns({
			eventId: stringValue(args.eventId),
			status: stringValue(args.status),
			limit: positiveIntegerValue(args.limit),
		});
		return {
			...(result.eventId ? { eventId: result.eventId } : {}),
			runs: result.runs,
		};
	}

	async #listFlowEvents(args: Record<string, unknown>): Promise<unknown> {
		const result = await this.#requireFlowBackendClient().listEvents({
			type: stringValue(args.type),
			limit: positiveIntegerValue(args.limit),
		});
		return {
			events: result.events,
		};
	}

	#requireFlowBackendClient(): FlowBackendClient {
		if (this.#flowBackendClient) {
			return this.#flowBackendClient;
		}
		const baseUrl = this.config.flowBackendUrl;
		if (!baseUrl) {
			throw new Error("No flow backend URL configured.");
		}
		this.#flowBackendClient = createFlowBackendHttpClient({ baseUrl });
		return this.#flowBackendClient;
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

	#observedThreadForThread(
		threadId: string,
	): DiscordGatewayObservedThread | undefined {
		return this.#gatewayObservedThreads().find((thread) =>
			thread.threadId === threadId
		);
	}

	#isSessionRunning(
		session: DiscordBridgeSession,
		state: DiscordBridgeState,
		options: {
			completedThreadId?: string;
			completedTurnId?: string;
		} = {},
	): boolean {
		const isGateway = session.mode === "gateway";
		const hasActiveTurn = state.activeTurns.some(
			(active) =>
				(isGateway || active.discordThreadId === session.discordThreadId) &&
				active.codexThreadId === session.codexThreadId &&
				!(
					active.codexThreadId === options.completedThreadId &&
					active.turnId === options.completedTurnId
				),
		);
		if (hasActiveTurn) {
			return true;
		}
		return state.queue.some(
			(item) =>
				(isGateway || item.discordThreadId === session.discordThreadId) &&
				item.codexThreadId === session.codexThreadId &&
				item.status !== "failed" &&
				!(
					item.codexThreadId === options.completedThreadId &&
					item.turnId === options.completedTurnId
				),
		);
	}

	#isAllowedChannel(channelId: string): boolean {
		if (
			this.#gatewaySurfaceForHomeChannel(channelId) ||
			this.#gatewaySurfaceForWorkspaceForumChannel(channelId) ||
			this.#gatewaySurfaceForTaskThreadsChannel(channelId)
		) {
			return true;
		}
		if (this.config.allowedChannelIds.size === 0) {
			return true;
		}
		if (this.config.allowedChannelIds.has(channelId)) {
			return true;
		}
		if (
			this.#requireState().gateway?.workspaces?.some((workspace) =>
				workspace.discordThreadId === channelId
			)
		) {
			return true;
		}
		const session = this.#requireState().sessions.find(
			(candidate) => candidate.discordThreadId === channelId,
		);
		const workbench = this.#gatewayWorkbenchConfig(
			this.#gatewaySurfaceForSession(session),
		);
		return Boolean(
			session &&
				(this.config.allowedChannelIds.has(session.parentChannelId) ||
					session.parentChannelId === workbench?.taskThreadsChannelId ||
					session.parentChannelId === workbench?.workspaceForumChannelId),
		);
	}

	#commandRegistrationChannelIds(): string[] {
		return uniqueStringList([
			...this.config.allowedChannelIds,
			...this.#gatewaySurfaces().flatMap((surface) => [
				surface.homeChannelId,
				surface.workspaceForumChannelId ?? "",
				surface.taskThreadsChannelId ?? "",
			]),
		]);
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
		if (participantUserIds.length === 0 || !this.presenter.addThreadMembers) {
			return;
		}
		try {
			await this.presenter.addThreadMembers(discordThreadId, participantUserIds);
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

	async #pinMessage(channelId: string, messageId: string): Promise<void> {
		if (!this.presenter.pinMessage) {
			return;
		}
		try {
			await this.presenter.pinMessage(channelId, messageId);
		} catch (error) {
			this.#debug("discord.message.pinFailed", {
				channelId,
				messageId,
				error: errorMessage(error),
			});
		}
	}

	async #deleteSourceMessage(session: DiscordBridgeSession): Promise<void> {
		if (!session.sourceMessageId) {
			return;
		}
		try {
			await this.presenter.deleteMessage(
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
				groupId: optionalStringSchema("Optional delegation group id for fan-out/fan-in orchestration."),
				returnMode: optionalStringSchema("Return policy: detached, record_only, wake_on_done, wake_on_group, or manual."),
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
				groupId: optionalStringSchema("Optional delegation group id for fan-out/fan-in orchestration."),
				returnMode: optionalStringSchema("Return policy: detached, record_only, wake_on_done, wake_on_group, or manual."),
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
				groupId: optionalStringSchema("Optional delegation group id to assign for this turn."),
				returnMode: optionalStringSchema("Return policy: detached, record_only, wake_on_done, wake_on_group, or manual."),
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
			name: "set_delegation_policy",
			description: "Update return policy for one delegation or every delegation in a group.",
			inputSchema: objectSchema({
				delegationId: optionalStringSchema("Tracked delegation id."),
				threadId: optionalStringSchema("Tracked delegated Codex thread id."),
				groupId: optionalStringSchema("Delegation group id."),
				returnMode: stringSchema("Return policy: detached, record_only, wake_on_done, wake_on_group, or manual."),
			}, ["returnMode"]),
		},
		{
			namespace: "codex_gateway",
			name: "flush_delegation_results",
			description: "Manually inject and mirror completed delegation results, optionally waking the main operator.",
			inputSchema: objectSchema({
				delegationId: optionalStringSchema("Tracked delegation id."),
				threadId: optionalStringSchema("Tracked delegated Codex thread id."),
				groupId: optionalStringSchema("Delegation group id."),
				wake: optionalStringSchema("Set to false to avoid starting a main operator turn."),
			}),
		},
		{
			namespace: "codex_gateway",
			name: "list_delegation_groups",
			description: "List delegation groups and their terminal/active counts.",
			inputSchema: objectSchema({}),
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

function returnModeFromArgs(
	args: Record<string, unknown>,
	fallback: DiscordGatewayDelegationReturnMode | undefined,
): DiscordGatewayDelegationReturnMode | undefined {
	const value = stringValue(args.returnMode) ?? stringValue(args.returnPolicy);
	if (!value) {
		return fallback;
	}
	if (value === "immediate") {
		return "wake_on_done";
	}
	if (value === "group_barrier") {
		return "wake_on_group";
	}
	if (
		value === "detached" ||
		value === "record_only" ||
		value === "wake_on_done" ||
		value === "wake_on_group" ||
		value === "manual"
	) {
		return value;
	}
	throw new Error(`Invalid returnMode: ${value}`);
}

function isTerminalDelegation(delegation: DiscordGatewayDelegation): boolean {
	return delegation.status === "complete" ||
		delegation.status === "failed" ||
		delegation.status === "reported";
}

function delegationResultText(delegation: DiscordGatewayDelegation): string {
	return [
		"[discord-gateway delegation result]",
		`Delegation: ${delegation.title}`,
		`Delegation ID: ${delegation.id}`,
		`Thread: ${delegation.codexThreadId}`,
		delegation.groupId ? `Group: ${delegation.groupId}` : undefined,
		delegation.cwd ? `Dir: ${delegation.cwd}` : undefined,
		`Status: ${delegation.lastStatus ?? delegation.status}`,
		delegation.lastTurnId ? `Turn: ${delegation.lastTurnId}` : undefined,
		"",
		"Result:",
		delegation.lastFinal ?? "(no final assistant message captured)",
	].filter((line): line is string => line !== undefined).join("\n");
}

function delegationTaskResultText(delegation: DiscordGatewayDelegation): string {
	return [
		"**Delegation Result**",
		`Delegation: ${delegation.title}`,
		`Codex thread: \`${delegation.codexThreadId}\``,
		delegation.groupId ? `Group: \`${delegation.groupId}\`` : undefined,
		`Status: \`${delegation.lastStatus ?? delegation.status}\``,
		delegation.lastTurnId ? `Turn: \`${delegation.lastTurnId}\`` : undefined,
		"",
		delegation.lastFinal ?? "(no final assistant message captured)",
	].filter((line): line is string => line !== undefined).join("\n");
}

function compactDelegationResultText(delegation: DiscordGatewayDelegation): string {
	const links = [
		delegation.discordWorkspaceThreadId
			? `workspace <#${delegation.discordWorkspaceThreadId}>`
			: undefined,
		delegation.discordTaskThreadId
			? `task <#${delegation.discordTaskThreadId}>`
			: undefined,
	].filter((link): link is string => link !== undefined).join(", ");
	return [
		"[discord-gateway delegation result]",
		`${delegation.title}: ${delegation.lastStatus ?? delegation.status}`,
		delegation.groupId ? `Group: ${delegation.groupId}` : undefined,
		links ? `Links: ${links}` : undefined,
		delegation.lastTurnId ? `Turn: ${delegation.lastTurnId}` : undefined,
	].filter((line): line is string => line !== undefined).join("\n");
}

function workspaceDashboardText(
	workspace: DiscordGatewayWorkspaceSurface,
	options: {
		delegations?: DiscordGatewayDelegation[];
		threads?: WorkspaceThreadSummary[];
	} = {},
): string {
	const delegations = options.delegations ?? [];
	const threads = options.threads ?? [];
	const visibleThreads = threads.slice(0, 25);
	return [
		`**Workspace: ${workspace.title}**`,
		`Dir: \`${workspace.cwd}\``,
		`Visible threads: ${threads.length}`,
		`Tracked delegations: ${delegations.length}`,
		"",
		"**Visible Threads**",
		visibleThreads.length > 0
			? visibleThreads.map(workspaceThreadLine).join("\n")
			: "None",
		threads.length > visibleThreads.length
			? `Showing newest ${visibleThreads.length} of ${threads.length} threads.`
			: undefined,
		"",
		"Run `/threads` here to browse or resume workspace Codex threads.",
	].filter((line): line is string => line !== undefined).join("\n");
}

function workspaceThreadLine(
	thread: WorkspaceThreadSummary,
	index: number,
): string {
	const link = thread.discordThreadId ? `<#${thread.discordThreadId}>` : "`not opened`";
	const title = truncateDiscordThreadName(thread.title);
	return `${index + 1}. ${link} ${title} (${thread.status})`;
}

function activeThreadStatusLines(
	threads: WorkspaceThreadSummary[],
	openableThreads: WorkspaceThreadSummary[],
): string[] {
	const createIndexById = new Map(
		openableThreads.map((thread, index) => [thread.id, index]),
	);
	return threads.map((thread) => {
		const createIndex = createIndexById.get(thread.id);
		const marker = createIndex === undefined
			? "-"
			: threadPickerReactions[createIndex] ?? `${createIndex + 1}.`;
		const link = thread.discordThreadId ? `<#${thread.discordThreadId}>` : "`not opened`";
		const title = truncateDiscordThreadName(thread.title);
		return `${marker} ${link} ${title} (${thread.status})`;
	});
}

function goalPickerText(
	workspace: DiscordGatewayWorkspaceSurface,
	entries: WorkspaceGoalSummary[],
	total: number,
): string {
	return [
		`**Goals: ${workspace.title}**`,
		`Dir: \`${workspace.cwd}\``,
		"",
		...entries.map((entry, index) => {
			const link = entry.discordThreadId ? `<#${entry.discordThreadId}>` : "`not opened`";
			const title = truncateDiscordThreadName(entry.title);
			return `${threadPickerReactions[index]} ${link} ${title} - ${goalSummaryText(entry)}`;
		}),
		total > entries.length ? `Showing newest ${entries.length} of ${total}.` : undefined,
		"",
		"Choose a number to manage that thread's goal.",
	].filter((line): line is string => line !== undefined).join("\n");
}

function goalActionText(
	workspace: DiscordGatewayWorkspaceSurface,
	entry: WorkspaceGoalSummary,
	options: { prefix?: string } = {},
): string {
	const link = entry.discordThreadId ? `<#${entry.discordThreadId}>` : "`not opened`";
	const goal = entry.goal;
	return [
		options.prefix,
		`**Goal: ${truncateDiscordThreadName(entry.title)}**`,
		`Workspace: ${workspace.title}`,
		`Thread: ${link} \`${entry.id}\``,
		`Dir: \`${entry.cwd}\``,
		"",
		entry.goalError
			? `Goal: unavailable (${entry.goalError})`
			: goal
			? [
					`Goal: \`${goal.status}\` ${previewText(firstLine(goal.objective) ?? goal.objective, 180)}`,
					`Usage: ${goal.tokensUsed} tokens, ${Math.round(goal.timeUsedSeconds)}s${
						goal.tokenBudget ? ` of ${goal.tokenBudget} tokens` : ""
					}`,
				].join("\n")
			: "Goal: none",
		"",
		goalActionOptions(entry).length > 0
			? "Choose an action."
			: entry.goal
			? "No goal actions are available for this thread."
			: "Use `/goals objective:<objective>` in an opened Discord thread to create one.",
	].filter((line): line is string => line !== undefined).join("\n");
}

function hasGoalMutation(command: DiscordGoalsInbound): boolean {
	return command.objective !== undefined ||
		command.goalStatus !== undefined ||
		command.tokenBudget !== undefined;
}

function goalActionOptions(
	entry: WorkspaceGoalSummary,
): Array<{ id: string; label: string }> {
	const options: Array<{ id: string; label: string }> = [];
	if (!entry.discordThreadId) {
		options.push({ id: "open", label: "Open" });
	}
	if (entry.goal && !entry.goalError) {
		if (entry.goal.status !== "active") {
			options.push({ id: "status:active", label: "Active" });
		}
		if (entry.goal.status !== "paused") {
			options.push({ id: "status:paused", label: "Pause" });
		}
		if (entry.goal.status !== "complete") {
			options.push({ id: "status:complete", label: "Complete" });
		}
		options.push({ id: "clear", label: "Clear" });
	}
	return options;
}

function goalSummaryText(entry: WorkspaceGoalSummary): string {
	if (entry.goalError) {
		return `goal unavailable (${entry.goalError})`;
	}
	if (!entry.goal) {
		return "no goal";
	}
	return `\`${entry.goal.status}\` ${previewText(
		firstLine(entry.goal.objective) ?? entry.goal.objective,
		120,
	)}`;
}

function threadPickerText(
	workspace: DiscordGatewayWorkspaceSurface,
	threads: WorkspaceThreadSummary[],
	total: number,
	options: { action?: string } = {},
): string {
	return [
		`**Threads: ${workspace.title}**`,
		`Dir: \`${workspace.cwd}\``,
		"",
		...threads.map((thread, index) => {
			const link = thread.discordThreadId
				? `<#${thread.discordThreadId}>`
				: "`not opened`";
			const title = truncateDiscordThreadName(thread.title);
			return `${threadPickerReactions[index]} ${link} ${title} (${thread.status})`;
		}),
		total > threads.length ? `Showing newest ${threads.length} of ${total}.` : undefined,
		"",
		options.action ?? "Choose a number to open or resume that thread in Discord.",
	].filter((line): line is string => line !== undefined).join("\n");
}

function threadPickerKey(channelId: string, messageId: string): string {
	return `${channelId}:${messageId}`;
}

function threadPickerReactionIndex(emoji: string): number | undefined {
	const index = threadPickerReactions.indexOf(emoji);
	return index >= 0 ? index : undefined;
}

async function updateOrReply(
	interaction: Pick<DiscordThreadPickerInbound, "update" | "reply">,
	text: string,
): Promise<void> {
	if (interaction.update) {
		await interaction.update(text);
		return;
	}
	await interaction.reply?.(text);
}

function threadFromResponse(response: v2.ThreadResumeResponse): v2.Thread | undefined {
	const thread = (response as { thread?: unknown }).thread;
	return thread && typeof thread === "object" && "id" in thread
		? thread as v2.Thread
		: undefined;
}

function codexThreadTitle(thread: v2.Thread): string {
	return thread.name?.trim() ||
		firstLine(thread.preview)?.trim() ||
		`Codex ${compactId(thread.id)}`;
}

function threadStatusText(status: v2.ThreadStatus): string {
	return status.type === "active" ? "active" : status.type;
}

function observedThreadStatusText(thread: DiscordGatewayObservedThread): string {
	if (thread.status === "waiting" && thread.permissionDescription) {
		return `waiting: ${thread.permissionDescription}`;
	}
	if (thread.status === "tool" && thread.toolName) {
		return `tool: ${thread.toolName}`;
	}
	return thread.status;
}

function isObservedThreadActive(thread: DiscordGatewayObservedThread): boolean {
	return thread.status === "starting" ||
		thread.status === "active" ||
		thread.status === "tool" ||
		thread.status === "waiting";
}

function observedStatusForHookEvent(
	event: DiscordGatewayHookEvent,
): DiscordGatewayObservedThread["status"] {
	if (event.eventName === "SessionStart") {
		return "starting";
	}
	if (event.eventName === "UserPromptSubmit") {
		return "active";
	}
	if (event.eventName === "PermissionRequest") {
		return "waiting";
	}
	if (event.eventName === "PreToolUse" || event.eventName === "PostToolUse") {
		return "tool";
	}
	return "idle";
}

function observedThreadTitle(
	event: DiscordGatewayHookEvent,
	existing?: DiscordGatewayObservedThread,
): string {
	return firstLine(event.promptPreview)?.trim() ||
		firstLine(event.lastAssistantMessage)?.trim() ||
		existing?.title ||
		`Codex ${compactId(event.sessionId)}`;
}

function previewText(value: string, maxLength = 500): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function normalizeWorkspaceCwd(cwd: string | undefined): string {
	return path.resolve(cwd ?? process.cwd());
}

function workspaceCwdForPath(cwd: string | undefined, root: string | undefined): string {
	const normalizedRoot = normalizeWorkspaceCwd(root);
	const normalizedCwd = normalizeWorkspaceCwd(cwd ?? normalizedRoot);
	const relative = path.relative(normalizedRoot, normalizedCwd);
	if (!relative) {
		return normalizedRoot;
	}
	if (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		return normalizedCwd;
	}
	const [workspaceName] = relative.split(path.sep).filter(Boolean);
	return workspaceName ? path.join(normalizedRoot, workspaceName) : normalizedRoot;
}

function workspaceKey(cwd: string): string {
	return `workspace-${createHash("sha256").update(cwd).digest("hex").slice(0, 12)}`;
}

function workspaceTitle(cwd: string): string {
	const base = path.basename(cwd);
	return base && base !== path.sep ? base : cwd;
}

function uniqueStringList(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function isDiscoverableWorkspaceEntry(name: string): boolean {
	return Boolean(name) && !name.startsWith(".") && name !== "node_modules";
}

function wakePrompt(
	wake: DiscordGatewayPendingWake,
	delegations: DiscordGatewayDelegation[],
): string {
	const matching = delegations.filter((delegation) =>
		wake.delegationIds.includes(delegation.id)
	);
	const summary = matching.map((delegation) =>
		`- ${delegation.title} (${delegation.id}): ${delegation.lastStatus ?? delegation.status}`
	).join("\n");
	return [
		"[discord-gateway wake]",
		wake.reason,
		wake.groupId ? `Group: ${wake.groupId}` : undefined,
		"",
		"Delegation results have already been injected into this thread history.",
		"Review them and decide the next step.",
		summary ? ["", "Delegations:", summary].join("\n") : undefined,
	].filter((line): line is string => line !== undefined).join("\n");
}

function sameStringSet(left: string[], right: string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	const rightSet = new Set(right);
	return left.every((value) => rightSet.has(value));
}

function wakeId(
	kind: DiscordGatewayPendingWake["kind"],
	groupId: string | undefined,
	delegationIds: string[],
): string {
	return `wake-${createHash("sha256").update(
		JSON.stringify({ kind, groupId, delegationIds }),
	).digest("hex").slice(0, 12)}`;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.trunc(value);
	}
	if (typeof value !== "string" || !value.trim()) {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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
