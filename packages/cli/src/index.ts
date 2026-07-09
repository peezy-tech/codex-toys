#!/usr/bin/env node
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
	CodexAppServerClient,
	COMMON_APP_SERVER_METHODS,
	CodexAuthClient,
	parseJsonParamsText,
	readJsonFile,
	validateAppServerMethodName,
	type v2,
} from "@codex-appkit/app-server";
import { createCodexAppkitHttpHandler } from "@codex-appkit/http";

type ParsedCli =
	| { type: "help" }
	| { type: "app-actions" }
	| ClientOptions & JsonOptions & {
			type: "app-call";
			method: string;
			paramsText?: string;
			paramsFile?: string;
	  }
	| ClientOptions & JsonOptions & { type: "auth-status" }
	| ClientOptions & JsonOptions & {
			type: "thread-list";
			limit: number;
	  }
	| ClientOptions & JsonOptions & {
			type: "thread-read";
			threadId: string;
			includeTurns: boolean;
	  }
	| ClientOptions & JsonOptions & {
			type: "thread-start";
			cwd?: string;
			model?: string;
	  }
	| ClientOptions & JsonOptions & {
			type: "turn-run";
			prompt: string;
			threadId?: string;
			cwd?: string;
			wait: boolean;
			timeoutMs: number;
	  }
	| ClientOptions & {
			type: "http-serve";
			host: string;
			port: number;
			staticDir?: string;
	  };

type ClientOptions = {
	cwd?: string;
	codexCommand?: string;
	codexArgs?: string[];
	requestTimeoutMs: number;
};

type JsonOptions = {
	pretty: boolean;
};

await main().catch((error) => {
	process.stderr.write(`${errorMessage(error)}\n`);
	process.exitCode = 1;
});

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2), process.env);
	if (parsed.type === "help") {
		write(helpText());
		return;
	}
	if (parsed.type === "app-actions") {
		write(`${COMMON_APP_SERVER_METHODS.join("\n")}\n`);
		return;
	}
	if (parsed.type === "http-serve") {
		await serveHttp(parsed);
		return;
	}

	const client = createClient(parsed);
	try {
		await client.connect();
		if (parsed.type === "app-call") {
			const params = await paramsFromCli(parsed);
			writeJson(await client.request(parsed.method, params), parsed.pretty);
			return;
		}
		if (parsed.type === "auth-status") {
			const auth = new CodexAuthClient(client);
			writeJson(await auth.getState(), parsed.pretty);
			return;
		}
		if (parsed.type === "thread-list") {
			writeJson(await client.listThreads({
				limit: parsed.limit,
				sourceKinds: [],
			}), parsed.pretty);
			return;
		}
		if (parsed.type === "thread-read") {
			writeJson(await client.readThread({
				threadId: parsed.threadId,
				includeTurns: parsed.includeTurns,
			}), parsed.pretty);
			return;
		}
		if (parsed.type === "thread-start") {
			writeJson(await client.startThread(compactUndefined({
				cwd: parsed.cwd,
				model: parsed.model,
				experimentalRawEvents: false,
			} satisfies Partial<v2.ThreadStartParams>) as v2.ThreadStartParams), parsed.pretty);
			return;
		}
		if (parsed.type === "turn-run") {
			writeJson(await runTurn(client, parsed), parsed.pretty);
			return;
		}
	} finally {
		client.close();
	}
}

function createClient(options: ClientOptions): CodexAppServerClient {
	return new CodexAppServerClient({
		transportOptions: {
			cwd: options.cwd,
			codexCommand: options.codexCommand,
			args: options.codexArgs,
			requestTimeoutMs: options.requestTimeoutMs,
		},
		clientName: "codex-appkit-cli",
		clientTitle: "Codex AppKit CLI",
		clientVersion: "0.1.0",
	});
}

