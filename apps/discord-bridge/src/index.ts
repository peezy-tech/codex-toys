#!/usr/bin/env bun
import {
	CodexAppServerClient,
	CodexStdioTransport,
} from "@peezy.tech/codex-flows";

import { DiscordCodexBridge } from "./bridge.ts";
import { createDiscordConsoleOutput } from "./console-output.ts";
import { parseConfig } from "./config.ts";
import { DiscordJsBridgeTransport } from "./discord-transport.ts";
import { createDiscordBridgeLogger } from "./logger.ts";
import { JsonFileStateStore } from "./state.ts";

async function main(): Promise<void> {
	let logger = createDiscordBridgeLogger();
	try {
		const parsed = parseConfig(Bun.argv.slice(2), process.env);
		if (parsed.type === "help") {
			process.stdout.write(parsed.text);
			return;
		}
		logger = createDiscordBridgeLogger({
			debug: parsed.config.debug,
			logLevel: parsed.config.logLevel,
		});
		const consoleOutput = parsed.config.consoleOutput === "messages"
			? createDiscordConsoleOutput()
			: undefined;
		const client = new CodexAppServerClient({
			transport: parsed.localAppServer
				? new CodexStdioTransport({
						args: localAppServerArgs(),
						requestTimeoutMs: 90_000,
					})
				: undefined,
			webSocketTransportOptions: parsed.appServerUrl
				? { url: parsed.appServerUrl, requestTimeoutMs: 90_000 }
				: undefined,
			clientName: "codex-discord-bridge",
			clientTitle: "Codex Discord Bridge",
			clientVersion: "0.1.0",
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport: new DiscordJsBridgeTransport({
				token: parsed.discordToken,
				logger,
			}),
			store: new JsonFileStateStore(parsed.config.statePath),
			config: parsed.config,
			logger,
			consoleOutput,
		});
		await bridge.start();
		logger.info("bridge.started", {
			appServerUrl: parsed.appServerUrl ?? "local",
			localAppServer: Boolean(parsed.localAppServer),
			progressMode: parsed.config.progressMode ?? "summary",
			statePath: parsed.config.statePath,
		});
		await waitForShutdown(bridge);
	} catch (error) {
		logger.error("bridge.fatal", { error: errorMessage(error) });
		process.exitCode = 1;
	}
}

function localAppServerArgs(): string[] {
	return [
		"app-server",
		"--listen",
		"stdio://",
		"--enable",
		"apps",
		"--enable",
		"hooks",
	];
}

function waitForShutdown(bridge: DiscordCodexBridge): Promise<void> {
	return new Promise((resolve) => {
		const shutdown = () => {
			process.off("SIGINT", shutdown);
			process.off("SIGTERM", shutdown);
			void bridge.stop().finally(resolve);
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

await main();
