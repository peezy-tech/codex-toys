import type { JsonRpcNotification } from "@peezy.tech/codex-flows/rpc";
import type { v2 } from "@peezy.tech/codex-flows/generated";
import type { CodexWorkspacePresenter } from "./workspace-backend.ts";

import type {
	DiscordConsoleMessageKind,
	DiscordConsoleOutput,
} from "./console-output.ts";
import type {
	CodexBridgeClient,
	DiscordBridgeActiveTurn,
	DiscordBridgeConfig,
	DiscordBridgeDelivery,
	DiscordBridgeQueueItem,
	DiscordBridgeSession,
	DiscordBridgeState,
	DiscordMessageInbound,
} from "./types.ts";

const maxAttempts = 3;
const defaultTypingIntervalMs = 8_000;
const defaultReconcileIntervalMs = 30_000;
const activeTurnRetryMs = 2_000;
const runningCommandStatusDelayMs = 5_000;

export type ThreadRunnerContext = {
	client: CodexBridgeClient;
	presenter: CodexWorkspacePresenter;
	config: DiscordBridgeConfig;
	getState(): DiscordBridgeState;
	persist(): Promise<void>;
	now(): Date;
	debug(event: string, fields?: Record<string, unknown>): void;
	consoleOutput?: DiscordConsoleOutput;
};

export class DiscordThreadRunner {
	readonly session: DiscordBridgeSession;
	#context: ThreadRunnerContext;
	#mailbox: Promise<void> = Promise.resolve();
	#stopped = false;
	#retryTimers = new Map<string, Timer>();
	#typingTimer: Timer | undefined;
	#typingTurnKey: string | undefined;
	#reconcileTimer: Timer | undefined;
	#runningCommandStatusTimers = new Map<string, Timer>();
	#finalAssistantText = new Map<string, string>();
	#agentMessageBuffers = new Map<string, string>();
	#completedAgentMessages = new Set<string>();
	#summaryBuffers = new Map<string, string>();
	#summaryMessages = new Map<string, string[]>();
	#goal: RuntimeGoal | undefined;
	#planExplanation: string | undefined;
	#planSteps: RuntimePlanStep[] = [];
	#planTextBuffers = new Map<string, string>();
	#runningCommands = new Map<string, RunningCommand>();
	#activities = new Map<string, RuntimeActivity>();
	#pinnedStatusMessageId: string | undefined;

	constructor(session: DiscordBridgeSession, context: ThreadRunnerContext) {
		this.session = session;
		this.#context = context;
	}

