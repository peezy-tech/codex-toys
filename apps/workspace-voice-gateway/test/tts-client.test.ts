import { describe, expect, test } from "vite-plus/test";
import http from "node:http";

import { createStreamingPcmResource, wavToDiscordPcm } from "../src/discord-voice.ts";
import { TtsWorkerClient } from "../src/tts-client.ts";

describe("TtsWorkerClient", () => {
	test("checks health and requests streaming synthesis with reference voice config", async () => {
		let receivedPayload: Record<string, unknown> | undefined;
		const server = await createHttpTestServer(
			async (request) => {
				const url = new URL(request.url);
				if (url.pathname === "/health") {
					return Response.json({ status: "ok", engine: "test" });
				}
				if (url.pathname === "/v1/synthesize/stream") {
					receivedPayload = await request.json() as Record<string, unknown>;
					return new Response(pcmStream(), {
						headers: {
							"x-request-id": "request-1",
							"x-sample-rate-hz": "48000",
							"x-channels": "2",
						},
					});
				}
				return new Response("not found", { status: 404 });
			},
		);
		try {
			const client = new TtsWorkerClient({
				workerUrl: server.url,
				referenceAudioPath: "references/jo.wav",
				referenceTextPath: "references/jo.txt",
			});
			await client.ensureHealthy();
			const stream = await client.synthesizeStream("hello workspace");
			expect(stream.requestId).toBe("request-1");
			expect(stream.sampleRateHz).toBe(48000);
			expect(stream.channels).toBe(2);
			expect(receivedPayload).toMatchObject({
				text: "hello workspace",
				reference_audio_path: "references/jo.wav",
				reference_text_path: "references/jo.txt",
			});
		} finally {
			await server.close();
		}
	});

	test("requests file synthesis with an explicit output path", async () => {
		let receivedPayload: Record<string, unknown> | undefined;
		const server = await createHttpTestServer(
			async (request) => {
				const url = new URL(request.url);
				if (url.pathname === "/health") {
					return Response.json({ status: "ok", engine: "test" });
				}
				if (url.pathname === "/v1/synthesize") {
					receivedPayload = await request.json() as Record<string, unknown>;
					return Response.json({
						request_id: "file-request-1",
						engine: "NeuTTS",
						voice: "default",
						output_path: "/tmp/codex-voice.wav",
						format: "wav",
						sample_rate_hz: 24000,
						duration_seconds: 1.25,
					});
				}
				return new Response("not found", { status: 404 });
			},
		);
		try {
			const client = new TtsWorkerClient({
				workerUrl: server.url,
				referenceAudioPath: "references/jo.wav",
				referenceTextPath: "references/jo.txt",
			});
			const file = await client.synthesizeFile("hello workspace", "/tmp/codex-voice.wav");
			expect(file).toEqual({
				requestId: "file-request-1",
				outputPath: "/tmp/codex-voice.wav",
				sampleRateHz: 24000,
				durationSeconds: 1.25,
			});
			expect(receivedPayload).toMatchObject({
				text: "hello workspace",
				output_path: "/tmp/codex-voice.wav",
				reference_audio_path: "references/jo.wav",
				reference_text_path: "references/jo.txt",
			});
		} finally {
			await server.close();
		}
	});
});

describe("createStreamingPcmResource", () => {
	test("accepts Discord-ready PCM streams", async () => {
		const playback = await createStreamingPcmResource({
			body: pcmStream(),
			requestId: "request-1",
			sampleRateHz: 48000,
			channels: 2,
		}, 0);
		playback.cleanup();
		await playback.pumpTask.catch(() => undefined);
		expect(playback.resource).toBeDefined();
	});

	test("rejects non-Discord PCM streams", async () => {
		await expect(createStreamingPcmResource({
			body: pcmStream(),
			requestId: "request-1",
			sampleRateHz: 24000,
			channels: 1,
		}, 0)).rejects.toThrow("Expected Discord-ready PCM stream");
	});

	test("converts 24 kHz mono WAV to Discord-ready PCM", () => {
		const wav = pcmWav({
			sampleRateHz: 24000,
			channels: 1,
			samples: [1000, -1000],
		});
		const pcm = wavToDiscordPcm(wav);
		expect(pcm.length).toBe(16);
		expect(pcm.readInt16LE(0)).toBe(1000);
		expect(pcm.readInt16LE(2)).toBe(1000);
		expect(pcm.readInt16LE(4)).toBe(1000);
		expect(pcm.readInt16LE(6)).toBe(1000);
		expect(pcm.readInt16LE(8)).toBe(-1000);
		expect(pcm.readInt16LE(10)).toBe(-1000);
	});
});

function pcmStream(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(3840));
			controller.close();
		},
	});
}

async function createHttpTestServer(
	handler: (request: Request) => Response | Promise<Response>,
): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((request, response) => {
		void (async () => {
			const webResponse = await handler(await toWebRequest(request));
			response.statusCode = webResponse.status;
			for (const [name, value] of webResponse.headers) {
				response.setHeader(name, value);
			}
			response.end(Buffer.from(await webResponse.arrayBuffer()));
		})().catch((error: unknown) => {
			response.statusCode = 500;
			response.end(error instanceof Error ? error.message : String(error));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (typeof address !== "object" || !address) {
		throw new Error("test server did not start");
	}
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		}),
	};
}

async function toWebRequest(request: http.IncomingMessage): Promise<Request> {
	const host = request.headers.host ?? "127.0.0.1";
	const url = new URL(request.url ?? "/", `http://${host}`);
	const body = request.method === "GET" || request.method === "HEAD"
		? undefined
		: await collectBody(request);
	return new Request(url, {
		method: request.method,
		headers: nodeHeaders(request.headers),
		body,
	});
}

function nodeHeaders(headers: http.IncomingHttpHeaders): Headers {
	const result = new Headers();
	for (const [name, value] of Object.entries(headers)) {
		if (Array.isArray(value)) {
			for (const entry of value) {
				result.append(name, entry);
			}
		} else if (value !== undefined) {
			result.set(name, value);
		}
	}
	return result;
}

async function collectBody(request: http.IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

function pcmWav(input: {
	sampleRateHz: number;
	channels: number;
	samples: number[];
}): Buffer {
	const data = Buffer.alloc(input.samples.length * 2);
	for (const [index, sample] of input.samples.entries()) {
		data.writeInt16LE(sample, index * 2);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(input.channels, 22);
	header.writeUInt32LE(input.sampleRateHz, 24);
	header.writeUInt32LE(input.sampleRateHz * input.channels * 2, 28);
	header.writeUInt16LE(input.channels * 2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}
