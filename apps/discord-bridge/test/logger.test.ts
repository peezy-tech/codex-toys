import { describe, expect, test } from "vite-plus/test";

import { createDiscordBridgeLogger } from "../src/logger.ts";
import { formatPrettyLogLine } from "../src/pretty-log.ts";

describe("discord bridge logger", () => {
	test("writes info logs as structured json and gates debug logs", () => {
		const output = createMemoryOutput();
		const logger = createDiscordBridgeLogger({
			component: "test-bridge",
			now: () => new Date("2026-05-12T04:22:00.123Z"),
			stream: output.stream,
		});

		logger.debug("hidden.debug", { threadId: "thread-1" });
		logger.info("bridge.started", {
			appServerUrl: "local",
			statePath: "/tmp/discord-state.json",
		});

		const lines = output.text.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toEqual({
			time: "2026-05-12T04:22:00.123Z",
			component: "test-bridge",
			level: "info",
			event: "bridge.started",
			appServerUrl: "local",
			statePath: "/tmp/discord-state.json",
		});
	});

	test("filters logs below the configured log level", () => {
		const output = createMemoryOutput();
		const logger = createDiscordBridgeLogger({
			component: "test-bridge",
			logLevel: "warn",
			now: () => new Date("2026-05-12T04:22:00.123Z"),
			stream: output.stream,
		});

		logger.debug("hidden.debug");
		logger.info("hidden.info");
		logger.warn("visible.warn");
		logger.error("visible.error");

		expect(output.text.trim().split("\n").map((line) => JSON.parse(line).event))
			.toEqual(["visible.warn", "visible.error"]);
	});

	test("pretty prints structured json logs and plain process output", () => {
		const structured = formatPrettyLogLine(
			JSON.stringify({
				time: "2026-05-12T04:22:00.123Z",
				component: "codex-discord-bridge",
				level: "info",
				event: "bridge.started",
				appServerUrl: "local",
				localAppServer: true,
			}),
			{ color: false },
		);
		const plain = formatPrettyLogLine("listening on ws://127.0.0.1:3585", {
			color: false,
			name: "codex-remote-control",
			now: () => new Date("2026-05-12T04:22:01.456Z"),
		});

		expect(structured).toBe(
			"[04:22:00.123] INFO  codex-discord-bridge bridge.started appServerUrl=local localAppServer=true",
		);
		expect(plain).toBe(
			"[04:22:01.456] INFO  codex-remote-control listening on ws://127.0.0.1:3585",
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
