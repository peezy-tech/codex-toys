#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAppServerClient } from "../packages/codex-client/src/index.ts";

type Args = {
	candidate: string;
	cwd?: string;
	codexCommand?: string;
	codexHome?: string;
	cliPath: string;
	timeoutMs: number;
	ephemeral: boolean;
	stream: boolean;
	injectContext: boolean;
	injectResult: boolean;
	notes: string[];
	threadName?: string | null;
	mode: ReplayMode;
};

type ReplayMode = "native" | "shim";

type CandidateMetadata = Record<string, unknown>;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultCliPath = path.join(repoRoot, "apps/cli/src/index.ts");

async function main() {
	const args = await parseArgs(process.argv.slice(2));
	const candidate = path.resolve(args.candidate);
	const metadata = await readCandidateMetadata(candidate);
	const cwd = path.resolve(args.cwd ?? metadataCwd(metadata) ?? process.cwd());
	const source = await readFile(candidate, "utf8");
	const cliPath = path.resolve(args.cliPath);
	const threadName =
		args.threadName === undefined ? defaultThreadName(candidate) : args.threadName;
	const command =
		args.mode === "shim"
			? replayCommand({
					candidate,
					cliPath,
					codexCommand: args.codexCommand,
					cwd,
					timeoutMs: args.timeoutMs,
				})
			: undefined;
	const client = new CodexAppServerClient({
		transportOptions: {
			codexCommand: args.codexCommand,
			args: appServerArgs(),
			env: args.codexHome ? { CODEX_HOME: path.resolve(args.codexHome) } : undefined,
			requestTimeoutMs: args.timeoutMs,
		},
		clientName: "code-mode-replay-thread",
		clientTitle: "Code Mode Replay Thread",
		clientVersion: "0.1.0",
	});
	const output: string[] = [];
	let completedItem: unknown;
	let commandExitCode: number | null = null;
	let resolveTurnCompleted: (value: unknown) => void = () => undefined;
	const turnCompleted = new Promise((resolve) => {
		resolveTurnCompleted = resolve;
	});

	client.on("request", (message) => {
		client.respondError(message.id, -32603, "replay script does not handle server requests");
	});
	client.on("notification", (message) => {
		if (message.method === "item/commandExecution/outputDelta") {
			const delta = stringField(message.params, "delta");
			if (delta) {
				output.push(delta);
				if (args.stream) {
					process.stdout.write(delta);
				}
			}
		}
		if (message.method === "item/agentMessage/delta") {
			const delta = stringField(message.params, "delta");
			if (delta) {
				output.push(delta);
				if (args.stream) {
					process.stdout.write(delta);
				}
			}
		}
		if (message.method === "item/completed") {
			const item = recordField(message.params, "item");
			if (item && stringField(item, "type") === "commandExecution") {
				completedItem = item;
				commandExitCode = numberField(item, "exitCode") ?? numberField(item, "exit_code");
			}
			if (item && stringField(item, "type") === "agentMessage") {
				completedItem = item;
			}
		}
		if (message.method === "turn/completed") {
			resolveTurnCompleted(message.params);
		}
	});

	try {
		await client.connect();
		const started = await client.startThread({
			cwd,
			approvalPolicy: "never",
			sandbox: "danger-full-access",
			ephemeral: args.ephemeral,
			experimentalRawEvents: false,
			persistExtendedHistory: false,
		});
		const threadId = started.thread.id;
		if (threadName) {
			await client.request("thread/name/set", {
				threadId,
				name: threadName,
			});
		}
		let injectedContext = false;
		if (args.injectContext || args.notes.length > 0) {
			await injectAssistantText(
				client,
				threadId,
				replayContextText({
					candidate,
					codexHome: args.codexHome ? path.resolve(args.codexHome) : undefined,
					cwd,
					metadata,
					mode: args.mode,
					notes: args.notes,
					source,
				}),
			);
			injectedContext = true;
		}

		if (args.mode === "shim") {
			await client.request("thread/shellCommand", {
				threadId,
				command,
			});
		} else {
			await client.request("thread/codeMode/execute", {
				threadId,
				source,
			});
		}

		const completed = await withTimeout(
			turnCompleted,
			args.timeoutMs,
			"timed out waiting for Code Mode replay completion",
		);
		let replayOutput = output.join("");
		if (args.mode === "native") {
			const read = await client.request("thread/read", {
				threadId,
				includeTurns: true,
			});
			replayOutput = latestAgentMessageText(read) ?? replayOutput;
			if (args.stream && replayOutput && output.length === 0) {
				process.stdout.write(replayOutput.endsWith("\n") ? replayOutput : replayOutput + "\n");
			}
		}
		let injectedResult = false;
		if (args.injectResult) {
			await injectAssistantText(
				client,
				threadId,
				replayResultText({
					candidate,
					command,
					commandExitCode,
					cwd,
					mode: args.mode,
					output: replayOutput,
				}),
			);
			injectedResult = true;
		}
		const result = {
			threadId,
			cwd,
			candidate,
			mode: args.mode,
			command,
			commandExitCode: args.mode === "shim" ? commandExitCode : null,
			output: replayOutput,
			injectedContext,
			injectedResult,
			threadName,
			codexHome: args.codexHome ? path.resolve(args.codexHome) : undefined,
			notes: args.notes,
			completed,
			completedItem,
		};
		process.stdout.write(JSON.stringify(result, null, 2) + "\n");
		process.stdout.write("threadId=" + threadId + "\n");
		process.exitCode = args.mode === "shim" ? commandExitCode ?? 0 : 0;
	} finally {
		client.close();
	}
}

