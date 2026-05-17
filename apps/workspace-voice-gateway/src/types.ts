export type Logger = {
	info(message: string, details?: Record<string, unknown>): void;
	warn(message: string, details?: Record<string, unknown>): void;
	error(message: string, details?: Record<string, unknown>): void;
	debug?(message: string, details?: Record<string, unknown>): void;
};

export const consoleLogger: Logger = {
	info(message, details) {
		log("info", message, details);
	},
	warn(message, details) {
		log("warn", message, details);
	},
	error(message, details) {
		log("error", message, details);
	},
	debug(message, details) {
		if (process.env.CODEX_VOICE_DEBUG === "1") {
			log("debug", message, details);
		}
	},
};

export type AnnouncementPriority = "low" | "normal" | "high";

export type VoiceAnnouncement = {
	id: string;
	text: string;
	priority: AnnouncementPriority;
	source: string;
};

export type Speaker = {
	start?(): Promise<void>;
	speak(text: string): Promise<void>;
	close?(): void | Promise<void>;
};

function log(
	level: "info" | "warn" | "error" | "debug",
	message: string,
	details?: Record<string, unknown>,
): void {
	const suffix = details ? ` ${JSON.stringify(details)}` : "";
	const line = `[workspace-voice-gateway] ${level}: ${message}${suffix}`;
	if (level === "error") {
		console.error(line);
		return;
	}
	if (level === "warn") {
		console.warn(line);
		return;
	}
	console.log(line);
}
