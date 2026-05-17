import { once } from "node:events";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import {
	AudioPlayerStatus,
	StreamType,
	VoiceConnectionStatus,
	createAudioPlayer,
	createAudioResource,
	entersState,
	joinVoiceChannel,
	type AudioPlayer,
	type VoiceConnection,
} from "@discordjs/voice";
import {
	ChannelType,
	Client,
	Events,
	GatewayIntentBits,
	type Guild,
	type VoiceBasedChannel,
} from "discord.js";
import type { TtsAudioStream, TtsWorkerClient } from "./tts-client.ts";
import { errorMessage } from "./text.ts";
import type { Logger, Speaker } from "./types.ts";

export type DiscordVoiceSpeakerOptions = {
	token: string;
	guildId?: string | null;
	voiceChannelId: string;
	tts: TtsWorkerClient;
	logger: Logger;
};

type ActivePlayback = {
	cleanup(): void;
	pumpTask: Promise<void>;
	resource: ReturnType<typeof createAudioResource>;
};

export class DiscordVoiceSpeaker implements Speaker {
	#token: string;
	#guildId: string | null;
	#voiceChannelId: string;
	#tts: TtsWorkerClient;
	#logger: Logger;
	#client?: Client;
	#connection?: VoiceConnection;
	#player?: AudioPlayer;
	#activePlayback: ActivePlayback | null = null;
	#playbackResolver: (() => void) | null = null;
	#closed = false;
	#rejoining = false;

	constructor(options: DiscordVoiceSpeakerOptions) {
		this.#token = options.token;
		this.#guildId = options.guildId ?? null;
		this.#voiceChannelId = options.voiceChannelId;
		this.#tts = options.tts;
		this.#logger = options.logger;
	}

	async start(): Promise<void> {
		this.#closed = false;
		await this.#tts.ensureHealthy();
		const client = new Client({
			intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
		});
		this.#client = client;
		client.on("error", (error) => {
			this.#logger.error("discord.client.error", { error: errorMessage(error) });
		});
		await new Promise<void>((resolve, reject) => {
			const fail = (error: unknown) => reject(error);
			client.once("error", fail);
			client.once(Events.ClientReady, (readyClient) => {
				const cachedGuild = this.#guildId
					? readyClient.guilds.cache.get(this.#guildId) ?? null
					: null;
				void this.#join(cachedGuild)
					.then(resolve, reject)
					.finally(() => client.off("error", fail));
			});
			void client.login(this.#token).catch(fail);
		});
	}

	async speak(text: string): Promise<void> {
		const player = this.#player;
		if (!player) {
			throw new Error("Discord voice speaker is not started");
		}
		const outputPath = path.join(os.tmpdir(), `codex-voice-${randomUUID()}.wav`);
		let filePath = outputPath;
		try {
			const file = await this.#tts.synthesizeFile(text, outputPath);
			filePath = file.outputPath;
			const playback = await createWavFileResource(filePath);
			const playbackFinished = new Promise<void>((resolve) => {
				this.#playbackResolver = resolve;
			});
			this.#activePlayback = playback;
			player.play(playback.resource);
			await playbackFinished;
			await playback.pumpTask.catch(() => undefined);
		} finally {
			void unlink(filePath).catch(() => undefined);
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#activePlayback?.cleanup();
		this.#connection?.destroy();
		await this.#client?.destroy();
	}

	async #join(cachedGuild: Guild | null): Promise<void> {
		const client = this.#client;
		if (!client) {
			throw new Error("Discord client is not initialized");
		}
		if (!this.#guildId) {
			const channel = await client.channels.fetch(this.#voiceChannelId);
			if (!channel || channel.type !== ChannelType.GuildVoice) {
				throw new Error(`Discord channel ${this.#voiceChannelId} is not a guild voice channel`);
			}
			await this.#joinVoiceChannel(channel as VoiceBasedChannel);
			return;
		}
		const guild = cachedGuild ?? await client.guilds.fetch(this.#guildId);
		const channel = await guild.channels.fetch(this.#voiceChannelId);
		if (!channel || channel.type !== ChannelType.GuildVoice) {
			throw new Error(`Discord channel ${this.#voiceChannelId} is not a guild voice channel`);
		}
		await this.#joinVoiceChannel(channel as VoiceBasedChannel);
	}

	async #joinVoiceChannel(voiceChannel: VoiceBasedChannel): Promise<void> {
		const guild = voiceChannel.guild;
		const connection = joinVoiceChannel({
			channelId: voiceChannel.id,
			guildId: guild.id,
			adapterCreator: guild.voiceAdapterCreator,
			selfDeaf: true,
			selfMute: false,
		});
		this.#connection = connection;
		connection.on(VoiceConnectionStatus.Disconnected, () => {
			void this.#recoverConnection(connection);
		});
		await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
		const player = createAudioPlayer();
		player.on(AudioPlayerStatus.Idle, () => this.#resolvePlayback());
		player.on("error", (error) => {
			this.#logger.error("discord.player.error", { error: errorMessage(error) });
			this.#resolvePlayback();
		});
		connection.subscribe(player);
		this.#player = player;
		this.#logger.info("discord.voice.connected", {
			guild: guild.name,
			channel: voiceChannel.name,
		});
	}

	async #recoverConnection(connection: VoiceConnection): Promise<void> {
		if (this.#closed || this.#rejoining) {
			return;
		}
		this.#rejoining = true;
		this.#logger.warn("discord.voice.disconnected");
		try {
			await Promise.race([
				entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
				entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
			]);
		} catch {
			if (this.#connection === connection) {
				connection.destroy();
				this.#connection = undefined;
				try {
					await this.#join(null);
				} catch (error) {
					this.#logger.error("discord.voice.rejoinFailed", {
						error: errorMessage(error),
					});
				}
			}
		} finally {
			this.#rejoining = false;
		}
	}

