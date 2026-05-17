import type { ReasoningEffort } from "@peezy.tech/codex-flows/generated";

export type VoiceGatewayConfig = {
	workspaceBackendUrl: string;
	ttsWorkerUrl: string;
	dryRun: boolean;
	maxPhraseChars: number;
	maxQueuedAnnouncements: number;
	announceBackendConnected: boolean;
	announceTurnStarted: boolean;
	hookSpool: {
		enabled: boolean;
		dir: string;
	};
	discord: {
		token: string | null;
		guildId: string | null;
		voiceChannelId: string | null;
	};
	tts: {
		referenceAudioPath: string | null;
		referenceText: string | null;
		referenceTextPath: string | null;
	};
	announcer: {
		enabled: boolean;
		model: string;
		reasoningEffort: ReasoningEffort;
		timeoutMs: number;
		cwd: string | null;
	};
};

export type CliParseResult =
	| { type: "config"; config: VoiceGatewayConfig }
	| { type: "help"; text: string };

const defaultWorkspaceBackendUrl = "ws://127.0.0.1:3586";
const defaultTtsWorkerUrl = "http://127.0.0.1:8000";

export function parseCli(
	argv: string[],
	env: Record<string, string | undefined> = process.env,
): CliParseResult {
	const flags = parseFlags(argv);
	if (flags.has("help") || flags.has("h")) {
		return { type: "help", text: helpText() };
	}

	const dryRun = booleanValue(flags, env, {
		flag: "dry-run",
		env: "CODEX_VOICE_DRY_RUN",
		defaultValue: false,
	});
	const announcerEnabled = booleanValue(flags, env, {
		flag: "announcer",
		negativeFlag: "no-announcer",
		env: "CODEX_VOICE_ANNOUNCER_ENABLED",
		defaultValue: false,
	});
	const config: VoiceGatewayConfig = {
		workspaceBackendUrl: normalizeWorkspaceBackendUrl(
			stringOption(flags, env, [
				"workspace-backend-url",
				"workspace-url",
			], [
				"CODEX_VOICE_WORKSPACE_BACKEND_WS_URL",
				"CODEX_WORKSPACE_BACKEND_WS_URL",
				"CODEX_GATEWAY_BACKEND_URL",
			]) ?? defaultWorkspaceBackendUrl,
		),
		ttsWorkerUrl: stripTrailingSlash(
			stringOption(flags, env, ["tts-worker-url"], [
				"CODEX_VOICE_TTS_WORKER_URL",
				"DISCORD_TTS_WORKER_URL",
			]) ?? defaultTtsWorkerUrl,
		),
		dryRun,
		maxPhraseChars: numberOption(flags, env, "max-phrase-chars", "CODEX_VOICE_MAX_PHRASE_CHARS", 260),
		maxQueuedAnnouncements: numberOption(flags, env, "max-queued-announcements", "CODEX_VOICE_MAX_QUEUE", 20),
		announceBackendConnected: booleanValue(flags, env, {
			flag: "announce-backend-connected",
			negativeFlag: "no-announce-backend-connected",
			env: "CODEX_VOICE_ANNOUNCE_BACKEND_CONNECTED",
			defaultValue: true,
		}),
		announceTurnStarted: booleanValue(flags, env, {
			flag: "announce-turn-started",
			negativeFlag: "no-announce-turn-started",
			env: "CODEX_VOICE_ANNOUNCE_TURN_STARTED",
			defaultValue: false,
		}),
		hookSpool: {
			enabled: booleanValue(flags, env, {
				flag: "observe-hook-spool",
				negativeFlag: "no-observe-hook-spool",
				env: "CODEX_VOICE_OBSERVE_HOOK_SPOOL",
				defaultValue: true,
			}),
			dir: stringOption(flags, env, ["hook-spool-dir"], [
				"CODEX_VOICE_HOOK_SPOOL_DIR",
				"CODEX_DISCORD_HOOK_SPOOL_DIR",
			]) ?? "~/.codex/discord-bridge/stop-hooks",
		},
		discord: {
			token: stringOption(flags, env, ["discord-token"], [
				"CODEX_VOICE_DISCORD_BOT_TOKEN",
				"CODEX_DISCORD_BOT_TOKEN",
				"DISCORD_BOT_TOKEN",
			]) ?? null,
			guildId: stringOption(flags, env, ["discord-guild-id"], [
				"CODEX_VOICE_DISCORD_GUILD_ID",
				"CODEX_DISCORD_GUILD_ID",
				"DISCORD_GUILD_ID",
			]) ?? null,
			voiceChannelId: stringOption(flags, env, [
				"discord-voice-channel-id",
				"discord-channel-id",
			], [
				"CODEX_VOICE_DISCORD_VOICE_CHANNEL_ID",
				"CODEX_GATEWAY_DISCORD_VOICE_CHANNEL_ID",
				"DISCORD_VOICE_CHANNEL_ID",
			]) ?? null,
		},
		tts: {
			referenceAudioPath: stringOption(flags, env, ["reference-audio-path"], [
				"CODEX_VOICE_TTS_REFERENCE_AUDIO_PATH",
				"DISCORD_TTS_REFERENCE_AUDIO_PATH",
			]) ?? null,
			referenceText: stringOption(flags, env, ["reference-text"], [
				"CODEX_VOICE_TTS_REFERENCE_TEXT",
				"DISCORD_TTS_REFERENCE_TEXT",
			]) ?? null,
			referenceTextPath: stringOption(flags, env, ["reference-text-path"], [
				"CODEX_VOICE_TTS_REFERENCE_TEXT_PATH",
				"DISCORD_TTS_REFERENCE_TEXT_PATH",
			]) ?? null,
		},
		announcer: {
			enabled: announcerEnabled,
			model: stringOption(flags, env, ["announcer-model"], [
				"CODEX_VOICE_ANNOUNCER_MODEL",
			]) ?? "gpt-5.3-codex-spark",
			reasoningEffort: reasoningEffortValue(
				stringOption(flags, env, ["announcer-reasoning-effort"], [
					"CODEX_VOICE_ANNOUNCER_REASONING_EFFORT",
				]) ?? "low",
			),
			timeoutMs: numberOption(flags, env, "announcer-timeout-ms", "CODEX_VOICE_ANNOUNCER_TIMEOUT_MS", 90_000),
			cwd: stringOption(flags, env, ["announcer-cwd"], [
				"CODEX_VOICE_ANNOUNCER_CWD",
			]) ?? null,
		},
	};

	validateConfig(config);
	return { type: "config", config };
}