async function runTurn(
	client: CodexAppServerClient,
	options: Extract<ParsedCli, { type: "turn-run" }>,
): Promise<unknown> {
	let threadId = options.threadId;
	let thread: unknown = null;
	if (!threadId) {
		const response = await client.startThread({
			cwd: options.cwd,
			experimentalRawEvents: false,
		});
		thread = response.thread;
		threadId = response.thread.id;
	}
	const turnResponse = await client.startTurn({
		threadId,
		cwd: options.cwd,
		input: [
			{
				type: "text",
				text: options.prompt,
				text_elements: [],
			},
		],
	});
	const turn = turnResponse.turn;
	if (!options.wait) {
		return { threadId, thread, turn };
	}
	const waited = await waitForTurn(client, {
		threadId,
		turnId: turn.id,
		timeoutMs: options.timeoutMs,
	});
	return { threadId, thread, turn, waited };
}

async function waitForTurn(
	client: CodexAppServerClient,
	options: { threadId: string; turnId: string; timeoutMs: number },
): Promise<{ status: string; finalMessage: string | null; error: string | null }> {
	const deadline = Date.now() + options.timeoutMs;
	while (Date.now() <= deadline) {
		const response = await client.readThread({
			threadId: options.threadId,
			includeTurns: true,
		});
		const thread = record(response.thread);
		const turns = Array.isArray(thread.turns) ? thread.turns : [];
		const turn = turns.map(record).find((entry) => entry.id === options.turnId);
		const status = typeof turn?.status === "string" ? turn.status : null;
		if (status && ["completed", "failed", "cancelled", "canceled"].includes(status)) {
			return {
				status,
				finalMessage: finalMessage(thread),
				error: stringValue(turn?.error) ?? null,
			};
		}
		await delay(1_000);
	}
	return { status: "timed_out", finalMessage: null, error: null };
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ParsedCli {
	const options: ClientOptions & JsonOptions = {
		cwd: undefined,
		codexCommand: undefined,
		codexArgs: [],
		requestTimeoutMs: numberValue(env.CODEX_APPKIT_TIMEOUT_MS, 90_000),
		pretty: true,
	};
	const positional: string[] = [];
	let paramsText: string | undefined;
	let paramsFile: string | undefined;
	let host = "127.0.0.1";
	let port = 3587;
	let staticDir: string | undefined;
	let limit = 20;
	let includeTurns = false;
	let wait = false;
	let model: string | undefined;

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		switch (arg) {
			case "-h":
			case "--help":
				return { type: "help" };
			case "--cwd":
				options.cwd = requiredArg(argv, ++index, arg);
				break;
			case "--codex-command":
				options.codexCommand = requiredArg(argv, ++index, arg);
				break;
			case "--codex-arg":
				options.codexArgs?.push(requiredArg(argv, ++index, arg));
				break;
			case "--params-json":
				paramsText = requiredArg(argv, ++index, arg);
				break;
			case "--params-file":
				paramsFile = requiredArg(argv, ++index, arg);
				break;
			case "--compact":
				options.pretty = false;
				break;
			case "--pretty":
				options.pretty = true;
				break;
			case "--timeout-ms":
				options.requestTimeoutMs = numberValue(requiredArg(argv, ++index, arg), options.requestTimeoutMs);
				break;
			case "--host":
				host = requiredArg(argv, ++index, arg);
				break;
			case "--port":
				port = numberValue(requiredArg(argv, ++index, arg), port);
				break;
			case "--static":
				staticDir = requiredArg(argv, ++index, arg);
				break;
			case "--limit":
				limit = numberValue(requiredArg(argv, ++index, arg), limit);
				break;
			case "--include-turns":
				includeTurns = true;
				break;
			case "--wait":
				wait = true;
				break;
			case "--model":
				model = requiredArg(argv, ++index, arg);
				break;
			default:
				positional.push(arg);
		}
	}

	const [command, subcommand, ...rest] = positional;
	if (!command) {
		return { type: "help" };
	}
	if (command === "app" && subcommand === "actions") {
		return { type: "app-actions" };
	}
	if (command === "app") {
		const method = validateAppServerMethodName(
			subcommand === "call" ? requiredValue(rest.shift(), "app method") : requiredValue(subcommand, "app method"),
			"app method",
		);
		return {
			...options,
			type: "app-call",
			method,
			paramsText: paramsText ?? rest[0],
			paramsFile,
		};
	}
	if (command === "auth" && subcommand === "status") {
		return { ...options, type: "auth-status" };
	}
	if (command === "thread" && subcommand === "list") {
		return { ...options, type: "thread-list", limit };
	}
	if (command === "thread" && subcommand === "read") {
		return {
			...options,
			type: "thread-read",
			threadId: requiredValue(rest[0], "thread id"),
			includeTurns,
		};
	}
	if (command === "thread" && subcommand === "start") {
		return { ...options, type: "thread-start", model };
	}
	if (command === "turn" && subcommand === "run") {
		const threadFlagIndex = rest.indexOf("--thread-id");
		let threadId: string | undefined;
		if (threadFlagIndex >= 0) {
			threadId = requiredValue(rest[threadFlagIndex + 1], "--thread-id");
			rest.splice(threadFlagIndex, 2);
		}
		return {
			...options,
			type: "turn-run",
			prompt: requiredValue(rest.join(" ").trim(), "prompt"),
			threadId,
			wait,
			timeoutMs: options.requestTimeoutMs,
		};
	}
	if (command === "http" && subcommand === "serve") {
		return { ...options, type: "http-serve", host, port, staticDir };
	}
	throw new Error(`Unknown command: ${positional.join(" ")}`);
}

