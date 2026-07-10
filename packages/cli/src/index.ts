#!/usr/bin/env node
import http from "node:http";
import {
	AgentHarness,
	type HarnessEvent,
	type HarnessProvider,
} from "@codex-appkit/harness";
import { createAgentHarnessHttpHandler } from "@codex-appkit/http";

type ParsedCli =
	| { type: "help" }
	| { type: "run"; provider: HarnessProvider; prompt: string; cwd?: string; model?: string }
	| {
			type: "plugin-install";
			provider: HarnessProvider;
			plugin: string;
			cwd?: string;
			scope?: "user" | "project" | "local";
			marketplacePath?: string;
			remoteMarketplaceName?: string;
	  }
	| { type: "http-serve"; cwd?: string; staticDir?: string; host: string; port: number };

await main().catch((error) => {
	process.stderr.write(`${errorMessage(error)}\n`);
	process.exitCode = 1;
});

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const parsed = parseArgs(argv);
	if (parsed.type === "help") {
		write(helpText());
		return;
	}
	if (parsed.type === "run") {
		await run(parsed);
		return;
	}
	if (parsed.type === "plugin-install") {
		const harness = new AgentHarness();
		const result = parsed.provider === "claude"
			? await harness.installPlugin({
				provider: "claude",
				plugin: parsed.plugin,
				...(parsed.cwd ? { cwd: parsed.cwd } : {}),
				...(parsed.scope ? { scope: parsed.scope } : {}),
			})
			: await harness.installPlugin({
				provider: "codex",
				plugin: parsed.plugin,
				...(parsed.marketplacePath ? { marketplacePath: parsed.marketplacePath } : {}),
				...(parsed.remoteMarketplaceName ? { remoteMarketplaceName: parsed.remoteMarketplaceName } : {}),
			});
		writeJson(result);
		return;
	}
	await serveHttp(parsed);
}

async function run(options: Extract<ParsedCli, { type: "run" }>): Promise<void> {
	const harness = new AgentHarness();
	const bufferedEvents: HarnessEvent[] = [];
	let started = false;
	const outputEvent = (event: HarnessEvent) => {
		if (!started) {
			bufferedEvents.push(event);
			return;
		}
		writeJson({ type: "event", ...event });
	};
	const active = await harness.run({
		provider: options.provider,
		prompt: options.prompt,
		...(options.cwd ? { cwd: options.cwd } : {}),
		...(options.model ? { model: options.model } : {}),
		onEvent: outputEvent,
	});
	writeJson({
		type: "run.started",
		provider: active.provider,
		sessionId: active.sessionId,
		runId: active.runId,
	});
	started = true;
	for (const event of bufferedEvents) {
		outputEvent(event);
	}

	let stopping = false;
	const stop = () => {
		if (stopping) {
			return;
		}
		stopping = true;
		void active.interrupt().finally(() => active.close());
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}

function parseArgs(argv: string[]): ParsedCli {
	const positional: string[] = [];
	let provider: HarnessProvider | undefined;
	let cwd: string | undefined;
	let model: string | undefined;
	let scope: "user" | "project" | "local" | undefined;
	let marketplacePath: string | undefined;
	let remoteMarketplaceName: string | undefined;
	let host = "127.0.0.1";
	let port = 3587;
	let staticDir: string | undefined;

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		switch (arg) {
			case "-h":
			case "--help": return { type: "help" };
			case "--provider": provider = providerFrom(requiredArg(argv, ++index, arg)); break;
			case "--cwd": cwd = requiredArg(argv, ++index, arg); break;
			case "--model": model = requiredArg(argv, ++index, arg); break;
			case "--scope": scope = scopeFrom(requiredArg(argv, ++index, arg)); break;
			case "--marketplace-path": marketplacePath = requiredArg(argv, ++index, arg); break;
			case "--marketplace": remoteMarketplaceName = requiredArg(argv, ++index, arg); break;
			case "--host": host = requiredArg(argv, ++index, arg); break;
			case "--port": port = positiveNumber(requiredArg(argv, ++index, arg), arg); break;
			case "--static": staticDir = requiredArg(argv, ++index, arg); break;
			default: positional.push(arg);
		}
	}

	const [command, subcommand, ...rest] = positional;
	if (!command) {
		return { type: "help" };
	}
	if (command === "run") {
		return {
			type: "run",
			provider: requiredProvider(provider),
			prompt: requiredValue([subcommand, ...rest].filter(Boolean).join(" ").trim(), "prompt"),
			...(cwd ? { cwd } : {}),
			...(model ? { model } : {}),
		};
	}
	if (command === "plugin" && subcommand === "install") {
		return {
			type: "plugin-install",
			provider: requiredProvider(provider),
			plugin: requiredValue(rest[0], "plugin"),
			...(cwd ? { cwd } : {}),
			...(scope ? { scope } : {}),
			...(marketplacePath ? { marketplacePath } : {}),
			...(remoteMarketplaceName ? { remoteMarketplaceName } : {}),
		};
	}
	if (command === "http" && subcommand === "serve") {
		if (!isLoopbackHost(host)) {
			throw new Error("HTTP serving is limited to a loopback host");
		}
		return {
			type: "http-serve",
			host,
			port,
			...(cwd ? { cwd } : {}),
			...(staticDir ? { staticDir } : {}),
		};
	}
	throw new Error(`Unknown command: ${positional.join(" ")}`);
}

async function serveHttp(options: Extract<ParsedCli, { type: "http-serve" }>): Promise<void> {
	const handler = createAgentHarnessHttpHandler({
		...(options.cwd ? { cwd: options.cwd } : {}),
		...(options.staticDir ? { staticDir: options.staticDir } : {}),
	});
	const server = http.createServer((request, response) => {
		void handler(request, response);
	});
	await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
	write(`Agent Harness HTTP listening on http://${options.host}:${options.port}\n`);
}

function helpText(): string {
	return `Agent Harness runs locally configured Codex or Claude Code with no interactive approvals.

Use only inside an external sandbox or equivalent containment.

Usage:
  agent-harness run <prompt> --provider codex|claude [--cwd <path>] [--model <name>]
  agent-harness plugin install <plugin> --provider codex|claude [--cwd <path>] [--scope user|project|local]
  agent-harness http serve [--cwd <path>] [--static <dir>] [--host 127.0.0.1] [--port 3587]

Codex plugin options:
  --marketplace <name>
  --marketplace-path <path>
`;
}

function providerFrom(value: string): HarnessProvider {
	if (value === "codex" || value === "claude") {
		return value;
	}
	throw new Error("--provider must be codex or claude");
}

function scopeFrom(value: string): "user" | "project" | "local" {
	if (value === "user" || value === "project" || value === "local") {
		return value;
	}
	throw new Error("--scope must be user, project, or local");
}

function requiredProvider(value: HarnessProvider | undefined): HarnessProvider {
	if (!value) {
		throw new Error("--provider is required");
	}
	return value;
}

function requiredArg(argv: string[], index: number, flag: string): string {
	return requiredValue(argv[index], flag);
}

function requiredValue(value: string | undefined, label: string): string {
	if (!value) {
		throw new Error(`${label} is required`);
	}
	return value;
}

function positiveNumber(value: string, label: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
		throw new Error(`${label} must be a valid TCP port`);
	}
	return parsed;
}

function isLoopbackHost(value: string): boolean {
	return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

function write(value: string): void {
	process.stdout.write(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