	start(): void {
		void this.#enqueue("runner.start", async () => {
			await this.#refreshGoal();
			await this.#ensureStatusMessage();
			await this.#cleanupDeliveredTurnProgress();
			await this.#reconcilePersistedProcessing();
			await this.#reconcilePersistedActiveTurns();
			await this.#processQueue();
		});
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		for (const timer of this.#retryTimers.values()) {
			clearTimeout(timer);
		}
		this.#retryTimers.clear();
		this.#stopTypingHeartbeat();
		this.#clearReconcileTimer();
		this.#clearRunningCommandStatusTimers();
		await this.#mailbox.catch(() => undefined);
	}

	enqueueMessage(message: DiscordMessageInbound): Promise<void> {
		return this.#enqueue("runner.enqueueMessage", async () => {
			await this.#enqueueMessage(message);
		});
	}

	handleNotification(message: JsonRpcNotification): Promise<void> {
		return this.#enqueue("runner.notification", async () => {
			await this.#handleNotification(message);
		});
	}

	flushSummariesForTest(): Promise<void> {
		return this.#enqueue("runner.flushSummariesForTest", async () => {
			for (const key of [...this.#summaryBuffers.keys()]) {
				await this.#finalizeSummary(summaryKeyParts(key));
			}
		});
	}

	ensureStatusMessage(): Promise<void> {
		return this.#enqueue("runner.ensureStatusMessage", async () => {
			await this.#refreshGoal();
			await this.#ensureStatusMessage();
		});
	}

	#enqueue(label: string, work: () => Promise<void>): Promise<void> {
		const run = this.#mailbox
			.catch(() => undefined)
			.then(async () => {
				if (this.#stopped) {
					return;
				}
				await work();
			});
		this.#mailbox = run.catch((error) => {
			this.#debug(`${label}.error`, { error: errorMessage(error) });
		});
		return run;
	}

	async #enqueueMessage(message: DiscordMessageInbound): Promise<void> {
		const state = this.#state();
		const content = message.content.trim();
		if (!content) {
			this.#debug("message.ignored.empty", {
				discordThreadId: this.session.discordThreadId,
				messageId: message.messageId,
			});
			return;
		}
		if (isDuplicate(state, message.messageId)) {
			this.#debug("message.ignored.duplicate", {
				discordThreadId: this.session.discordThreadId,
				messageId: message.messageId,
			});
			return;
		}
		const active = this.#activeTurn();
		if (active) {
			await this.#steerActiveTurn(active, message, content);
			return;
		}
		const item: DiscordBridgeQueueItem = {
			id: `${message.messageId}-${Date.now()}`,
			status: "pending",
			discordMessageId: message.messageId,
			discordThreadId: message.channelId,
			codexThreadId: this.session.codexThreadId,
			authorId: message.author.id,
			authorName: message.author.name,
			content,
			createdAt: message.createdAt,
			receivedAt: this.#context.now().toISOString(),
			attempts: 0,
		};
		state.queue.push(item);
		this.#debug("queue.enqueued", {
			queueId: item.id,
			discordThreadId: item.discordThreadId,
			codexThreadId: item.codexThreadId,
			messageId: item.discordMessageId,
			contentLength: content.length,
			sessionQueueLength: this.#sessionQueueItems().length,
		});
		await this.#context.persist();
		await this.#updateStatusMessage();
		await this.#processQueue();
	}

	async #steerActiveTurn(
		active: DiscordBridgeActiveTurn,
		message: DiscordMessageInbound,
		content: string,
	): Promise<void> {
		this.#debug("turn.steer.request", {
			activeQueueId: active.queueItemId,
			origin: active.origin,
			turnId: active.turnId,
			messageId: message.messageId,
			contentLength: content.length,
		});
		await this.#context.client.steerTurn({
			threadId: active.codexThreadId,
			expectedTurnId: active.turnId,
			input: [
				{
					type: "text",
					text: this.#formatPrompt({
						id: `${message.messageId}-steer`,
						status: "pending",
						discordMessageId: message.messageId,
						discordThreadId: message.channelId,
						codexThreadId: this.session.codexThreadId,
						authorId: message.author.id,
						authorName: message.author.name,
						content,
						createdAt: message.createdAt,
						receivedAt: this.#context.now().toISOString(),
						attempts: 0,
					}),
					text_elements: [],
				},
			],
			responsesapiClientMetadata: null,
		});
		addProcessedMessageId(this.#state(), message.messageId);
		await this.#context.persist();
		this.#debug("turn.steer.accepted", {
			activeQueueId: active.queueItemId,
			origin: active.origin,
			turnId: active.turnId,
			messageId: message.messageId,
		});
		await this.#updateStatusMessage();
	}

	async #reconcilePersistedProcessing(): Promise<void> {
		const processingItems = this.#sessionQueueItems().filter(
			(item) => item.status === "processing",
		);
		if (processingItems.length === 0) {
			return;
		}
		this.#debug("runner.reconcile.start", {
			discordThreadId: this.session.discordThreadId,
			codexThreadId: this.session.codexThreadId,
			processing: processingItems.length,
		});
		for (const item of processingItems) {
			if (!item.turnId) {
				item.status = "pending";
				item.lastError = "Recovered processing item without a turn id";
				item.nextAttemptAt = undefined;
				this.#debug("runner.reconcile.resetMissingTurn", {
					queueId: item.id,
				});
				continue;
			}
			const turn = await this.#readTurn(item.turnId);
			if (!turn) {
				item.status = "pending";
				item.turnId = undefined;
				item.lastError = "Recovered processing item whose turn was not found";
				item.nextAttemptAt = new Date(
					this.#context.now().getTime() + activeTurnRetryMs,
				).toISOString();
				this.#debug("runner.reconcile.resetMissingRemoteTurn", {
					queueId: item.id,
				});
				this.#scheduleRetry(item.id, activeTurnRetryMs);
				continue;
			}
			if (turn.status === "completed") {
				await this.#completeTurn(this.session.codexThreadId, item.turnId, turn);
				continue;
			}
			if (turn.status === "failed" || turn.status === "interrupted") {
				await this.#completeFailedTurn(item, turn.status);
				continue;
			}
			this.#finalAssistantText.set(turnKey(item.codexThreadId, item.turnId), "");
			const active = this.#upsertActiveTurn({
				turnId: item.turnId,
				origin: "discord",
				queueItemId: item.id,
				startedAt: turnStartedAt(turn),
				discordThreadId: item.discordThreadId,
			});
			await this.#startTypingHeartbeat(active);
			this.#scheduleActiveTurnReconcile(active);
			await this.#updateStatusMessage();
		}
		await this.#context.persist();
	}

	async #reconcilePersistedActiveTurns(): Promise<void> {
		const activeTurns = [...this.#sessionActiveTurns()];
		if (activeTurns.length === 0) {
			return;
		}
		this.#debug("runner.reconcileActive.start", {
			activeTurns: activeTurns.length,
		});
		for (const active of activeTurns) {
			const turn = await this.#readTurn(active.turnId);
			if (!turn) {
				this.#removeActiveTurn(active.turnId);
				this.#debug("runner.reconcileActive.removedMissingTurn", {
					turnId: active.turnId,
					origin: active.origin,
				});
				continue;
			}
			if (turn.status === "completed") {
				await this.#completeTurn(active.codexThreadId, active.turnId, turn);
				continue;
			}
			if (turn.status === "failed" || turn.status === "interrupted") {
				await this.#completeFailedTurn(active, turn.status);
				continue;
			}
			this.#finalAssistantText.set(turnKey(active.codexThreadId, active.turnId), "");
			await this.#startTypingHeartbeat(active);
			this.#scheduleActiveTurnReconcile(active);
			await this.#updateStatusMessage();
		}
		await this.#context.persist();
	}

	async #processQueue(): Promise<void> {
		const active = this.#activeTurn();
		if (active) {
			this.#debug("queue.process.activeTurn", {
				queueId: active.queueItemId,
				origin: active.origin,
				turnId: active.turnId,
				pending: this.#sessionQueueItems().filter((item) => item.status === "pending").length,
			});
			return;
		}
		for (const item of this.#sessionQueueItems()) {
			if (item.status !== "pending") {
				continue;
			}
			const delayMs = retryDelayMs(item, this.#context.now());
			if (delayMs > 0) {
				this.#scheduleRetry(item.id, delayMs);
				this.#debug("queue.item.delayed", {
					queueId: item.id,
					delayMs,
					attempts: item.attempts,
				});
				continue;
			}
			await this.#startTurn(item);
			return;
		}
	}

	async #startTurn(item: DiscordBridgeQueueItem): Promise<void> {
		try {
			this.#debug("turn.start.request", {
				queueId: item.id,
				codexThreadId: item.codexThreadId,
				discordThreadId: item.discordThreadId,
				inputLength: item.content.length,
				cwd: this.#cwd(),
				model: this.#context.config.model,
				summary: this.#context.config.summary,
				progressMode: this.#progressMode(),
			});
			const started = await this.#context.client.startTurn({
				threadId: item.codexThreadId,
				input: [
					{
						type: "text",
						text: this.#formatPrompt(item),
						text_elements: [],
					},
				],
				cwd: this.#cwd() ?? null,
				model: this.#context.config.model ?? null,
				serviceTier: this.#context.config.serviceTier ?? null,
				effort: this.#context.config.effort ?? null,
				summary: this.#context.config.summary ?? null,
				approvalPolicy: this.#context.config.approvalPolicy ?? null,
				permissions: this.#context.config.permissions ?? null,
				outputSchema: null,
			});
			item.status = "processing";
			item.turnId = started.turn.id;
			item.lastError = undefined;
			item.nextAttemptAt = undefined;
			this.#clearRuntimeState();
			this.#finalAssistantText.set(turnKey(item.codexThreadId, started.turn.id), "");
			const active = this.#upsertActiveTurn({
				turnId: started.turn.id,
				origin: "discord",
				queueItemId: item.id,
				startedAt: turnStartedAt(started.turn),
				discordThreadId: item.discordThreadId,
			});
			await this.#startTypingHeartbeat(active);
			this.#scheduleActiveTurnReconcile(active);
			await this.#context.persist();
			await this.#updateStatusMessage();
			this.#debug("turn.start.accepted", {
				queueId: item.id,
				codexThreadId: item.codexThreadId,
				turnId: started.turn.id,
			});
		} catch (error) {
			const message = errorMessage(error);
			if (message.includes("already has an active turn")) {
				item.lastError = message;
				item.nextAttemptAt = new Date(
					this.#context.now().getTime() + activeTurnRetryMs,
				).toISOString();
				await this.#context.persist();
				await this.#updateStatusMessage();
				this.#debug("turn.start.activeTurn", {
					queueId: item.id,
					codexThreadId: item.codexThreadId,
					nextAttemptAt: item.nextAttemptAt,
					error: message,
				});
				this.#scheduleRetry(item.id, activeTurnRetryMs);
				return;
			}
			item.attempts += 1;
			item.lastError = message;
			if (item.attempts >= maxAttempts) {
				item.status = "failed";
				item.nextAttemptAt = undefined;
				await this.#deliverError(item, message);
				await this.#context.persist();
				await this.#updateStatusMessage();
				this.#debug("turn.start.failed.permanent", {
					queueId: item.id,
					attempts: item.attempts,
					error: message,
				});
				return;
			}
			item.nextAttemptAt = new Date(
				this.#context.now().getTime() + backoffMs(item.attempts),
			).toISOString();
			await this.#context.persist();
			await this.#updateStatusMessage();
			this.#debug("turn.start.failed.retry", {
				queueId: item.id,
				attempts: item.attempts,
				nextAttemptAt: item.nextAttemptAt,
				error: message,
			});
			this.#scheduleRetry(item.id, retryDelayMs(item, this.#context.now()));
		}
	}

	async #handleNotification(message: JsonRpcNotification): Promise<void> {
		const params = record(message.params);
		const threadId = stringValue(params.threadId);
		if (threadId !== this.session.codexThreadId) {
			this.#debug("notification.ignored.runnerMismatch", {
				method: message.method,
				threadId,
				codexThreadId: this.session.codexThreadId,
			});
			return;
		}
		if (message.method === "thread/goal/updated") {
			this.#goal = runtimeGoal(record(params.goal));
			await this.#updateStatusMessage();
			return;
		}
		if (message.method === "thread/goal/cleared") {
			this.#goal = undefined;
			await this.#updateStatusMessage();
			return;
		}
		const turnId =
			stringValue(params.turnId) ??
			stringValue(record(params.turn).id);
		if (!turnId) {
			this.#debug("notification.ignored.runnerMismatch", {
				method: message.method,
				threadId,
				turnId,
				codexThreadId: this.session.codexThreadId,
			});
			return;
		}
		this.#debug("notification.received", {
			method: message.method,
			threadId,
			turnId,
			itemId: stringValue(params.itemId),
			summaryIndex: numberValue(params.summaryIndex),
			deltaLength: stringValue(params.delta)?.length,
			hasTurnPayload: Boolean(params.turn),
		});
		if (this.#hasDelivery(turnId, "final") && !this.#processingItemForTurn(turnId)) {
			await this.#ignoreDeliveredTurnNotification(message.method, threadId, turnId);
			return;
		}
		if (
			message.method !== "turn/started" &&
			message.method !== "turn/completed" &&
			!this.#activeTurnForTurn(turnId) &&
			!this.#hasDelivery(turnId, "final")
		) {
			await this.#adoptStartedTurn(turnId, record(params.turn));
		}
		if (message.method === "turn/started") {
			await this.#adoptStartedTurn(turnId, record(params.turn));
			await this.#updateStatusMessage();
			return;
		}
		if (message.method === "turn/plan/updated") {
			this.#planExplanation = stringValue(params.explanation);
			this.#planSteps = Array.isArray(params.plan)
				? params.plan.filter(isRecord).map((step) => ({
						step: stringValue(step.step) ?? "",
						status: planStepStatus(step.status),
					})).filter((step) => step.step)
				: [];
			await this.#updateStatusMessage();
			return;
		}
		if (message.method === "item/plan/delta") {
			const itemId = stringValue(params.itemId) ?? "plan";
			const delta = stringValue(params.delta);
			if (delta) {
				this.#planTextBuffers.set(
					itemId,
					`${this.#planTextBuffers.get(itemId) ?? ""}${delta}`,
				);
				await this.#updateStatusMessage();
			}
			return;
		}
		if (message.method === "item/started") {
			await this.#handleItemStarted(turnId, record(params.item));
			return;
		}
		if (message.method === "item/commandExecution/outputDelta") {
			const itemId = stringValue(params.itemId) ?? "command";
			this.#upsertRunningCommand(itemId, undefined);
			await this.#updateStatusMessage();
			return;
		}
		if (message.method === "item/reasoning/summaryPartAdded") {
			if (this.#progressMode() !== "summary") {
				return;
			}
			const summaryKey = summaryNotificationKey(threadId, turnId, params);
			await this.#finalizeEarlierSummaries(summaryKey);
			if (this.#summaryBuffers.get(summaryKeyString(summaryKey))?.trim()) {
				await this.#finalizeSummary(summaryKey);
			} else {
				this.#ensureSummary(summaryKey);
			}
			return;
		}
		if (message.method === "item/reasoning/summaryTextDelta") {
			if (this.#progressMode() !== "summary") {
				return;
			}
			const delta = stringValue(params.delta);
			if (delta) {
				await this.#appendSummary(summaryNotificationKey(threadId, turnId, params), delta);
			}
			return;
		}
		if (message.method === "item/completed") {
			await this.#handleItemCompleted(threadId, turnId, record(params.item));
			return;
		}
		if (message.method === "item/agentMessage/delta") {
			const delta = stringValue(params.delta);
			if (delta) {
				this.#appendAgentMessageDelta(
					threadId,
					turnId,
					stringValue(params.itemId) ?? "agent-message",
					delta,
				);
			}
			return;
		}
		if (message.method === "turn/completed") {
			await this.#completeTurn(threadId, turnId, record(params.turn));
		}
	}

	async #adoptStartedTurn(
		turnId: string,
		turn: Record<string, unknown>,
	): Promise<void> {
		const existing = this.#activeTurnForTurn(turnId);
		const previous = this.#activeTurn();
		const item = this.#processingItemForTurn(turnId);
		if (!existing && previous?.turnId !== turnId) {
			this.#clearRuntimeState();
		}
		const active = this.#upsertActiveTurn({
			turnId,
			origin: item ? "discord" : "external",
			queueItemId: item?.id,
			startedAt: turnStartedAt(turn),
			discordThreadId: item?.discordThreadId,
		});
		if (!this.#finalAssistantText.has(turnKey(active.codexThreadId, active.turnId))) {
			this.#finalAssistantText.set(turnKey(active.codexThreadId, active.turnId), "");
		}
		await this.#startTypingHeartbeat(active);
		this.#scheduleActiveTurnReconcile(active);
		await this.#context.persist();
		this.#debug("turn.adopted", {
			turnId,
			origin: active.origin,
			queueId: active.queueItemId,
		});
	}

	async #handleItemCompleted(
		threadId: string,
		turnId: string,
		item: Record<string, unknown>,
	): Promise<void> {
		const trackedActivity = this.#handleActivityItem(turnId, item, "completed");
		if (item.type === "commandExecution") {
			await this.#handleCommandExecutionItem(item);
			return;
		}
		if (item.type === "plan") {
			const itemId = stringValue(item.id) ?? "plan";
			const text = stringValue(item.text);
			if (text) {
				this.#planTextBuffers.set(itemId, text);
				await this.#updateStatusMessage();
			}
			return;
		}
		if (item.type === "agentMessage") {
			await this.#handleAgentMessageCompleted(threadId, turnId, item);
			return;
		}
		if (trackedActivity) {
			await this.#updateStatusMessage();
			return;
		}
		if (this.#progressMode() !== "summary") {
			return;
		}
		if (item.type !== "reasoning" || !Array.isArray(item.summary)) {
			return;
		}
		for (let index = 0; index < item.summary.length; index += 1) {
			const text = stringValue(item.summary[index]);
			if (!text) {
				continue;
			}
			const summaryParts = {
				threadId,
				turnId,
				itemId: stringValue(item.id) ?? "reasoning",
				summaryIndex: index,
			};
			const encodedKey = summaryKeyString(summaryParts);
			if (!this.#summaryMessages.has(encodedKey)) {
				this.#summaryBuffers.set(encodedKey, text);
				await this.#finalizeSummary(summaryParts);
			}
		}
	}

	async #handleItemStarted(
		turnId: string,
		item: Record<string, unknown>,
	): Promise<void> {
		const trackedActivity = this.#handleActivityItem(turnId, item, "inProgress");
		if (item.type === "commandExecution") {
			await this.#handleCommandExecutionItem(item);
			return;
		}
		if (item.type === "plan") {
			const itemId = stringValue(item.id) ?? `plan-${turnId}`;
			this.#planTextBuffers.set(itemId, stringValue(item.text) ?? "");
			await this.#updateStatusMessage();
		}
		if (trackedActivity) {
			await this.#updateStatusMessage();
		}
	}

	async #handleCommandExecutionItem(
		item: Record<string, unknown>,
	): Promise<void> {
		const itemId = stringValue(item.id) ?? "command";
		const status = commandStatus(item.status);
		if (status === "inProgress") {
			this.#upsertRunningCommand(itemId, stringValue(item.command));
		} else {
			this.#deleteRunningCommand(itemId);
		}
		await this.#updateStatusMessage();
	}

	#handleActivityItem(
		turnId: string,
		item: Record<string, unknown>,
		fallbackStatus: RuntimeActivity["status"],
	): boolean {
		const activity = activityFromItem(
			item,
			turnId,
			fallbackStatus,
			this.#context.now(),
		);
		if (!activity) {
			return false;
		}
		this.#activities.set(activity.itemId, activity);
		this.#trimActivities();
		return true;
	}

	#trimActivities(): void {
		const activities = [...this.#activities.values()]
			.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
		const completed = activities.filter((activity) =>
			activity.status !== "inProgress"
		);
		while (this.#activities.size > 8 && completed.length > 0) {
			const oldest = completed.shift();
			if (!oldest) {
				break;
			}
			this.#activities.delete(oldest.itemId);
		}
		while (this.#activities.size > 12) {
			const oldest = [...this.#activities.values()]
				.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0];
			if (!oldest) {
				break;
			}
			this.#activities.delete(oldest.itemId);
		}
	}

	#upsertRunningCommand(itemId: string, command: string | undefined): void {
		const existing = this.#runningCommands.get(itemId);
		const running: RunningCommand = {
			itemId,
			command: command ?? existing?.command ?? `command ${compactId(itemId)}`,
			status: "inProgress",
			startedAt: existing?.startedAt ?? this.#context.now().toISOString(),
			lastOutputAt: this.#context.now().toISOString(),
		};
		this.#runningCommands.set(itemId, running);
		this.#scheduleRunningCommandStatusRefresh(running);
	}

	#deleteRunningCommand(itemId: string): void {
		this.#runningCommands.delete(itemId);
		this.#clearRunningCommandStatusTimer(itemId);
	}

	#scheduleRunningCommandStatusRefresh(command: RunningCommand): void {
		if (this.#visibleRunningCommand(command)) {
			this.#clearRunningCommandStatusTimer(command.itemId);
			return;
		}
		if (this.#runningCommandStatusTimers.has(command.itemId)) {
			return;
		}
		const startedAtMs = Date.parse(command.startedAt);
		const elapsedMs = Number.isFinite(startedAtMs)
			? this.#context.now().getTime() - startedAtMs
			: 0;
		const delayMs = Math.max(0, runningCommandStatusDelayMs - elapsedMs);
		const timer = setTimeout(() => {
			this.#runningCommandStatusTimers.delete(command.itemId);
			void this.#enqueue("command.status.visible", async () => {
				const current = this.#runningCommands.get(command.itemId);
				if (current && this.#visibleRunningCommand(current)) {
					await this.#updateStatusMessage();
				}
			});
		}, delayMs);
		timer.unref?.();
		this.#runningCommandStatusTimers.set(command.itemId, timer);
	}

	#clearRunningCommandStatusTimer(itemId: string): void {
		const timer = this.#runningCommandStatusTimers.get(itemId);
		if (!timer) {
			return;
		}
		clearTimeout(timer);
		this.#runningCommandStatusTimers.delete(itemId);
	}

	#clearRunningCommandStatusTimers(): void {
		for (const timer of this.#runningCommandStatusTimers.values()) {
			clearTimeout(timer);
		}
		this.#runningCommandStatusTimers.clear();
	}

	#appendAgentMessageDelta(
		threadId: string,
		turnId: string,
		itemId: string,
		delta: string,
	): void {
		const encodedKey = agentMessageKey({ threadId, turnId, itemId });
		this.#agentMessageBuffers.set(
			encodedKey,
			`${this.#agentMessageBuffers.get(encodedKey) ?? ""}${delta}`,
		);
		this.#debug("agentMessage.delta.buffered", {
			itemId,
			turnId,
			deltaLength: delta.length,
			bufferLength: this.#agentMessageBuffers.get(encodedKey)?.length,
		});
	}

	async #handleAgentMessageCompleted(
		threadId: string,
		turnId: string,
		item: Record<string, unknown>,
	): Promise<void> {
		const itemId = stringValue(item.id) ?? "agent-message";
		const encodedKey = agentMessageKey({ threadId, turnId, itemId });
		if (this.#completedAgentMessages.has(encodedKey)) {
			return;
		}
		const text =
			stringValue(item.text)?.trim() ??
			this.#agentMessageBuffers.get(encodedKey)?.trim() ??
			"";
		const phase = messagePhase(item.phase);
		this.#completedAgentMessages.add(encodedKey);
		this.#agentMessageBuffers.delete(encodedKey);
		if (!text) {
			return;
		}
		if (phase === "commentary") {
			if (this.#progressMode() === "commentary") {
				await this.#sendCommentaryMessage(turnId, itemId, text);
			}
			return;
		}
		if (phase === "final_answer" || !phase) {
			const key = turnKey(threadId, turnId);
			const existing = this.#finalAssistantText.get(key)?.trim();
			this.#finalAssistantText.set(
				key,
				existing ? `${existing}\n\n${text}` : text,
			);
		}
	}

	async #sendCommentaryMessage(
		turnId: string,
		itemId: string,
		text: string,
	): Promise<void> {
		const active = this.#activeTurnForTurn(turnId) ??
			this.#upsertActiveTurn({ turnId, origin: "external" });
		const outboundMessageIds = await this.#context.presenter.sendMessage(
			active.discordThreadId,
			text,
		);
		this.#recordDeliveryForTurn(active, "commentary", outboundMessageIds);
		this.#emitConsoleMessage("commentary", turnId, text);
		await this.#context.persist();
		this.#debug("commentary.message.sent", {
			turnId,
			itemId,
			outboundMessageIds,
			textLength: text.length,
		});
	}

	#ensureSummary(key: SummaryKeyParts): void {
		const encodedKey = summaryKeyString(key);
		if (!this.#summaryBuffers.has(encodedKey)) {
			this.#summaryBuffers.set(encodedKey, "");
			this.#debug("summary.ensure", {
				itemId: key.itemId,
				summaryIndex: key.summaryIndex,
				turnId: key.turnId,
			});
		}
	}

	async #appendSummary(key: SummaryKeyParts, delta: string): Promise<void> {
		const encodedKey = summaryKeyString(key);
		this.#summaryBuffers.set(
			encodedKey,
			`${this.#summaryBuffers.get(encodedKey) ?? ""}${delta}`,
		);
		this.#debug("summary.delta.buffered", {
			itemId: key.itemId,
			summaryIndex: key.summaryIndex,
			turnId: key.turnId,
			deltaLength: delta.length,
			bufferLength: this.#summaryBuffers.get(encodedKey)?.length,
		});
	}

	async #sendSummaryMessage(key: SummaryKeyParts): Promise<void> {
		const encodedKey = summaryKeyString(key);
		const text = this.#summaryBuffers.get(encodedKey)?.trim();
		if (!text) {
			return;
		}
		const active = this.#activeTurnForTurn(key.turnId) ??
			this.#upsertActiveTurn({ turnId: key.turnId, origin: "external" });
		if (this.#summaryMessages.has(encodedKey)) {
			this.#debug("summary.send.skipped.alreadySent", {
				turnId: key.turnId,
				itemId: key.itemId,
				summaryIndex: key.summaryIndex,
				textLength: text.length,
			});
			return;
		}
		const outboundMessageIds = await this.#context.presenter.sendMessage(
			active.discordThreadId,
			text,
		);
		this.#summaryMessages.set(encodedKey, outboundMessageIds);
		this.#recordDeliveryForTurn(active, "summary", outboundMessageIds);
		this.#emitConsoleMessage("summary", key.turnId, text);
		await this.#context.persist();
		this.#debug("summary.message.sent", {
			turnId: key.turnId,
			itemId: key.itemId,
			summaryIndex: key.summaryIndex,
			outboundMessageIds,
			textLength: text.length,
		});
	}

	async #finalizeSummary(key: SummaryKeyParts): Promise<void> {
		const encodedKey = summaryKeyString(key);
		this.#debug("summary.finalize", {
			turnId: key.turnId,
			itemId: key.itemId,
			summaryIndex: key.summaryIndex,
			bufferLength: this.#summaryBuffers.get(encodedKey)?.length,
		});
		await this.#sendSummaryMessage(key);
		this.#summaryBuffers.delete(encodedKey);
	}

	async #finalizeEarlierSummaries(key: SummaryKeyParts): Promise<void> {
		for (const encodedKey of [...this.#summaryBuffers.keys()]) {
			const parts = summaryKeyParts(encodedKey);
			if (
				parts.threadId === key.threadId &&
				parts.turnId === key.turnId &&
				parts.itemId === key.itemId &&
				parts.summaryIndex < key.summaryIndex
			) {
				await this.#finalizeSummary(parts);
			}
		}
	}

	async #ignoreDeliveredTurnNotification(
		method: string,
		threadId: string,
		turnId: string,
	): Promise<void> {
		const active = this.#activeTurnForTurn(turnId);
		const cleaned = await this.#deleteProgressMessagesForTurn(
			active ?? this.#progressCleanupTarget(turnId),
			turnId,
		);
		if (active) {
			this.#removeActiveTurn(turnId);
			this.#clearAgentMessagesForTurn(turnId);
			this.#clearSummariesForTurn(turnId);
			this.#clearRuntimeState();
			this.#stopTypingHeartbeat();
			this.#clearReconcileTimer();
		}
		if (active || cleaned) {
			await this.#context.persist();
			await this.#updateStatusMessage();
		}
		this.#debug("notification.ignored.deliveredTurn", {
			method,
			threadId,
			turnId,
			hadActiveTurn: Boolean(active),
			cleanedProgress: cleaned,
		});
	}

	async #cleanupDeliveredTurnProgress(): Promise<void> {
		const deliveredTurnIds = [
			...new Set(
				this.#state().deliveries
					.filter(
						(delivery) =>
							(this.session.mode === "operator" ||
								delivery.discordThreadId === this.session.discordThreadId) &&
							delivery.codexThreadId === this.session.codexThreadId &&
							delivery.kind === "final" &&
							Boolean(delivery.turnId),
					)
					.map((delivery) => delivery.turnId as string),
			),
		];
		let changed = false;
		for (const turnId of deliveredTurnIds) {
			if (this.#processingItemForTurn(turnId)) {
				continue;
			}
			const active = this.#activeTurnForTurn(turnId);
			const cleaned = await this.#deleteProgressMessagesForTurn(
				active ?? this.#progressCleanupTarget(turnId),
				turnId,
			);
			if (active) {
				this.#removeActiveTurn(turnId);
				changed = true;
			}
			changed = cleaned || changed;
		}
		if (changed) {
			this.#clearRuntimeState();
			this.#stopTypingHeartbeat();
			this.#clearReconcileTimer();
			await this.#context.persist();
			await this.#updateStatusMessage();
		}
	}

	async #completeTurn(
		threadId: string,
		turnId: string,
		completedTurn: Record<string, unknown>,
	): Promise<void> {
		const key = turnKey(threadId, turnId);
		const item = this.#processingItemForTurn(turnId);
		const active = this.#activeTurnForTurn(turnId) ??
			(item
				? this.#upsertActiveTurn({
						turnId,
						origin: "discord",
						queueItemId: item.id,
						startedAt: turnStartedAt(completedTurn),
						discordThreadId: item.discordThreadId,
					})
				: this.#upsertActiveTurn({
						turnId,
						origin: "external",
						startedAt: turnStartedAt(completedTurn),
					}));
		try {
			this.#debug("turn.complete.start", {
				queueId: item?.id,
				origin: active.origin,
				threadId,
				turnId,
				finalTextLength: this.#finalAssistantText.get(key)?.length ?? 0,
				summaryBuffers: this.#summaryBuffers.size,
			});
			await this.#handleCompletedTurnItems(threadId, turnId, completedTurn);
			await this.#flushSummariesForTurn(turnId);
			const finalText =
				(this.#finalAssistantText.get(key) ?? "").trim() ||
				finalTextFromTurn(completedTurn).trim() ||
				(await this.#readFinalTurnText(turnId)).trim();
			if (finalText && !this.#hasDelivery(turnId, "final")) {
				const outboundMessageIds = await this.#context.presenter.sendMessage(
					active.discordThreadId,
					finalText,
				);
				this.#recordDeliveryForTurn(active, "final", outboundMessageIds);
				this.#emitConsoleMessage("final", turnId, finalText);
				this.#debug("turn.final.sent", {
					queueId: item?.id,
					origin: active.origin,
					turnId,
					outboundMessageIds,
					textLength: finalText.length,
				});
				await this.#deleteProgressMessagesForTurn(active, turnId);
			} else {
				this.#debug("turn.final.empty", {
					queueId: item?.id,
					origin: active.origin,
					turnId,
					alreadyDelivered: this.#hasDelivery(turnId, "final"),
				});
			}
			if (item) {
				this.#removeQueueItem(item);
				addProcessedMessageId(this.#state(), item.discordMessageId);
			}
			this.#removeActiveTurn(turnId);
			await this.#context.persist();
		} catch (error) {
			if (item) {
				item.status = "failed";
				item.lastError = errorMessage(error);
				item.nextAttemptAt = undefined;
			}
			this.#removeActiveTurn(turnId);
			await this.#context.persist();
			this.#debug("turn.complete.failedDelivery", {
				queueId: item?.id,
				origin: active.origin,
				turnId,
				error: errorMessage(error),
			});
		} finally {
			this.#finalAssistantText.delete(key);
			this.#clearAgentMessagesForTurn(turnId);
			this.#clearSummariesForTurn(turnId);
			this.#clearRuntimeState();
			this.#stopTypingHeartbeat();
			this.#clearReconcileTimer();
			await this.#updateStatusMessage();
		}
		await this.#processQueue();
	}

	async #completeFailedTurn(
		activeOrItem: DiscordBridgeActiveTurn | DiscordBridgeQueueItem,
		status: "failed" | "interrupted",
	): Promise<void> {
		const active = isActiveTurn(activeOrItem)
			? activeOrItem
			: this.#upsertActiveTurn({
					turnId: activeOrItem.turnId ?? "unknown",
					origin: "discord",
					queueItemId: activeOrItem.id,
					discordThreadId: activeOrItem.discordThreadId,
				});
		const item = this.#processingItemForTurn(active.turnId);
		await this.#deliverError(active, `Codex turn ${status}.`);
		if (item) {
			this.#removeQueueItem(item);
			addProcessedMessageId(this.#state(), item.discordMessageId);
		}
		this.#removeActiveTurn(active.turnId);
		this.#stopTypingHeartbeat();
		this.#clearReconcileTimer();
		await this.#context.persist();
		this.#clearRuntimeState();
		await this.#updateStatusMessage();
		this.#debug("turn.reconcile.completedFailed", {
			queueId: item?.id,
			origin: active.origin,
			turnId: active.turnId,
			status,
		});
	}

	async #flushSummariesForTurn(turnId: string): Promise<void> {
		for (const key of [...this.#summaryBuffers.keys()]) {
			const parts = summaryKeyParts(key);
			if (parts.turnId === turnId) {
				await this.#finalizeSummary(parts);
			}
		}
	}

	async #handleCompletedTurnItems(
		threadId: string,
		turnId: string,
		completedTurn: Record<string, unknown>,
	): Promise<void> {
		const items = Array.isArray(completedTurn.items) ? completedTurn.items : [];
		for (const item of items.filter(isRecord)) {
			await this.#handleItemCompleted(threadId, turnId, item);
		}
	}

	#clearAgentMessagesForTurn(turnId: string): void {
		for (const key of [...this.#agentMessageBuffers.keys()]) {
			if (agentMessageKeyParts(key).turnId === turnId) {
				this.#agentMessageBuffers.delete(key);
			}
		}
		for (const key of [...this.#completedAgentMessages]) {
			if (agentMessageKeyParts(key).turnId === turnId) {
				this.#completedAgentMessages.delete(key);
			}
		}
	}

	#clearSummariesForTurn(turnId: string): void {
		for (const key of [...this.#summaryBuffers.keys()]) {
			if (summaryKeyParts(key).turnId === turnId) {
				this.#summaryBuffers.delete(key);
			}
		}
		for (const key of [...this.#summaryMessages.keys()]) {
			if (summaryKeyParts(key).turnId === turnId) {
				this.#summaryMessages.delete(key);
			}
		}
	}

	async #readTurn(turnId: string): Promise<v2.Turn | undefined> {
		try {
			const response = await this.#context.client.readThread({
				threadId: this.session.codexThreadId,
				includeTurns: true,
			});
			return response.thread.turns.find((candidate) => candidate.id === turnId);
		} catch (error) {
			this.#debug("turn.read.error", {
				turnId,
				error: errorMessage(error),
			});
			return undefined;
		}
	}

	async #readFinalTurnText(turnId: string): Promise<string> {
		const turn = await this.#readTurn(turnId);
		if (!turn) {
			return "";
		}
		return finalTextFromTurn(turn);
	}

	async #deliverError(
		target: DiscordBridgeActiveTurn | DiscordBridgeQueueItem,
		message: string,
	): Promise<void> {
		const active = isActiveTurn(target) ? target : undefined;
		const item = active ? undefined : target as DiscordBridgeQueueItem;
		const outboundMessageIds = await this.#context.presenter.sendMessage(
			target.discordThreadId,
			`Codex turn failed: ${message}`,
		);
		this.#emitConsoleMessage("error", target.turnId, `Codex turn failed: ${message}`);
		if (active) {
			this.#recordDeliveryForTurn(active, "error", outboundMessageIds);
		} else if (item) {
			this.#state().deliveries.push({
				discordMessageId: item.discordMessageId,
				discordThreadId: item.discordThreadId,
				codexThreadId: item.codexThreadId,
				turnId: item.turnId,
				kind: "error",
				outboundMessageIds,
				deliveredAt: this.#context.now().toISOString(),
			});
		}
		this.#debug("error.delivered", {
			queueId: active ? active.queueItemId : item?.id,
			origin: active?.origin ?? "discord",
			turnId: target.turnId,
			outboundMessageIds,
			errorLength: message.length,
		});
	}

	async #deleteProgressMessagesForTurn(
		active: DiscordBridgeActiveTurn,
		turnId: string,
	): Promise<boolean> {
		const progressDeliveries = this.#state().deliveries.filter(
			(delivery) =>
				(delivery.kind === "summary" ||
					delivery.kind === "commentary") &&
				delivery.turnId === turnId &&
				delivery.discordThreadId === active.discordThreadId &&
				delivery.codexThreadId === active.codexThreadId,
		);
		const messageIds = [
			...new Set(
				progressDeliveries.flatMap((delivery) => delivery.outboundMessageIds),
			),
		];
		if (messageIds.length === 0) {
			this.#debug("progress.cleanup.skipped.empty", {
				queueId: active.queueItemId,
				origin: active.origin,
				turnId,
			});
			return false;
		}
		this.#debug("progress.cleanup.start", {
			queueId: active.queueItemId,
			origin: active.origin,
			turnId,
			messageIds,
		});
		const deletedMessageIds = new Set<string>();
		for (const messageId of messageIds) {
			try {
				await this.#context.presenter.deleteMessage(
					active.discordThreadId,
					messageId,
				);
				deletedMessageIds.add(messageId);
				this.#debug("progress.cleanup.deleted", {
					queueId: active.queueItemId,
					origin: active.origin,
					turnId,
					messageId,
				});
			} catch (error) {
				this.#debug("progress.cleanup.deleteFailed", {
					queueId: active.queueItemId,
					origin: active.origin,
					turnId,
					messageId,
					error: errorMessage(error),
				});
			}
		}
		if (deletedMessageIds.size > 0) {
			for (const delivery of progressDeliveries) {
				delivery.outboundMessageIds = delivery.outboundMessageIds.filter(
					(messageId) => !deletedMessageIds.has(messageId),
				);
			}
		}
		return deletedMessageIds.size > 0;
	}

	async #startTypingHeartbeat(active: DiscordBridgeActiveTurn): Promise<void> {
		this.#stopTypingHeartbeat();
		this.#typingTurnKey = turnKey(active.codexThreadId, active.turnId);
		await this.#context.presenter.sendTyping(active.discordThreadId);
		const intervalMs =
			this.#context.config.typingIntervalMs ?? defaultTypingIntervalMs;
		this.#debug("typing.start", {
			queueId: active.queueItemId,
			origin: active.origin,
			turnId: active.turnId,
			intervalMs,
		});
		const timer = setInterval(() => {
			void this.#enqueue("typing.tick", async () => {
				await this.#context.presenter.sendTyping(active.discordThreadId);
				this.#debug("typing.tick", {
					turnId: active.turnId,
				});
			}).catch((error) => {
				this.#debug("typing.error", {
					turnId: active.turnId,
					error: errorMessage(error),
				});
			});
		}, intervalMs);
		timer.unref?.();
		this.#typingTimer = timer;
	}

	#stopTypingHeartbeat(): void {
		if (!this.#typingTimer) {
			return;
		}
		clearInterval(this.#typingTimer);
		this.#typingTimer = undefined;
		this.#debug("typing.stop", {
			key: this.#typingTurnKey,
		});
		this.#typingTurnKey = undefined;
	}

	#scheduleActiveTurnReconcile(active: DiscordBridgeActiveTurn): void {
		this.#clearReconcileTimer();
		const intervalMs =
			this.#context.config.reconcileIntervalMs ?? defaultReconcileIntervalMs;
		const timer = setTimeout(() => {
			this.#reconcileTimer = undefined;
			void this.#enqueue("turn.reconcile", async () => {
				await this.#reconcileActiveTurn();
			});
		}, intervalMs);
		timer.unref?.();
		this.#reconcileTimer = timer;
		this.#debug("turn.reconcile.scheduled", {
			queueId: active.queueItemId,
			origin: active.origin,
			turnId: active.turnId,
			intervalMs,
		});
	}

	async #reconcileActiveTurn(): Promise<void> {
		const active = this.#activeTurn();
		if (!active) {
			return;
		}
		const turn = await this.#readTurn(active.turnId);
		if (!turn) {
			this.#scheduleActiveTurnReconcile(active);
			return;
		}
		if (turn.status === "completed") {
			await this.#completeTurn(active.codexThreadId, active.turnId, turn);
			return;
		}
		if (turn.status === "failed" || turn.status === "interrupted") {
			await this.#completeFailedTurn(active, turn.status);
			await this.#processQueue();
			return;
		}
		this.#scheduleActiveTurnReconcile(active);
	}

	#clearReconcileTimer(): void {
		if (!this.#reconcileTimer) {
			return;
		}
		clearTimeout(this.#reconcileTimer);
		this.#reconcileTimer = undefined;
	}

	async #ensureStatusMessage(): Promise<void> {
		const text = this.#renderStatusMessage();
		if (this.session.statusMessageId) {
			await this.#updateStatusMessage();
			await this.#pinStatusMessage(this.session.statusMessageId);
			return;
		}
		const [messageId] = await this.#context.presenter.sendMessage(
			this.session.discordThreadId,
			text,
		);
		if (!messageId) {
			return;
		}
		this.session.statusMessageId = messageId;
		await this.#pinStatusMessage(messageId);
		await this.#context.persist();
		this.#debug("status.message.created", {
			messageId,
			textLength: text.length,
		});
	}

	async #updateStatusMessage(): Promise<void> {
		const messageId = this.session.statusMessageId;
		if (!messageId) {
			await this.#ensureStatusMessage();
			return;
		}
		if (!this.#context.presenter.updateMessage) {
			return;
		}
		try {
			const text = this.#renderStatusMessage();
			await this.#context.presenter.updateMessage(
				this.session.discordThreadId,
				messageId,
				text,
			);
			this.#debug("status.message.updated", {
				messageId,
				textLength: text.length,
			});
		} catch (error) {
			this.#debug("status.message.updateFailed", {
				messageId,
				error: errorMessage(error),
			});
			this.session.statusMessageId = undefined;
			await this.#context.persist();
			await this.#ensureStatusMessage();
		}
	}

	async #pinStatusMessage(messageId: string): Promise<void> {
		if (!this.#context.presenter.pinMessage) {
			return;
		}
		if (this.#pinnedStatusMessageId === messageId) {
			return;
		}
		try {
			await this.#context.presenter.pinMessage(
				this.session.discordThreadId,
				messageId,
			);
			this.#pinnedStatusMessageId = messageId;
			this.#debug("status.message.pinned", { messageId });
		} catch (error) {
			this.#debug("status.message.pinFailed", {
				messageId,
				error: errorMessage(error),
			});
		}
	}

	async #refreshGoal(): Promise<void> {
		try {
			const response = await this.#context.client.getThreadGoal({
				threadId: this.session.codexThreadId,
			});
			this.#goal = response.goal ? runtimeGoal(response.goal) : undefined;
		} catch (error) {
			this.#debug("goal.refresh.failed", {
				error: errorMessage(error),
			});
		}
	}

	#renderStatusMessage(): string {
		return renderStatusMessage({
			session: this.session,
			config: this.#context.config,
			activeTurn: this.#activeTurn(),
			activeItem: this.#activeProcessingItem(),
			pendingCount: this.#sessionQueueItems().filter((item) => item.status === "pending").length,
			failedCount: this.#sessionQueueItems().filter((item) => item.status === "failed").length,
			goal: this.#goal,
			planExplanation: this.#planExplanation,
			planSteps: this.#planSteps,
			planText: [...this.#planTextBuffers.values()].join("\n").trim(),
			runningCommands: [...this.#runningCommands.values()].filter((command) =>
				this.#visibleRunningCommand(command)
			),
			activities: [...this.#activities.values()],
		});
	}

	#visibleRunningCommand(command: RunningCommand): boolean {
		const startedAtMs = Date.parse(command.startedAt);
		return Number.isFinite(startedAtMs) &&
			this.#context.now().getTime() - startedAtMs >= runningCommandStatusDelayMs;
	}

	#clearRuntimeState(): void {
		this.#planExplanation = undefined;
		this.#planSteps = [];
		this.#planTextBuffers.clear();
		this.#runningCommands.clear();
		this.#activities.clear();
		this.#clearRunningCommandStatusTimers();
	}

	#recordDeliveryForTurn(
		active: DiscordBridgeActiveTurn,
		kind: DiscordBridgeDelivery["kind"],
		outboundMessageIds: string[],
	): void {
		const item = this.#processingItemForTurn(active.turnId);
		this.#state().deliveries.push({
			discordMessageId: item?.discordMessageId ?? `external:${active.turnId}`,
			discordThreadId: active.discordThreadId,
			codexThreadId: active.codexThreadId,
			turnId: active.turnId,
			kind,
			outboundMessageIds,
			deliveredAt: this.#context.now().toISOString(),
		});
		this.#debug("delivery.recorded", {
			discordMessageId: item?.discordMessageId ?? `external:${active.turnId}`,
			origin: active.origin,
			kind,
			outboundMessageIds,
			turnId: active.turnId,
		});
	}

	#hasDelivery(turnId: string, kind: DiscordBridgeDelivery["kind"]): boolean {
		return this.#state().deliveries.some(
			(delivery) =>
				(this.session.mode === "operator" ||
					delivery.discordThreadId === this.session.discordThreadId) &&
				delivery.codexThreadId === this.session.codexThreadId &&
				delivery.turnId === turnId &&
				delivery.kind === kind,
		);
	}

	#scheduleRetry(itemId: string, delayMs: number): void {
		const existing = this.#retryTimers.get(itemId);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.#retryTimers.delete(itemId);
			void this.#enqueue("retry.fire", async () => {
				await this.#processQueue();
			});
		}, Math.max(0, delayMs));
		timer.unref?.();
		this.#retryTimers.set(itemId, timer);
	}

	#activeProcessingItem(): DiscordBridgeQueueItem | undefined {
		return this.#sessionQueueItems().find((item) => item.status === "processing");
	}

	#activeTurn(): DiscordBridgeActiveTurn | undefined {
		return this.#sessionActiveTurns()[0];
	}

	#activeTurnForTurn(turnId: string): DiscordBridgeActiveTurn | undefined {
		return this.#sessionActiveTurns().find((active) => active.turnId === turnId);
	}

	#sessionActiveTurns(): DiscordBridgeActiveTurn[] {
		return this.#state().activeTurns.filter(
			(active) =>
				(this.session.mode === "operator" ||
					active.discordThreadId === this.session.discordThreadId) &&
				active.codexThreadId === this.session.codexThreadId,
		);
	}

	#upsertActiveTurn(input: {
		turnId: string;
		origin: DiscordBridgeActiveTurn["origin"];
		queueItemId?: string;
		startedAt?: string;
		discordThreadId?: string;
	}): DiscordBridgeActiveTurn {
		const state = this.#state();
		const observedAt = this.#context.now().toISOString();
		state.activeTurns = state.activeTurns.filter(
			(active) =>
				(this.session.mode !== "operator" &&
					active.discordThreadId !== this.session.discordThreadId) ||
				active.codexThreadId !== this.session.codexThreadId ||
				active.turnId === input.turnId,
		);
		const existing = this.#activeTurnForTurn(input.turnId);
		if (existing) {
			existing.origin = input.origin === "discord" ? "discord" : existing.origin;
			existing.queueItemId = input.queueItemId ?? existing.queueItemId;
			existing.startedAt = input.startedAt ?? existing.startedAt;
			existing.discordThreadId = input.discordThreadId ?? existing.discordThreadId;
			existing.observedAt = observedAt;
			return existing;
		}
		const active: DiscordBridgeActiveTurn = {
			turnId: input.turnId,
			discordThreadId: input.discordThreadId ?? this.session.discordThreadId,
			codexThreadId: this.session.codexThreadId,
			origin: input.origin,
			queueItemId: input.queueItemId,
			startedAt: input.startedAt,
			observedAt,
		};
		state.activeTurns.push(active);
		return active;
	}

	#removeActiveTurn(turnId: string): void {
		const state = this.#state();
		state.activeTurns = state.activeTurns.filter(
			(active) =>
				(this.session.mode !== "operator" &&
					active.discordThreadId !== this.session.discordThreadId) ||
				active.codexThreadId !== this.session.codexThreadId ||
				active.turnId !== turnId,
		);
	}

	#progressCleanupTarget(turnId: string): DiscordBridgeActiveTurn {
		return {
			turnId,
			discordThreadId: this.session.discordThreadId,
			codexThreadId: this.session.codexThreadId,
			origin: "external",
			observedAt: this.#context.now().toISOString(),
		};
	}

	#processingItemForTurn(turnId: string): DiscordBridgeQueueItem | undefined {
		return this.#sessionQueueItems().find(
			(item) => item.status === "processing" && item.turnId === turnId,
		);
	}

	#sessionQueueItems(): DiscordBridgeQueueItem[] {
		return this.#state().queue.filter(
			(item) =>
				(this.session.mode === "operator" ||
					item.discordThreadId === this.session.discordThreadId) &&
				item.codexThreadId === this.session.codexThreadId,
		);
	}

	#removeQueueItem(item: DiscordBridgeQueueItem): void {
		const state = this.#state();
		state.queue = state.queue.filter((candidate) => candidate !== item);
	}

	#state(): DiscordBridgeState {
		return this.#context.getState();
	}

	#progressMode(): "summary" | "commentary" | "none" {
		return this.#context.config.progressMode ?? "summary";
	}

	#formatPrompt(item: DiscordBridgeQueueItem): string {
		return formatDiscordPrompt(item, this.session, this.#context.config);
	}

	#emitConsoleMessage(
		kind: DiscordConsoleMessageKind,
		turnId: string | undefined,
		text: string,
	): void {
		try {
			this.#context.consoleOutput?.message({
				kind,
				text,
				discordThreadId: this.session.discordThreadId,
				codexThreadId: this.session.codexThreadId,
				turnId,
				title: this.session.title,
				at: this.#context.now(),
			});
		} catch (error) {
			this.#debug("console.message.failed", {
				kind,
				turnId,
				error: errorMessage(error),
			});
		}
	}

	#cwd(): string | undefined {
		return this.session.cwd ?? this.#context.config.cwd;
	}

	#debug(event: string, fields: Record<string, unknown> = {}): void {
		this.#context.debug(event, {
			discordThreadId: this.session.discordThreadId,
			codexThreadId: this.session.codexThreadId,
			...fields,
		});
	}
}