async function paramsFromCli(
	options: Extract<ParsedCli, { type: "app-call" }>,
): Promise<unknown> {
	if (options.paramsFile) {
		return await readJsonFile(options.paramsFile);
	}
	if (options.paramsText) {
		return parseJsonParamsText(options.paramsText);
	}
	if (!process.stdin.isTTY) {
		const stdin = await readStdin();
		return stdin.trim() ? parseJsonParamsText(stdin) : {};
	}
	return {};
}

async function serveHttp(options: Extract<ParsedCli, { type: "http-serve" }>): Promise<void> {
	const handler = createCodexAppkitHttpHandler({
		staticDir: options.staticDir,
		transportOptions: {
			cwd: options.cwd,
			codexCommand: options.codexCommand,
			args: options.codexArgs,
			requestTimeoutMs: options.requestTimeoutMs,
		},
	});
	const server = http.createServer((request, response) => {
		void handler(request, response);
	});
	await new Promise<void>((resolve) => {
		server.listen(options.port, options.host, resolve);
	});
	write(`Codex AppKit HTTP listening on http://${options.host}:${options.port}\n`);
}

function helpText(): string {
	return `codex-appkit builds on the native Codex app-server.

Usage:
  codex-appkit app actions
  codex-appkit app <method> [params-json]
  codex-appkit app <method> --params-json <json>
  codex-appkit app <method> --params-file <file>
  codex-appkit auth status
  codex-appkit thread list [--limit <n>]
  codex-appkit thread read <thread-id> [--include-turns]
  codex-appkit thread start [--cwd <path>]
  codex-appkit turn run <prompt> [--wait] [--thread-id <id>] [--cwd <path>]
  codex-appkit http serve [--cwd <path>] [--static <dir>] [--host <host>] [--port <port>]

Options:
  --cwd <path>
  --codex-command <command>
  --codex-arg <arg>
  --timeout-ms <ms>
  --pretty
  --compact
`;
}

function finalMessage(thread: Record<string, unknown>): string | null {
	const items = Array.isArray(thread.items) ? thread.items : [];
	for (const item of [...items].reverse()) {
		const input = record(item);
		if (input.type === "message" && input.role === "assistant") {
			const content = Array.isArray(input.content) ? input.content : [];
			const text = content
				.map(record)
				.map((entry) => stringValue(entry.text))
				.filter(Boolean)
				.join("\n")
				.trim();
			if (text) {
				return text;
			}
		}
	}
	return null;
}

function compactUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(value).filter((entry) => entry[1] !== undefined),
	) as Partial<T>;
}

async function readStdin(): Promise<string> {
	let input = "";
	for await (const chunk of process.stdin) {
		input += String(chunk);
	}
	return input;
}

function writeJson(value: unknown, pretty: boolean): void {
	write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function write(text: string): void {
	process.stdout.write(text);
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

function numberValue(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