export function helpText(): string {
	return `Usage: codex-workspace-voice-gateway [options]

Broadcast selected Codex workspace backend updates into one Discord voice channel.

Options:
  --workspace-backend-url <url>     Workspace backend WebSocket URL.
  --tts-worker-url <url>            TTS worker HTTP URL.
  --discord-token <token>           Discord bot token.
  --discord-guild-id <id>           Discord guild id.
  --discord-voice-channel-id <id>   Discord voice channel id.
  --reference-audio-path <path>     TTS reference voice audio path.
  --reference-text <text>           TTS reference transcript.
  --reference-text-path <path>      TTS reference transcript path.
  --announcer                       Enable model-polished turn-end phrases.
  --announcer-model <model>         Announcer model override.
  --announcer-reasoning-effort <e>  Announcer reasoning effort. Defaults to low.
  --max-phrase-chars <n>            Announcer phrase target. Defaults to 260.
  --hook-spool-dir <path>           Codex hook event spool directory.
  --no-observe-hook-spool           Do not watch external Codex hook events.
  --dry-run                         Log announcements instead of joining Discord.
  --help                            Show this help.
`;
}

function validateConfig(config: VoiceGatewayConfig): void {
	if (!config.dryRun) {
		const missing = [
			["Discord bot token", config.discord.token],
			["Discord voice channel id", config.discord.voiceChannelId],
		].filter(([, value]) => !value);
		if (missing.length > 0) {
			throw new Error(
				`Missing required voice gateway config: ${
					missing.map(([name]) => name).join(", ")
				}. Use --dry-run to skip Discord voice output.`,
			);
		}
	}
}

function parseFlags(argv: string[]): Map<string, string | true> {
	const flags = new Map<string, string | true>();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg?.startsWith("--")) {
			throw new Error(`Unexpected positional argument: ${arg ?? ""}`);
		}
		const raw = arg.slice(2);
		const equalsIndex = raw.indexOf("=");
		if (equalsIndex >= 0) {
			flags.set(raw.slice(0, equalsIndex), raw.slice(equalsIndex + 1));
			continue;
		}
		const next = argv[index + 1];
		if (next && !next.startsWith("--")) {
			flags.set(raw, next);
			index += 1;
			continue;
		}
		flags.set(raw, true);
	}
	return flags;
}

function stringOption(
	flags: Map<string, string | true>,
	env: Record<string, string | undefined>,
	names: string[],
	envNames: string[],
): string | undefined {
	for (const name of names) {
		const value = flags.get(name);
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	for (const envName of envNames) {
		const value = env[envName];
		if (value?.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

function numberOption(
	flags: Map<string, string | true>,
	env: Record<string, string | undefined>,
	flagName: string,
	envName: string,
	defaultValue: number,
): number {
	const raw = flags.get(flagName) ?? env[envName];
	if (raw === undefined || raw === true || raw === "") {
		return defaultValue;
	}
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Expected a non-negative number for ${flagName}`);
	}
	return value;
}

function booleanValue(
	flags: Map<string, string | true>,
	env: Record<string, string | undefined>,
	options: {
		flag: string;
		negativeFlag?: string;
		env: string;
		defaultValue: boolean;
	},
): boolean {
	if (options.negativeFlag && flags.has(options.negativeFlag)) {
		return false;
	}
	if (flags.has(options.flag)) {
		const value = flags.get(options.flag);
		return value === true ? true : value === "1" || value === "true";
	}
	const envValue = env[options.env];
	if (envValue === undefined) {
		return options.defaultValue;
	}
	return envValue === "1" || envValue.toLowerCase() === "true";
}

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function normalizeWorkspaceBackendUrl(value: string): string {
	if (value.startsWith("http://")) {
		return `ws://${value.slice("http://".length).replace(/\/+$/, "")}`;
	}
	if (value.startsWith("https://")) {
		return `wss://${value.slice("https://".length).replace(/\/+$/, "")}`;
	}
	return value;
}

function reasoningEffortValue(value: string): ReasoningEffort {
	if (
		value === "none" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	) {
		return value;
	}
	throw new Error(`Unsupported announcer reasoning effort: ${value}`);
}
