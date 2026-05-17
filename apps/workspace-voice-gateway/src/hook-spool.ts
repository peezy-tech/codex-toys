import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanForSpeech, errorMessage, record, stringValue } from "./text.ts";
import type { Logger, VoiceAnnouncement } from "./types.ts";

export type HookSpoolObserverOptions = {
	spoolDir: string;
	logger: Logger;
	onAnnouncement(announcement: VoiceAnnouncement): void;
	sinceMs?: number;
};

type HookSpoolEvent = {
	id: string;
	eventName: string;
	sessionId: string;
	turnId?: string;
	cwd?: string;
	lastAssistantMessage?: string;
	stopHookActive?: boolean;
	createdAt?: string;
};

const scanDebounceMs = 150;

export class HookSpoolObserver {
	#spoolDir: string;
	#pendingDir: string;
	#logger: Logger;
	#onAnnouncement: (announcement: VoiceAnnouncement) => void;
	#sinceMs: number;
	#seenFiles = new Set<string>();
	#seenEvents = new Set<string>();
	#watcher?: FSWatcher;
	#timer?: ReturnType<typeof setTimeout>;
	#closed = false;
	#scanning = false;

	constructor(options: HookSpoolObserverOptions) {
		this.#spoolDir = expandHome(options.spoolDir);
		this.#pendingDir = path.join(this.#spoolDir, "pending");
		this.#logger = options.logger;
		this.#onAnnouncement = options.onAnnouncement;
		this.#sinceMs = options.sinceMs ?? Date.now();
	}

	async start(): Promise<void> {
		await mkdir(this.#pendingDir, { recursive: true });
		if (this.#closed) {
			return;
		}
		this.#watcher = watch(this.#pendingDir, { persistent: false }, () => {
			this.#scheduleScan();
		});
		this.#watcher.on("error", (error) => {
			this.#logger.warn("hookSpool.watch.failed", { error: errorMessage(error) });
		});
		this.#scheduleScan(0);
	}

	close(): void {
		this.#closed = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#watcher?.close();
		this.#watcher = undefined;
	}

	async scan(): Promise<void> {
		if (this.#closed || this.#scanning) {
			return;
		}
		this.#scanning = true;
		try {
			const files = (await readdir(this.#pendingDir))
				.filter((fileName) => fileName.endsWith(".json"))
				.sort();
			for (const fileName of files) {
				await this.#processFile(fileName);
			}
		} catch (error) {
			this.#logger.warn("hookSpool.scan.failed", { error: errorMessage(error) });
		} finally {
			this.#scanning = false;
		}
	}

	#scheduleScan(delayMs = scanDebounceMs): void {
		if (this.#closed) {
			return;
		}
		if (this.#timer) {
			clearTimeout(this.#timer);
		}
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.scan();
		}, delayMs);
		this.#timer.unref?.();
	}

	async #processFile(fileName: string): Promise<void> {
		if (this.#seenFiles.has(fileName)) {
			return;
		}
		const filePath = path.join(this.#pendingDir, fileName);
		try {
			const info = await stat(filePath);
			if (info.mtimeMs < this.#sinceMs) {
				this.#seenFiles.add(fileName);
				return;
			}
			const event = parseHookSpoolEvent(JSON.parse(await readFile(filePath, "utf8")));
			this.#seenFiles.add(fileName);
			if (!event || this.#seenEvents.has(event.id)) {
				return;
			}
			this.#seenEvents.add(event.id);
			const announcement = announcementFromHookEvent(event);
			if (announcement) {
				this.#onAnnouncement(announcement);
			}
		} catch (error) {
			if (isEnoent(error)) {
				this.#seenFiles.add(fileName);
				return;
			}
			this.#logger.debug?.("hookSpool.file.skipped", {
				fileName,
				error: errorMessage(error),
			});
		}
	}
}

export function announcementFromHookEvent(
	event: HookSpoolEvent,
): VoiceAnnouncement | undefined {
	if (event.eventName !== "Stop" || event.stopHookActive === true) {
		return undefined;
	}
	return {
		id: `hook-stop:${event.id}`,
		source: "codex-hook-spool",
		priority: "normal",
		text: cleanForSpeech(hookAnnouncementText(event)),
	};
}

function hookAnnouncementText(event: HookSpoolEvent): string {
	const workspace = event.cwd ? path.basename(event.cwd) : "that workspace";
	const detail = event.lastAssistantMessage?.trim();
	if (!detail) {
		return `Hey, about ${workspace}. I just finished that turn.`;
	}
	return `Hey, about ${workspace}. I just finished: ${detail}`;
}

function parseHookSpoolEvent(input: unknown): HookSpoolEvent | undefined {
	const parsed = record(input);
	if (parsed.version !== 1) {
		return undefined;
	}
	const id = stringValue(parsed.id);
	const eventName = stringValue(parsed.eventName);
	const sessionId = stringValue(parsed.sessionId);
	if (!id || !eventName || !sessionId) {
		return undefined;
	}
	return {
		id,
		eventName,
		sessionId,
		turnId: stringValue(parsed.turnId),
		cwd: stringValue(parsed.cwd),
		lastAssistantMessage: stringValue(parsed.lastAssistantMessage),
		stopHookActive: typeof parsed.stopHookActive === "boolean"
			? parsed.stopHookActive
			: undefined,
		createdAt: stringValue(parsed.createdAt),
	};
}

function expandHome(value: string): string {
	if (value === "~") {
		return os.homedir();
	}
	if (value.startsWith("~/")) {
		return path.join(os.homedir(), value.slice(2));
	}
	return value;
}

function isEnoent(error: unknown): boolean {
	return error instanceof Error &&
		"code" in error &&
		String((error as NodeJS.ErrnoException).code) === "ENOENT";
}
