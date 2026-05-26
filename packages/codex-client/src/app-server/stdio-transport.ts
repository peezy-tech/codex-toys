import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexEventEmitter } from "./events.ts";
import {
	type JsonRpcId,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	requireJsonRpcResult,
	stringifyJsonRpc,
} from "./rpc.ts";

type PendingRequest = {
	resolve: (value: JsonRpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type AppServerProcess = ChildProcessWithoutNullStreams;

export type CodexStdioTransportOptions = {
	codexCommand?: string;
	args?: string[];
	appServerSocket?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	requestTimeoutMs?: number;
};

export type ResolvedCodexStdioCommand = {
	command: string;
	args: string[];
};

export const DEFAULT_CODEX_COMMAND = "codex";

export class CodexStdioTransport extends CodexEventEmitter {
	readonly requestTimeoutMs: number;
	#codexCommand: string;
	#args: string[];
	#cwd: string | undefined;
	#env: NodeJS.ProcessEnv | undefined;
	#child: AppServerProcess | undefined;
	#nextRequestId = 1;
	#pending = new Map<JsonRpcId, PendingRequest>();

	constructor(options: CodexStdioTransportOptions = {}) {
		super();
		const command = resolveCodexStdioCommand(options, { ...process.env, ...options.env });
		this.#codexCommand = command.command;
		this.#args = command.args;
		this.#cwd = options.cwd;
		this.#env = options.env;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
	}

	get running(): boolean {
		return this.#child !== undefined && this.#child.exitCode === null;
	}

	start(): void {
		if (this.running) {
			return;
		}

		const child = spawn(this.#codexCommand, this.#args, {
			cwd: this.#cwd,
			env: { ...process.env, ...this.#env },
			detached: process.platform !== "win32",
		});
		this.#child = child;
		child.once("exit", (code, signal) => {
			if (this.#child === child) {
				this.#child = undefined;
			}
			const exitError = new Error(
				`codex app-server exited with ${code ?? signal ?? "unknown"}`,
			);
			this.#rejectAll(exitError);
			this.emit("close", code, signal);
		});
		child.once("error", (error) => {
			if (this.#child === child) {
				this.#child = undefined;
			}
			this.#rejectAll(error);
			this.emit("error", error);
		});

		void readLines(child.stdout, (line) => this.#handleLine(line)).catch((error) =>
			this.emit("error", error),
		);
		void readLines(child.stderr, (line) => this.emit("stderr", line)).catch(
			(error) => this.emit("error", error),
		);
	}

	close(): void {
		const child = this.#child;
		this.#child = undefined;
		if (child && child.exitCode === null) {
			killChildProcessGroup(child, "SIGTERM");
			const killTimer = setTimeout(() => {
				if (child.exitCode === null) {
					killChildProcessGroup(child, "SIGKILL");
				}
			}, 1_000);
			killTimer.unref();
		}
		this.#rejectAll(new Error("codex app-server transport closed"));
	}

	async request<T = unknown>(method: string, params?: unknown): Promise<T> {
		this.start();
		const id = this.#nextRequestId++;
		const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`JSON-RPC request timed out: ${method}`));
			}, this.requestTimeoutMs);
			this.#pending.set(id, { resolve, reject, timer });
			this.#write({ jsonrpc: "2.0", id, method, params });
		});
		return requireJsonRpcResult<T>(response);
	}

	notify(method: string, params?: unknown): void {
		this.start();
		this.#write({ jsonrpc: "2.0", method, params });
	}

	respond(id: JsonRpcId, result: unknown): void {
		this.start();
		this.#write({ jsonrpc: "2.0", id, result });
	}

	respondError(
		id: JsonRpcId,
		code: number,
		message: string,
		data?: unknown,
	): void {
		this.start();
		this.#write({ jsonrpc: "2.0", id, error: { code, message, data } });
	}

	#write(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
		const child = this.#child;
		if (!child || child.exitCode !== null) {
			throw new Error("codex app-server transport is not running");
		}
		child.stdin.write(stringifyJsonRpc(message));
	}

	#handleLine(line: string): void {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			return;
		}

		let message: unknown;
		try {
			message = JSON.parse(trimmed) as unknown;
		} catch (error) {
			this.emit(
				"error",
				new Error(`Failed to parse app-server JSON-RPC line: ${String(error)}`),
			);
			return;
		}

		if (isJsonRpcResponse(message)) {
			const pending = this.#pending.get(message.id);
			if (pending) {
				clearTimeout(pending.timer);
				this.#pending.delete(message.id);
				pending.resolve(message);
			}
			return;
		}

		if (isJsonRpcRequest(message)) {
			this.emit("request", message);
			return;
		}

		if (isJsonRpcNotification(message)) {
			this.emit("notification", message);
			return;
		}

		this.emit("error", new Error("Received malformed JSON-RPC message"));
	}

	#rejectAll(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

export function resolveCodexStdioCommand(
	options: Pick<CodexStdioTransportOptions, "appServerSocket" | "args" | "codexCommand"> = {},
	env: Record<string, string | undefined> = process.env,
): ResolvedCodexStdioCommand {
	const explicitCommand = options.codexCommand ?? env.CODEX_APP_SERVER_CODEX_COMMAND;
	const appServerSocket = options.appServerSocket ?? env.CODEX_WORKSPACE_APP_SERVER_SOCK;
	const args = [
		...envJsonStringArray(env.CODEX_APP_SERVER_CODEX_ARGS, "CODEX_APP_SERVER_CODEX_ARGS"),
		...(options.args ?? defaultCodexArgs(appServerSocket)),
	];
	if (explicitCommand?.trim()) {
		return { command: explicitCommand, args };
	}

	const packageName = env.CODEX_APP_SERVER_CODEX_PACKAGE?.trim();
	if (packageName) {
		const dlxCommand = env.CODEX_APP_SERVER_DLX_COMMAND?.trim();
		if (!dlxCommand) {
			return {
				command: "vp",
				args: ["dlx", packageName, ...args],
			};
		}
		return {
			command: dlxCommand,
			args: [packageName, ...args],
		};
	}

	return { command: DEFAULT_CODEX_COMMAND, args };
}

function envJsonStringArray(value: string | undefined, label: string): string[] {
	if (!value?.trim()) {
		return [];
	}
	const parsed = JSON.parse(stripJsonBom(value)) as unknown;
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
		throw new Error(`${label} must be a JSON array of strings`);
	}
	return parsed as string[];
}

function stripJsonBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function killChildProcessGroup(
	child: AppServerProcess,
	signal: NodeJS.Signals,
): void {
	if (process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			child.kill(signal);
			return;
		}
	}
	child.kill(signal);
}

async function readLines(
	stream: NodeJS.ReadableStream,
	onLine: (line: string) => void,
): Promise<void> {
	let buffer = "";
	stream.setEncoding("utf8");
	for await (const chunk of stream) {
		buffer += String(chunk);
		let lineEnd = buffer.indexOf("\n");
		while (lineEnd !== -1) {
			const line = buffer.slice(0, lineEnd).replace(/\r$/, "");
			buffer = buffer.slice(lineEnd + 1);
			onLine(line);
			lineEnd = buffer.indexOf("\n");
		}
	}
	if (buffer.length > 0) {
		onLine(buffer.replace(/\r$/, ""));
	}
}

function defaultCodexArgs(appServerSocket: string | undefined): string[] {
	if (appServerSocket) {
		return ["app-server", "proxy", "--sock", appServerSocket];
	}
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
