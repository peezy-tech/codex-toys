import type { JsonRpcNotification } from "@peezy.tech/codex-flows/rpc";
import {
	CodexWorkspaceBackendClient,
	type WorkspaceBackendEvent,
} from "@peezy.tech/codex-flows/workspace-backend";
import {
	draftFromNotification,
	draftFromWorkspaceEvent,
	type AnnouncementDraft,
	type AnnouncementPolicy,
} from "./announcements.ts";
import {
	fallbackAnnouncerDecision,
	type TurnAnnouncer,
} from "./announcer.ts";
import { HookSpoolObserver } from "./hook-spool.ts";
import { SpeechQueue } from "./speech-queue.ts";
import { errorMessage } from "./text.ts";
import type { Logger, Speaker, VoiceAnnouncement } from "./types.ts";

export type WorkspaceVoiceGatewayOptions = {
	workspaceBackendUrl: string;
	workspaceClient?: CodexWorkspaceBackendClient;
	speaker: Speaker;
	logger: Logger;
	maxQueuedAnnouncements: number;
	announceBackendConnected: boolean;
	announceTurnStarted: boolean;
	hookSpool?: {
		enabled: boolean;
		dir: string;
	};
	announcer?: TurnAnnouncer;
};

export class WorkspaceVoiceGateway {
	#client: CodexWorkspaceBackendClient;
	#queue: SpeechQueue;
	#logger: Logger;
	#policy: AnnouncementPolicy;
	#announcer?: TurnAnnouncer;
	#hookSpool?: HookSpoolObserver;

	constructor(options: WorkspaceVoiceGatewayOptions) {
		this.#logger = options.logger;
		this.#announcer = options.announcer;
		this.#client = options.workspaceClient ??
			new CodexWorkspaceBackendClient({
				webSocketTransportOptions: {
					url: options.workspaceBackendUrl,
					requestTimeoutMs: 90_000,
				},
				clientName: "codex-workspace-voice-gateway",
				clientTitle: "Codex Workspace Voice Gateway",
				clientVersion: "0.1.0",
			});
		this.#queue = new SpeechQueue({
			speaker: options.speaker,
			logger: options.logger,
			maxQueuedAnnouncements: options.maxQueuedAnnouncements,
		});
		this.#policy = {
			announceBackendConnected: options.announceBackendConnected,
			announceTurnStarted: options.announceTurnStarted,
			ignoredThreadIds: this.#ignoredThreadIds(),
		};
		if (options.hookSpool?.enabled) {
			this.#hookSpool = new HookSpoolObserver({
				spoolDir: options.hookSpool.dir,
				logger: options.logger,
				onAnnouncement: (announcement) => this.#enqueue(announcement),
			});
		}
	}

	async start(): Promise<void> {
		this.#client.on("workspaceBackendEvent", (event) =>
			this.#handleWorkspaceBackendEvent(event as WorkspaceBackendEvent)
		);
		this.#client.on("notification", (message) =>
			this.#handleNotification(message as JsonRpcNotification)
		);
		this.#client.on("error", (error) => {
			this.#logger.error("workspaceBackend.error", { error: errorMessage(error) });
		});
		this.#client.on("close", (code, reason) => {
			this.#logger.warn("workspaceBackend.closed", {
				code: typeof code === "number" ? code : null,
				reason: typeof reason === "string" ? reason : null,
			});
		});
		await this.#queue.speaker.start?.();
		await this.#hookSpool?.start();
		await this.#client.connect();
		this.#logger.info("gateway.started");
	}

	async close(): Promise<void> {
		this.#hookSpool?.close();
		this.#client.close();
		this.#announcer?.close?.();
		await this.#queue.close();
	}

	#handleWorkspaceBackendEvent(event: WorkspaceBackendEvent): void {
		const draft = draftFromWorkspaceEvent(event, this.#currentPolicy());
		if (draft) {
			this.#enqueue(draft);
		}
	}

	#handleNotification(message: JsonRpcNotification): void {
		const draft = draftFromNotification(message, this.#currentPolicy());
		if (!draft) {
			return;
		}
		if (draft.turnCompletion && this.#announcer) {
			void this.#polishAndEnqueue(draft);
			return;
		}
		this.#enqueue(draft);
	}

	async #polishAndEnqueue(draft: AnnouncementDraft): Promise<void> {
		const context = draft.turnCompletion;
		if (!context || !this.#announcer) {
			this.#enqueue(draft);
			return;
		}
		try {
			const decision = await this.#announcer.polish(context);
			if (!decision.speak) {
				this.#logger.debug?.("announcement.skippedByAnnouncer", {
					threadId: context.threadId,
					turnId: context.turnId,
				});
				return;
			}
			this.#enqueue({
				id: `${draft.id}:announcer`,
				text: decision.text,
				priority: decision.priority,
				source: "announcer",
			});
		} catch (error) {
			const decision = fallbackAnnouncerDecision(
				context,
				error,
				this.#logger,
			);
			this.#enqueue({
				id: `${draft.id}:fallback`,
				text: decision.text,
				priority: decision.priority,
				source: "announcer-fallback",
			});
		}
	}

	#enqueue(announcement: VoiceAnnouncement): void {
		this.#queue.enqueue(announcement);
	}

	#currentPolicy(): AnnouncementPolicy {
		return {
			...this.#policy,
			ignoredThreadIds: this.#ignoredThreadIds(),
		};
	}

	#ignoredThreadIds(): ReadonlySet<string> {
		return new Set(this.#announcer?.ignoredThreadIds?.() ?? []);
	}
}
