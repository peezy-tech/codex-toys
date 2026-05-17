import { errorMessage } from "./text.ts";
import type { Logger, Speaker, VoiceAnnouncement } from "./types.ts";

export type SpeechQueueOptions = {
	speaker: Speaker;
	logger: Logger;
	maxQueuedAnnouncements: number;
	maxSeenAnnouncements?: number;
};

export class SpeechQueue {
	readonly speaker: Speaker;
	readonly logger: Logger;
	#queue: VoiceAnnouncement[] = [];
	#seen = new Set<string>();
	#seenOrder: string[] = [];
	#draining = false;
	#closed = false;
	#maxQueuedAnnouncements: number;
	#maxSeenAnnouncements: number;

	constructor(options: SpeechQueueOptions) {
		this.speaker = options.speaker;
		this.logger = options.logger;
		this.#maxQueuedAnnouncements = options.maxQueuedAnnouncements;
		this.#maxSeenAnnouncements = options.maxSeenAnnouncements ?? 1000;
	}

	enqueue(announcement: VoiceAnnouncement): boolean {
		if (this.#closed || !announcement.text.trim()) {
			return false;
		}
		if (this.#seen.has(announcement.id)) {
			this.logger.debug?.("announcement.deduped", { id: announcement.id });
			return false;
		}
		this.#remember(announcement.id);
		if (this.#queue.length >= this.#maxQueuedAnnouncements) {
			const dropped = this.#queue.shift();
			this.logger.warn("announcement.dropped", {
				id: dropped?.id,
				reason: "queue-full",
			});
		}
		if (announcement.priority === "high") {
			this.#queue.unshift(announcement);
		} else {
			this.#queue.push(announcement);
		}
		this.#drain();
		return true;
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#queue = [];
		await this.speaker.close?.();
	}

	get size(): number {
		return this.#queue.length;
	}

	#drain(): void {
		if (this.#draining) {
			return;
		}
		this.#draining = true;
		void (async () => {
			while (!this.#closed) {
				const next = this.#queue.shift();
				if (!next) {
					break;
				}
				try {
					this.logger.info("announcement.speak", {
						id: next.id,
						source: next.source,
						priority: next.priority,
					});
					await this.speaker.speak(next.text);
				} catch (error) {
					this.logger.error("announcement.failed", {
						id: next.id,
						error: errorMessage(error),
					});
				}
			}
			this.#draining = false;
			if (this.#queue.length > 0 && !this.#closed) {
				this.#drain();
			}
		})();
	}

	#remember(id: string): void {
		this.#seen.add(id);
		this.#seenOrder.push(id);
		while (this.#seenOrder.length > this.#maxSeenAnnouncements) {
			const expired = this.#seenOrder.shift();
			if (expired) {
				this.#seen.delete(expired);
			}
		}
	}
}

export class ConsoleSpeaker implements Speaker {
	readonly logger: Logger;

	constructor(logger: Logger) {
		this.logger = logger;
	}

	async speak(text: string): Promise<void> {
		this.logger.info("dry-run.speech", { text });
	}
}