	#resolvePlayback(): void {
		const playback = this.#activePlayback;
		this.#activePlayback = null;
		playback?.cleanup();
		const resolve = this.#playbackResolver;
		this.#playbackResolver = null;
		resolve?.();
	}
}

export async function createWavFileResource(filePath: string): Promise<ActivePlayback> {
	const wav = await readFile(filePath);
	const pcm = wavToDiscordPcm(wav);
	const source = Readable.from([pcm]);
	return {
		resource: createAudioResource(source, { inputType: StreamType.Raw }),
		cleanup() {
			source.destroy();
		},
		pumpTask: Promise.resolve(),
	};
}

export async function createStreamingPcmResource(
	stream: TtsAudioStream,
	prerollMs: number,
): Promise<ActivePlayback> {
	if (stream.sampleRateHz !== 48000 || stream.channels !== 2) {
		throw new Error(
			`Expected Discord-ready PCM stream (48000 Hz stereo), got ${
				stream.sampleRateHz
			} Hz / ${stream.channels} channels`,
		);
	}
	const bytesPerSecond = stream.sampleRateHz * stream.channels * 2;
	const prerollBytes = Math.max(
		Math.floor((bytesPerSecond * Math.max(prerollMs, 0)) / 1000),
		0,
	);
	const reader = stream.body.getReader();
	const initialChunks: Buffer[] = [];
	let initialBytes = 0;
	while (initialBytes < prerollBytes) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		if (!value || value.byteLength === 0) {
			continue;
		}
		const chunk = Buffer.from(value);
		initialChunks.push(chunk);
		initialBytes += chunk.byteLength;
	}
	const source = new PassThrough({
		highWaterMark: Math.max(prerollBytes, 256 * 1024),
	});
	for (const chunk of initialChunks) {
		source.write(chunk);
	}
	let stopped = false;
	const pumpTask = (async () => {
		try {
			while (!stopped) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				if (!value || value.byteLength === 0) {
					continue;
				}
				if (!source.write(Buffer.from(value))) {
					await once(source, "drain");
				}
			}
			source.end();
		} catch (error) {
			if (!stopped) {
				source.destroy(error instanceof Error ? error : new Error(String(error)));
			}
		} finally {
			reader.releaseLock();
		}
	})();
	return {
		resource: createAudioResource(source, { inputType: StreamType.Raw }),
		cleanup() {
			stopped = true;
			void reader.cancel().catch(() => undefined);
			source.destroy();
		},
		pumpTask,
	};
}

export function wavToDiscordPcm(wav: Buffer): Buffer {
	const parsed = parsePcmWav(wav);
	const targetSampleRateHz = 48000;
	const targetChannels = 2;
	const frameCount = parsed.data.length / (parsed.channels * 2);
	const targetFrameCount = Math.max(
		1,
		Math.ceil((frameCount * targetSampleRateHz) / parsed.sampleRateHz),
	);
	const output = Buffer.alloc(targetFrameCount * targetChannels * 2);
	for (let targetFrame = 0; targetFrame < targetFrameCount; targetFrame += 1) {
		const sourceFrame = Math.min(
			Math.floor((targetFrame * parsed.sampleRateHz) / targetSampleRateHz),
			frameCount - 1,
		);
		const sourceOffset = sourceFrame * parsed.channels * 2;
		const left = parsed.data.readInt16LE(sourceOffset);
		const right = parsed.channels > 1
			? parsed.data.readInt16LE(sourceOffset + 2)
			: left;
		const targetOffset = targetFrame * targetChannels * 2;
		output.writeInt16LE(left, targetOffset);
		output.writeInt16LE(right, targetOffset + 2);
	}
	return output;
}

function parsePcmWav(wav: Buffer): {
	channels: number;
	sampleRateHz: number;
	data: Buffer;
} {
	if (
		wav.length < 44 ||
		wav.toString("ascii", 0, 4) !== "RIFF" ||
		wav.toString("ascii", 8, 12) !== "WAVE"
	) {
		throw new Error("Expected a RIFF/WAVE file from TTS worker");
	}

	let offset = 12;
	let channels: number | undefined;
	let sampleRateHz: number | undefined;
	let bitsPerSample: number | undefined;
	let audioFormat: number | undefined;
	let data: Buffer | undefined;

	while (offset + 8 <= wav.length) {
		const chunkId = wav.toString("ascii", offset, offset + 4);
		const chunkSize = wav.readUInt32LE(offset + 4);
		const chunkStart = offset + 8;
		const chunkEnd = chunkStart + chunkSize;
		if (chunkEnd > wav.length) {
			throw new Error("Malformed WAV chunk from TTS worker");
		}
		if (chunkId === "fmt ") {
			audioFormat = wav.readUInt16LE(chunkStart);
			channels = wav.readUInt16LE(chunkStart + 2);
			sampleRateHz = wav.readUInt32LE(chunkStart + 4);
			bitsPerSample = wav.readUInt16LE(chunkStart + 14);
		} else if (chunkId === "data") {
			data = wav.subarray(chunkStart, chunkEnd);
		}
		offset = chunkEnd + (chunkSize % 2);
	}

	if (audioFormat !== 1 || bitsPerSample !== 16 || !channels || !sampleRateHz || !data) {
		throw new Error("Expected 16-bit PCM WAV audio from TTS worker");
	}
	return { channels, sampleRateHz, data };
}
