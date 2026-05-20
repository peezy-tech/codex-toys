#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { CodexTurnAnnouncer } from "./announcer.ts";
import { parseCli } from "./config.ts";
import { DiscordVoiceSpeaker } from "./discord-voice.ts";
import { WorkspaceVoiceGateway } from "./gateway.ts";
import { ConsoleSpeaker } from "./speech-queue.ts";
import { errorMessage } from "./text.ts";
import { TtsWorkerClient } from "./tts-client.ts";
import { consoleLogger } from "./types.ts";

async function main(): Promise<void> {
	const parsed = parseCli(process.argv.slice(2), process.env);
	if (parsed.type === "help") {
		process.stdout.write(parsed.text);
		return;
	}
	const config = parsed.config;
	const logger = consoleLogger;
	const tts = new TtsWorkerClient({
		workerUrl: config.ttsWorkerUrl,
		referenceAudioPath: config.tts.referenceAudioPath,
		referenceText: config.tts.referenceText,
		referenceTextPath: config.tts.referenceTextPath,
	});
	const speaker = config.dryRun
		? new ConsoleSpeaker(logger)
		: new DiscordVoiceSpeaker({
				token: requireConfig(config.discord.token, "Discord token"),
				guildId: config.discord.guildId,
				voiceChannelId: requireConfig(
					config.discord.voiceChannelId,
					"Discord voice channel id",
				),
				tts,
				logger,
			});
	const announcer = config.announcer.enabled
		? new CodexTurnAnnouncer({
				workspaceBackendUrl: config.workspaceBackendUrl,
				model: config.announcer.model,
				reasoningEffort: config.announcer.reasoningEffort,
				timeoutMs: config.announcer.timeoutMs,
				maxPhraseChars: config.maxPhraseChars,
				cwd: config.announcer.cwd,
				logger,
			})
		: undefined;
	const gateway = new WorkspaceVoiceGateway({
		workspaceBackendUrl: config.workspaceBackendUrl,
		speaker,
		logger,
		maxQueuedAnnouncements: config.maxQueuedAnnouncements,
		announceBackendConnected: config.announceBackendConnected,
		announceTurnStarted: config.announceTurnStarted,
		hookSpool: config.hookSpool,
		announcer,
	});
	await gateway.start();
	await waitForShutdown(gateway);
}

function requireConfig(value: string | null, label: string): string {
	if (!value) {
		throw new Error(`Missing ${label}`);
	}
	return value;
}

function waitForShutdown(gateway: WorkspaceVoiceGateway): Promise<void> {
	return new Promise((resolve) => {
		const shutdown = () => {
			process.off("SIGINT", shutdown);
			process.off("SIGTERM", shutdown);
			void gateway.close().finally(resolve);
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	});
}

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
	main().catch((error) => {
		console.error(errorMessage(error));
		process.exitCode = 1;
	});
}