function replayCommand(options: {
	candidate: string;
	cliPath: string;
	codexCommand?: string;
	cwd: string;
	timeoutMs: number;
}) {
	const command = [
		"tsx",
		shellQuote(options.cliPath),
		"--url",
		"stdio://",
		"--timeout-ms",
		String(options.timeoutMs),
		"run-code-mode",
		shellQuote(options.candidate),
		"--cwd",
		shellQuote(options.cwd),
	];
	if (options.codexCommand) {
		command.splice(4, 0, "--codex-command", shellQuote(options.codexCommand));
	}
	return command.join(" ");
}

function appServerArgs() {
	return [
		"app-server",
		"--listen",
		"stdio://",
		"--enable",
		"apps",
		"--enable",
		"hooks",
		"--enable",
		"code_mode",
		"--enable",
		"code_mode_only",
	];
}

function defaultThreadName(candidate: string) {
	return "Code Mode replay: " + path.basename(candidate);
}

async function readCandidateMetadata(candidate: string): Promise<CandidateMetadata | undefined> {
	const metadataPath = candidate.replace(/\.[^.]+$/, ".json");
	try {
		const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function metadataCwd(metadata: CandidateMetadata | undefined) {
	const cwd = metadata?.cwd;
	return typeof cwd === "string" && cwd ? cwd : undefined;
}

function latestAgentMessageText(value: unknown) {
	const thread = recordField(value, "thread");
	const turns = Array.isArray(thread?.turns) ? thread.turns : [];
	for (const turn of turns.slice().reverse()) {
		const turnRecord = isRecord(turn) ? turn : undefined;
		const items = Array.isArray(turnRecord?.items) ? turnRecord.items : [];
		for (const item of items.slice().reverse()) {
			if (!isRecord(item) || stringField(item, "type") !== "agentMessage") {
				continue;
			}
			const text = stringField(item, "text");
			if (text !== undefined) {
				return text;
			}
		}
	}
	return undefined;
}

async function injectAssistantText(
	client: CodexAppServerClient,
	threadId: string,
	text: string,
) {
	await client.request("thread/inject_items", {
		threadId,
		items: [
			{
				type: "message",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text,
					},
				],
			},
		],
	});
}

