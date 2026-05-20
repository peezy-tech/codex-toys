#!/usr/bin/env node
import type { DiscordCodexBridge } from "./bridge.ts";
import { handleHookCommand } from "./hook-cli.ts";
import { parseConfig } from "./config.ts";
import { createDiscordBridgeLogger } from "./logger.ts";

async function main(): Promise<void> {
	let logger = createDiscordBridgeLogger();
	try {
		const argv = process.argv.slice(2);
		if (await handleHookCommand(argv)) {
			return;
		}
		const parsed = parseConfig(argv, process.env);
		if (parsed.type === "help") {
			process.stdout.write(parsed.text);
			return;
		}
		logger = createDiscordBridgeLogger({
			debug: parsed.config.debug,
			logLevel: parsed.config.logLevel,
		});
		const { CodexAppServerClient, CodexStdioTransport } = await import(
			"@peezy.tech/codex-flows"
		);
		const { DiscordCodexBridge } = await import("./bridge.ts");
		const { createDiscordConsoleOutput } = await import("./console-output.ts");
		const { DiscordJsBridgeTransport } = await import("./discord-transport.ts");
		const { JsonFileStateStore } = await import("./state.ts");
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
