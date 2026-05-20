import { describe, expect, test } from "vite-plus/test";

import { SpeechQueue } from "../src/speech-queue.ts";
import type { Logger, Speaker } from "../src/types.ts";

const silentLogger: Logger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
};

describe("SpeechQueue", () => {
	test("dedupes announcements by id", async () => {
		const spoken: string[] = [];
		const speaker: Speaker = {
			async speak(text) {
				spoken.push(text);
			},
		};
		const queue = new SpeechQueue({
			speaker,
			logger: silentLogger,
			maxQueuedAnnouncements: 10,
		});
		expect(queue.enqueue({
			id: "same",
			text: "hello",
			priority: "normal",
			source: "test",
		})).toBe(true);
		expect(queue.enqueue({
			id: "same",
			text: "hello again",
			priority: "normal",
			source: "test",
		})).toBe(false);
		await waitFor(() => spoken.length === 1);
		expect(spoken).toEqual(["hello"]);
		await queue.close();
	});

	test("prioritizes high priority queued items after current playback", async () => {
		const spoken: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const speaker: Speaker = {
			async speak(text) {
				spoken.push(text);
				if (text === "first") {
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
				}
			},
		};
		const queue = new SpeechQueue({
			speaker,
			logger: silentLogger,
			maxQueuedAnnouncements: 10,
		});
		queue.enqueue({ id: "1", text: "first", priority: "normal", source: "test" });
		queue.enqueue({ id: "2", text: "second", priority: "normal", source: "test" });
		queue.enqueue({ id: "3", text: "urgent", priority: "high", source: "test" });
		await waitFor(() => spoken.length === 1);
		releaseFirst?.();
		await waitFor(() => spoken.length === 3);
		expect(spoken).toEqual(["first", "urgent", "second"]);
		await queue.close();
	});
});

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let index = 0; index < 50; index += 1) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for predicate");
}