export class MessageDeduplicator {
	#seen = new Map<string, number>();
	#ttlMs: number;
	#maxSize: number;
	#now: () => Date;

	constructor(options: { ttlMs?: number; maxSize?: number; now: () => Date }) {
		this.#ttlMs = options.ttlMs ?? 300_000;
		this.#maxSize = options.maxSize ?? 2_000;
		this.#now = options.now;
	}

	isDuplicate(id: string): boolean {
		if (!id) {
			return false;
		}
		const now = this.#now().getTime();
		const seenAt = this.#seen.get(id);
		if (seenAt !== undefined && now - seenAt < this.#ttlMs) {
			return true;
		}
		this.#seen.set(id, now);
		if (this.#seen.size > this.#maxSize) {
			const cutoff = now - this.#ttlMs;
			for (const [candidate, timestamp] of this.#seen) {
				if (timestamp <= cutoff) {
					this.#seen.delete(candidate);
				}
			}
			if (this.#seen.size > this.#maxSize) {
				const newest = [...this.#seen.entries()]
					.sort((left, right) => left[1] - right[1])
					.slice(-this.#maxSize);
				this.#seen = new Map(newest);
			}
		}
		return false;
	}
}

type SummaryKeyParts = {
	threadId: string;
	turnId: string;
	itemId: string;
	summaryIndex: number;
};

type AgentMessageKeyParts = {
	threadId: string;
	turnId: string;
	itemId: string;
};

type RuntimeGoal = {
	objective: string;
	status: string;
};

type RuntimePlanStep = {
	step: string;
	status: "pending" | "inProgress" | "completed";
};

type RunningCommand = {
	itemId: string;
	command: string;
	status: "inProgress";
	startedAt: string;
	lastOutputAt?: string;
};

type RuntimeActivity = {
	itemId: string;
	turnId: string;
	kind: string;
	label: string;
	status: "inProgress" | "completed" | "failed" | "declined";
	updatedAt: string;
};

type StatusRenderInput = {
	session: DiscordBridgeSession;
	config: DiscordBridgeConfig;
	activeTurn?: DiscordBridgeActiveTurn;
	activeItem?: DiscordBridgeQueueItem;
	pendingCount: number;
	failedCount: number;
	goal?: RuntimeGoal;
	planExplanation?: string;
	planSteps: RuntimePlanStep[];
	planText: string;
	runningCommands: RunningCommand[];
	activities: RuntimeActivity[];
};

function renderStatusMessage(input: StatusRenderInput): string {
	const lines = [
		"**Codex Discord Bridge**",
		`Mode: \`${input.session.mode ?? "new"}\``,
		`Codex thread: \`${input.session.codexThreadId}\``,
		`Dir: \`${input.session.cwd ?? input.config.cwd ?? "default"}\``,
		`Progress: \`${input.config.progressMode ?? "summary"}\``,
		`Model: \`${input.config.model ?? "default"}\``,
		`Permissions: ${permissionSummary(input.config)}`,
		"",
		"**Access**",
		`Owner: ${mentionUser(input.session.ownerUserId)}`,
		`Participants: ${mentionUsers(input.session.participantUserIds ?? [])}`,
		`Global admins: ${mentionUsers([...input.config.allowedUserIds])}`,
		"",
		"**Turn**",
		`Status: ${turnStatus(input.activeTurn, input.activeItem)}`,
		`Queue: ${input.pendingCount} pending, ${input.failedCount} failed`,
		`Goal: ${goalSummary(input.goal)}`,
		"",
		"**Plan**",
		...planLines(input),
		"",
		"**Running Commands**",
		...runningCommandLines(input.runningCommands),
		"",
		"**Activity**",
		...activityLines(input.activities),
	];
	const text = lines.join("\n");
	return text.length <= 1900 ? text : `${text.slice(0, 1897).trimEnd()}...`;
}

function permissionSummary(config: DiscordBridgeConfig): string {
	const parts = [
		`approval \`${config.approvalPolicy ?? "default"}\``,
		`permission profile \`${permissionProfileLabel(config.permissions)}\``,
		`sandbox \`${config.sandbox ?? "default"}\``,
	];
	return parts.join(", ");
}

function permissionProfileLabel(
	permissions: DiscordBridgeConfig["permissions"],
): string {
	if (!permissions) {
		return "default";
	}
	return permissions;
}

function turnStatus(
	active: DiscordBridgeActiveTurn | undefined,
	item: DiscordBridgeQueueItem | undefined,
): string {
	if (!active) {
		return "`idle`";
	}
	const queue = item ? `, queue \`${item.status}\`` : "";
	return `\`inProgress\`, origin \`${active.origin}\`, turn \`${compactId(active.turnId)}\`${queue}`;
}

function goalSummary(goal: RuntimeGoal | undefined): string {
	if (!goal) {
		return "none";
	}
	return `\`${goal.status}\` ${truncateOneLine(goal.objective, 160)}`;
}

function planLines(input: StatusRenderInput): string[] {
	if (input.planSteps.length > 0) {
		return input.planSteps.slice(0, 8).map((step) =>
			`- \`${step.status}\` ${truncateOneLine(step.step, 160)}`
		);
	}
	if (input.planText) {
		return input.planText.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.slice(0, 8)
			.map((line) => `- ${truncateOneLine(line, 160)}`);
	}
	if (input.planExplanation) {
		return [`- ${truncateOneLine(input.planExplanation, 160)}`];
	}
	return ["none"];
}

function runningCommandLines(commands: RunningCommand[]): string[] {
	if (commands.length === 0) {
		return ["none"];
	}
	return commands.slice(0, 8).map((command) =>
		`- \`${truncateOneLine(command.command, 140)}\``
	);
}

function activityLines(activities: RuntimeActivity[]): string[] {
	if (activities.length === 0) {
		return ["none"];
	}
	return activities
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
		.slice(0, 6)
		.map((activity) =>
			`- \`${activity.status}\` ${activity.kind}: ${truncateOneLine(activity.label, 120)}`
		);
}

function mentionUser(userId: string | undefined): string {
	return userId ? `<@${userId}>` : "unknown";
}

function mentionUsers(userIds: string[]): string {
	return userIds.length > 0
		? userIds.map((userId) => `<@${userId}>`).join(", ")
		: "none";
}

function runtimeGoal(value: Record<string, unknown>): RuntimeGoal | undefined {
	const objective = stringValue(value.objective);
	if (!objective) {
		return undefined;
	}
	return {
		objective,
		status: stringValue(value.status) ?? "active",
	};
}

function planStepStatus(value: unknown): RuntimePlanStep["status"] {
	return value === "pending" || value === "inProgress" || value === "completed"
		? value
		: "pending";
}

function commandStatus(value: unknown): "inProgress" | "completed" | "failed" | "declined" {
	return value === "inProgress" ||
		value === "completed" ||
		value === "failed" ||
		value === "declined"
		? value
		: "inProgress";
}

function activityFromItem(
	item: Record<string, unknown>,
	turnId: string,
	fallbackStatus: RuntimeActivity["status"],
	now: Date,
): RuntimeActivity | undefined {
	const itemId = stringValue(item.id);
	if (!itemId) {
		return undefined;
	}
	const status = activityStatus(item.status, fallbackStatus);
	const base = {
		itemId,
		turnId,
		status,
		updatedAt: now.toISOString(),
	};
	if (item.type === "fileChange") {
		const changes = Array.isArray(item.changes) ? item.changes.length : 0;
		return {
			...base,
			kind: "files",
			label: changes > 0 ? `${changes} file change${changes === 1 ? "" : "s"}` : "file changes",
		};
	}
	if (item.type === "mcpToolCall") {
		const server = stringValue(item.server) ?? "mcp";
		const tool = stringValue(item.tool) ?? "tool";
		return {
			...base,
			kind: "mcp",
			label: `${server}.${tool}`,
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

function activityStatus(
	value: unknown,
	fallback: RuntimeActivity["status"],
): RuntimeActivity["status"] {
	return value === "inProgress" ||
		value === "completed" ||
		value === "failed" ||
		value === "declined"
		? value
		: fallback;
}

function truncateOneLine(value: string, maxLength: number): string {
	const oneLine = value.trim().replace(/\s+/g, " ");
	if (oneLine.length <= maxLength) {
		return oneLine;
	}
	return `${oneLine.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatDiscordPrompt(
	item: DiscordBridgeQueueItem,
	session: DiscordBridgeSession,
	config: DiscordBridgeConfig,
): string {
	if (session.mode === "operator") {
		const surface = config.workspace?.surfaces?.find((candidate) =>
			candidate.homeChannelId === item.discordThreadId
		);
		return [
			"[discord-workspace]",
			"Role: You are the main Codex operator thread for a configured Discord workspace surface.",
			"Intent: Treat this as a workspace request. Answer directly when appropriate; otherwise reason about backend/runtime delegation without assuming Discord itself owns a workspace registry.",
			"Canonical memory: This main Codex thread is the operator memory. Delegated Codex threads remain canonical history for delegated work.",
			surface ? `Surface: ${surface.key}` : undefined,
			`Author: ${item.authorName} (${item.authorId})`,
			`Message: ${item.discordMessageId}`,
			`Home channel: ${item.discordThreadId}`,
			`Workspace cwd: ${session.cwd ?? "default"}`,
			"",
			item.content,
		].filter((line): line is string => line !== undefined).join("\n");
	}
	return [
		"[discord]",
		`Author: ${item.authorName} (${item.authorId})`,
		`Message: ${item.discordMessageId}`,
		`Discord thread: ${item.discordThreadId}`,
		"",
		item.content,
	].join("\n");
}

function retryDelayMs(item: DiscordBridgeQueueItem, now: Date): number {
	if (!item.nextAttemptAt) {
		return 0;
	}
	return Math.max(0, new Date(item.nextAttemptAt).getTime() - now.getTime());
}

function backoffMs(attempts: number): number {
	return Math.min(30_000, 1000 * 2 ** Math.max(0, attempts - 1));
}

function turnKey(threadId: string, turnId: string): string {
	return `${threadId}/${turnId}`;
}

function compactId(value: string): string {
	return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}

function summaryNotificationKey(
	threadId: string,
	turnId: string,
	params: Record<string, unknown>,
): SummaryKeyParts {
	return {
		threadId,
		turnId,
		itemId: stringValue(params.itemId) ?? "reasoning",
		summaryIndex: numberValue(params.summaryIndex) ?? 0,
	};
}

function summaryKeyString(parts: SummaryKeyParts): string {
	return JSON.stringify([
		parts.threadId,
		parts.turnId,
		parts.itemId,
		parts.summaryIndex,
	]);
}

function summaryKeyParts(key: string): SummaryKeyParts {
	const parsed = JSON.parse(key) as unknown;
	if (!Array.isArray(parsed)) {
		throw new Error("Invalid summary key");
	}
	return {
		threadId: String(parsed[0] ?? ""),
		turnId: String(parsed[1] ?? ""),
		itemId: String(parsed[2] ?? "reasoning"),
		summaryIndex: typeof parsed[3] === "number" ? parsed[3] : 0,
	};
}

function agentMessageKey(parts: AgentMessageKeyParts): string {
	return JSON.stringify([parts.threadId, parts.turnId, parts.itemId]);
}

function agentMessageKeyParts(key: string): AgentMessageKeyParts {
	const parsed = JSON.parse(key) as unknown;
	if (!Array.isArray(parsed)) {
		throw new Error("Invalid agent message key");
	}
	return {
		threadId: String(parsed[0] ?? ""),
		turnId: String(parsed[1] ?? ""),
		itemId: String(parsed[2] ?? "agent-message"),
	};
}

function messagePhase(value: unknown): "commentary" | "final_answer" | undefined {
	return value === "commentary" || value === "final_answer" ? value : undefined;
}

function turnStartedAt(turn: Record<string, unknown>): string | undefined {
	const startedAt = numberValue(turn.startedAt);
	return startedAt === undefined
		? undefined
		: new Date(startedAt * 1000).toISOString();
}

function isActiveTurn(
	value: DiscordBridgeActiveTurn | DiscordBridgeQueueItem,
): value is DiscordBridgeActiveTurn {
	return "origin" in value;
}

function isDuplicate(state: DiscordBridgeState, messageId: string): boolean {
	return (
		state.processedMessageIds.includes(messageId) ||
		state.queue.some((item) => item.discordMessageId === messageId) ||
		state.deliveries.some((delivery) => delivery.discordMessageId === messageId)
	);
}

function addProcessedMessageId(state: DiscordBridgeState, messageId: string): void {
	state.processedMessageIds = [
		...state.processedMessageIds.filter((candidate) => candidate !== messageId),
		messageId,
	].slice(-1000);
}

function finalTextFromTurn(turn: Record<string, unknown>): string {
	const items = Array.isArray(turn.items) ? turn.items : [];
	const agentMessages = items
		.filter(isRecord)
		.filter((item) => item.type === "agentMessage");
	const finalMessages = agentMessages.filter(
		(item) => item.phase === "final_answer",
	);
	const selected = finalMessages.length > 0 ? finalMessages : agentMessages;
	return selected
		.map((item) => stringValue(item.text) ?? "")
		.filter(Boolean)
		.join("\n\n");
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
