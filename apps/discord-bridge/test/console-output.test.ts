import { describe, expect, test } from "vite-plus/test";

import {
	createDiscordConsoleOutput,
	formatConsoleMessage,
} from "../src/console-output.ts";

describe("discord bridge console output", () => {
	test("formats delivered assistant messages for terminal output", () => {
		expect(
			formatConsoleMessage(
				{
					kind: "final",
					text: "Repo scan complete.\nNo regressions found.",
					discordThreadId: "discord-thread-123456",
					codexThreadId: "codex-thread-abcdef",
					turnId: "turn-1234567890",
					title: "Scan repo",
					at: new Date("2026-05-12T04:22:00.123Z"),
				},
				{ color: false },
			),
		).toBe(
			[
				"[04:22:00.123] FINAL      Scan repo thread=codex-...cdef turn=turn-1...7890",
				"  Repo scan complete.",
				"  No regressions found.",
			].join("\n"),
		);
	});

	test("writes one formatted block per message", () => {
		const output = createMemoryOutput();
		const consoleOutput = createDiscordConsoleOutput({
			color: false,
			now: () => new Date("2026-05-12T04:22:01.456Z"),
			stream: output.stream,
		});

		consoleOutput.message({
			kind: "commentary",
			text: "I will inspect the bridge.",
			discordThreadId: "discord-thread-1",
			codexThreadId: "codex-thread-1",
			turnId: "turn-1",
			title: "Bridge status",
		});

		expect(output.text).toBe(
			[
				"[04:22:01.456] COMMENTARY Bridge status thread=codex-...ad-1 turn=turn-1",
				"  I will inspect the bridge.",
				"",
			].join("\n"),
		);
	});
});

function createMemoryOutput(): {
	readonly stream: Pick<NodeJS.WriteStream, "write">;
	readonly text: string;
} {
	const chunks: string[] = [];
	return {
		stream: {
			write: ((chunk: string | Uint8Array) => {
				chunks.push(
					typeof chunk === "string"
						? chunk
						: Buffer.from(chunk).toString("utf8"),
				);
				return true;
			}) as NodeJS.WriteStream["write"],
		},
		get text() {
			return chunks.join("");
		},
	};
}