function replayContextText(options: {
	candidate: string;
	codexHome?: string;
	cwd: string;
	metadata: CandidateMetadata | undefined;
	mode: ReplayMode;
	notes: string[];
	source: string;
}) {
	const parts = [
		"Code Mode replay context",
		"",
		"Candidate: " + options.candidate,
		"Working directory: " + options.cwd,
		"Replay mode: " + options.mode,
	];
	if (options.codexHome) {
		parts.push("Codex home: " + options.codexHome);
	}
	if (options.notes.length > 0) {
		parts.push("", "Notes:");
		for (const note of options.notes) {
			parts.push("- " + note);
		}
	}
	parts.push(
		"",
		"Candidate metadata:",
		options.metadata ? formatJson(options.metadata) : "unavailable",
		"",
		"Saved Code Mode script:",
		truncateText(options.source, 50_000),
	);
	return parts.join("\n");
}

function replayResultText(options: {
	candidate: string;
	command: string | undefined;
	commandExitCode: number | null;
	cwd: string;
	mode: ReplayMode;
	output: string;
}) {
	const lines = [
		"Code Mode replay result",
		"",
		"Candidate: " + options.candidate,
		"Working directory: " + options.cwd,
		"Replay mode: " + options.mode,
	];
	if (options.command !== undefined) {
		lines.push(
			"Command exit code: " + String(options.commandExitCode),
			"",
			"Thread shell command:",
			options.command,
		);
	}
	lines.push(
		"",
		"Replay output:",
		truncateText(options.output, 50_000),
	);
	return lines.join("\n");
}

function truncateText(value: string, limit: number) {
	if (value.length <= limit) {
		return value;
	}
	return (
		value.slice(0, limit) +
		"\n...[truncated " +
		String(value.length - limit) +
		" chars]"
	);
}

function formatJson(value: unknown) {
	return JSON.stringify(value, null, 2);
}

async function parseArgs(argv: string[]): Promise<Args> {
	let candidate: string | undefined;
	let cwd: string | undefined;
	let codexCommand = process.env.CODEX_APP_SERVER_CODEX_COMMAND;
	let codexHome: string | undefined;
	let cliPath = defaultCliPath;
	let timeoutMs = 180_000;
	let ephemeral = false;
	let stream = true;
	let injectContext = true;
	let injectResult = true;
	const notes: string[] = [];
	let threadName: string | null | undefined;
	let mode: ReplayMode = "native";

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) {
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			printHelp();
			process.exit(0);
		}
		if (arg === "--cwd") {
			cwd = requiredValue(argv, ++index, "--cwd");
			continue;
		}
		if (arg.startsWith("--cwd=")) {
			cwd = arg.slice("--cwd=".length);
			continue;
		}
		if (arg === "--codex-command") {
			codexCommand = requiredValue(argv, ++index, "--codex-command");
			continue;
		}
		if (arg.startsWith("--codex-command=")) {
			codexCommand = arg.slice("--codex-command=".length);
			continue;
		}
		if (arg === "--codex-home") {
			codexHome = requiredValue(argv, ++index, "--codex-home");
			continue;
		}
		if (arg.startsWith("--codex-home=")) {
			codexHome = arg.slice("--codex-home=".length);
			continue;
		}
		if (arg === "--native") {
			mode = "native";
			continue;
		}
		if (arg === "--shim") {
			mode = "shim";
			continue;
		}
		if (arg === "--cli") {
			cliPath = requiredValue(argv, ++index, "--cli");
			continue;
		}
		if (arg.startsWith("--cli=")) {
			cliPath = arg.slice("--cli=".length);
			continue;
		}
		if (arg === "--timeout-ms") {
			timeoutMs = parseTimeout(requiredValue(argv, ++index, "--timeout-ms"));
			continue;
		}
		if (arg.startsWith("--timeout-ms=")) {
			timeoutMs = parseTimeout(arg.slice("--timeout-ms=".length));
			continue;
		}
		if (arg === "--ephemeral") {
			ephemeral = true;
			continue;
		}
		if (arg === "--no-stream") {
			stream = false;
			continue;
		}
		if (arg === "--no-inject-context") {
			injectContext = false;
			continue;
		}
		if (arg === "--no-inject-result") {
			injectResult = false;
			continue;
		}
		if (arg === "--name") {
			threadName = requiredValue(argv, ++index, "--name");
			continue;
		}
		if (arg.startsWith("--name=")) {
			threadName = arg.slice("--name=".length);
			continue;
		}
		if (arg === "--no-name") {
			threadName = null;
			continue;
		}
		if (arg === "--note") {
			notes.push(requiredValue(argv, ++index, "--note"));
			continue;
		}
		if (arg.startsWith("--note=")) {
			notes.push(arg.slice("--note=".length));
			continue;
		}
		if (arg.startsWith("-")) {
			throw new Error("unknown option: " + arg);
		}
		if (candidate) {
			throw new Error("unexpected positional argument: " + arg);
		}
		candidate = arg;
	}

	if (!candidate) {
		printHelp();
		throw new Error("candidate file is required");
	}

	return {
		candidate,
		cwd,
		codexCommand,
		codexHome,
		cliPath,
		timeoutMs,
		ephemeral,
		stream,
		injectContext,
		injectResult,
		notes,
		threadName,
		mode,
	};
}

