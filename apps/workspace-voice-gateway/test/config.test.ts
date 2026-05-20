import { describe, expect, test } from "vite-plus/test";

import { parseCli } from "../src/config.ts";

describe("parseCli", () => {
	test("supports dry-run without Discord credentials", () => {
		const parsed = parseCli(["--dry-run"], {});
		expect(parsed.type).toBe("config");
		if (parsed.type === "config") {
			expect(parsed.config.dryRun).toBe(true);
			expect(parsed.config.workspaceBackendUrl).toBe("ws://127.0.0.1:3586");
			expect(parsed.config.ttsWorkerUrl).toBe("http://127.0.0.1:8000");
			expect(parsed.config.hookSpool.enabled).toBe(true);
			expect(parsed.config.hookSpool.dir).toBe("~/.codex/discord-bridge/stop-hooks");
		}
	});

	test("requires Discord credentials when not in dry-run mode", () => {
		expect(() => parseCli([], {})).toThrow("Missing required voice gateway config");
	});

	test("does not require a guild id when a voice channel id is provided", () => {
		const parsed = parseCli([], {
			CODEX_DISCORD_BOT_TOKEN: "token",
			CODEX_GATEWAY_DISCORD_VOICE_CHANNEL_ID: "voice",
		});
		expect(parsed.type).toBe("config");
		if (parsed.type === "config") {
			expect(parsed.config.discord.guildId).toBeNull();
			expect(parsed.config.discord.voiceChannelId).toBe("voice");
		}
	});

	test("reads workspace, Discord, TTS, and announcer config from env and flags", () => {
		const parsed = parseCli([
			"--announcer",
			"--announcer-model",
			"gpt-test",
			"--max-phrase-chars",
			"120",
		], {
			CODEX_GATEWAY_BACKEND_URL: "http://workspace.example/",
			DISCORD_TTS_WORKER_URL: "http://127.0.0.1:8000/",
			DISCORD_BOT_TOKEN: "token",
			DISCORD_GUILD_ID: "guild",
			DISCORD_VOICE_CHANNEL_ID: "voice",
			DISCORD_TTS_REFERENCE_AUDIO_PATH: "references/jo.wav",
			DISCORD_TTS_REFERENCE_TEXT_PATH: "references/jo.txt",
			CODEX_VOICE_HOOK_SPOOL_DIR: "/tmp/hooks",
		});
		expect(parsed.type).toBe("config");
		if (parsed.type === "config") {
			expect(parsed.config.workspaceBackendUrl).toBe("ws://workspace.example");
			expect(parsed.config.ttsWorkerUrl).toBe("http://127.0.0.1:8000");
			expect(parsed.config.discord.token).toBe("token");
			expect(parsed.config.tts.referenceAudioPath).toBe("references/jo.wav");
			expect(parsed.config.hookSpool.dir).toBe("/tmp/hooks");
			expect(parsed.config.announcer.enabled).toBe(true);
			expect(parsed.config.announcer.model).toBe("gpt-test");
			expect(parsed.config.maxPhraseChars).toBe(120);
		}
	});
});
