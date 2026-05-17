export type TtsWorkerClientOptions = {
	workerUrl: string;
	referenceAudioPath?: string | null;
	referenceText?: string | null;
	referenceTextPath?: string | null;
};

export type TtsAudioStream = {
	body: ReadableStream<Uint8Array>;
	requestId: string | null;
	sampleRateHz: number;
	channels: number;
};

export type TtsAudioFile = {
	requestId: string;
	outputPath: string;
	sampleRateHz: number;
	durationSeconds: number;
};

export class TtsWorkerClient {
	#workerUrl: string;
	#referenceAudioPath: string | null;
	#referenceText: string | null;
	#referenceTextPath: string | null;

	constructor(options: TtsWorkerClientOptions) {
		this.#workerUrl = options.workerUrl.replace(/\/+$/, "");
		this.#referenceAudioPath = options.referenceAudioPath ?? null;
		this.#referenceText = options.referenceText ?? null;
		this.#referenceTextPath = options.referenceTextPath ?? null;
	}

	async ensureHealthy(): Promise<void> {
		const response = await fetch(`${this.#workerUrl}/health`);
		if (!response.ok) {
			throw new Error(`TTS worker health check failed with ${response.status}`);
		}
	}

	async synthesizeStream(text: string): Promise<TtsAudioStream> {
		const response = await fetch(`${this.#workerUrl}/v1/synthesize/stream`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				text,
				voice: "default",
				reference_audio_path: this.#referenceAudioPath,
				reference_text: this.#referenceText,
				reference_text_path: this.#referenceTextPath,
			}),
		});
		if (!response.ok) {
			throw new Error(
				`TTS stream synthesis failed with ${response.status}: ${await response.text()}`,
			);
		}
		if (!response.body) {
			throw new Error("TTS worker did not return streaming audio");
		}
		return {
			body: response.body,
			requestId: response.headers.get("x-request-id"),
			sampleRateHz: Number(response.headers.get("x-sample-rate-hz") ?? "24000"),
			channels: Number(response.headers.get("x-channels") ?? "1"),
		};
	}

	async synthesizeFile(text: string, outputPath: string): Promise<TtsAudioFile> {
		const response = await fetch(`${this.#workerUrl}/v1/synthesize`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				text,
				voice: "default",
				output_path: outputPath,
				reference_audio_path: this.#referenceAudioPath,
				reference_text: this.#referenceText,
				reference_text_path: this.#referenceTextPath,
			}),
		});
		if (!response.ok) {
			throw new Error(
				`TTS file synthesis failed with ${response.status}: ${await response.text()}`,
			);
		}
		const body = await response.json() as Record<string, unknown>;
		return {
			requestId: stringValue(body.request_id) ?? "",
			outputPath: requiredString(body.output_path, "output_path"),
			sampleRateHz: numberValue(body.sample_rate_hz) ?? 24000,
			durationSeconds: numberValue(body.duration_seconds) ?? 0,
		};
	}
}

function requiredString(value: unknown, label: string): string {
	const parsed = stringValue(value);
	if (!parsed) {
		throw new Error(`TTS worker response is missing ${label}`);
	}
	return parsed;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