function requiredValue(argv: string[], index: number, flag: string) {
	const value = argv[index];
	if (!value) {
		throw new Error(flag + " requires a value");
	}
	return value;
}

function parseTimeout(value: string) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error("invalid --timeout-ms value: " + value);
	}
	return parsed;
}

function shellQuote(value: string) {
	return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(value: unknown, field: string) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const nested = record[field];
	return typeof nested === "object" && nested !== null && !Array.isArray(nested)
		? (nested as Record<string, unknown>)
		: undefined;
}

function stringField(value: unknown, field: string) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const fieldValue = (value as Record<string, unknown>)[field];
	return typeof fieldValue === "string" ? fieldValue : undefined;
}

function numberField(value: unknown, field: string) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const fieldValue = (value as Record<string, unknown>)[field];
	return typeof fieldValue === "number" ? fieldValue : undefined;
}

function printHelp() {
	process.stdout.write(
		[
			"Run a saved Code Mode candidate in a new Codex thread without starting a model turn.",
			"",
			"Usage:",
			"  tsx scripts/run-code-mode-in-new-thread.ts <candidate.mjs> [options]",
			"",
			"Options:",
			"  --cwd <dir>                 Thread cwd. Defaults to candidate sidecar cwd, then process cwd.",
			"  --codex-command <path>      Codex binary for both app-server and replay.",
			"                              Defaults to CODEX_APP_SERVER_CODEX_COMMAND.",
			"                              With CODEX_FLOWS_MODE=code-mode, falls back to",
			"                              vp dlx @peezy.tech/codex.",
			"  --codex-home <dir>          CODEX_HOME for the spawned app-server, useful for prepared MCP config.",
			"  --native                   Use native thread/codeMode/execute replay. This is the default.",
			"  --shim                     Use the older TypeScript shell-command shim fallback.",
			"  --cli <path>                codex-app CLI path. Defaults to " + defaultCliPath,
			"  --timeout-ms <ms>           Timeout for app-server requests and completion wait.",
			"  --ephemeral                 Create an ephemeral thread.",
			"  --no-stream                 Do not stream command output while waiting.",
			"  --note <text>               Add a note to the injected replay context. Repeatable.",
			"  --name <text>               Set the thread title. Defaults to the candidate filename.",
			"  --no-name                   Leave the thread title unset.",
			"  --no-inject-context         Skip injecting candidate metadata/source before execution.",
			"  --no-inject-result          Skip injecting the replay summary after execution.",
			"  -h, --help                  Show this help.",
			"",
		].join("\n"),
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exit(1);
});
