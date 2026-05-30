#!/usr/bin/env node
import http from "node:http";
import { createCodexToysProxyHandler } from "../proxy.ts";

type ParsedProxyArgs = {
	cwd?: string;
	sshTarget?: string;
	staticDir?: string;
	host: string;
	port: number;
	timeoutMs: number;
	toyboxCommand?: string;
	remoteCodexCommand?: string;
	remoteCodexArgs: string[];
	help: boolean;
};

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
	process.stdout.write(helpText());
	process.exit(0);
}

const handler = createCodexToysProxyHandler({
	cwd: parsed.cwd,
	sshTarget: parsed.sshTarget,
	staticDir: parsed.staticDir,
	timeoutMs: parsed.timeoutMs,
	toyboxCommand: parsed.toyboxCommand,
	remoteCodexCommand: parsed.remoteCodexCommand,
	remoteCodexArgs: parsed.remoteCodexArgs,
	apiBasePath: "/api",
});
const server = http.createServer((request, response) => {
	void handler(request, response).catch((error: unknown) => {
		response.statusCode = 500;
		response.setHeader("content-type", "application/json; charset=utf-8");
		response.end(`${JSON.stringify({ error: errorMessage(error) })}\n`);
	});
});

server.listen(parsed.port, parsed.host, () => {
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : parsed.port;
	process.stderr.write(`codex-toys-proxy listening on http://${parsed.host}:${port}\n`);
});

function parseArgs(argv: string[]): ParsedProxyArgs {
	const result: ParsedProxyArgs = {
		host: "127.0.0.1",
		port: 3587,
		timeoutMs: 90_000,
		remoteCodexArgs: [],
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) {
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			result.help = true;
			continue;
		}
		if (arg === "serve") {
			continue;
		}
		if (arg === "--cwd") {
			result.cwd = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--cwd=")) {
			result.cwd = arg.slice("--cwd=".length);
			continue;
		}
		if (arg === "--ssh" || arg === "--ssh-target") {
			result.sshTarget = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--ssh=")) {
			result.sshTarget = arg.slice("--ssh=".length);
			continue;
		}
		if (arg.startsWith("--ssh-target=")) {
			result.sshTarget = arg.slice("--ssh-target=".length);
			continue;
		}
		if (arg === "--static") {
			result.staticDir = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--static=")) {
			result.staticDir = arg.slice("--static=".length);
			continue;
		}
		if (arg === "--host") {
			result.host = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--host=")) {
			result.host = arg.slice("--host=".length);
			continue;
		}
		if (arg === "--port") {
			result.port = positiveInteger(required(argv, ++index, arg), arg);
			continue;
		}
		if (arg.startsWith("--port=")) {
			result.port = positiveInteger(arg.slice("--port=".length), "--port");
			continue;
		}
		if (arg === "--timeout-ms") {
			result.timeoutMs = positiveInteger(required(argv, ++index, arg), arg);
			continue;
		}
		if (arg.startsWith("--timeout-ms=")) {
			result.timeoutMs = positiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
			continue;
		}
		if (arg === "--toybox-command") {
			result.toyboxCommand = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--toybox-command=")) {
			result.toyboxCommand = arg.slice("--toybox-command=".length);
			continue;
		}
		if (arg === "--codex-command" || arg === "--remote-codex-command") {
			result.remoteCodexCommand = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--codex-command=")) {
			result.remoteCodexCommand = arg.slice("--codex-command=".length);
			continue;
		}
		if (arg.startsWith("--remote-codex-command=")) {
			result.remoteCodexCommand = arg.slice("--remote-codex-command=".length);
			continue;
		}
		if (arg === "--codex-arg" || arg === "--remote-codex-arg") {
			result.remoteCodexArgs.push(required(argv, ++index, arg));
			continue;
		}
		if (arg.startsWith("--codex-arg=")) {
			result.remoteCodexArgs.push(arg.slice("--codex-arg=".length));
			continue;
		}
		if (arg.startsWith("--remote-codex-arg=")) {
			result.remoteCodexArgs.push(arg.slice("--remote-codex-arg=".length));
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}
	return result;
}

function helpText(): string {
	return `codex-toys-proxy serves a generic HTTP edge for codex-toys toyboxes.

Usage:
  codex-toys-proxy serve --cwd <workspace> [--static <dir>]
  codex-toys-proxy serve --ssh <target> --cwd <remote-workspace> [--static <dir>]

Options:
  --cwd <path>                 Workspace cwd for the local or SSH toybox.
  --ssh, --ssh-target <target> SSH target for remote toybox stdio.
  --static <dir>               Optional static dashboard directory.
  --host <host>                HTTP host. Defaults to 127.0.0.1.
  --port <port>                HTTP port. Defaults to 3587.
  --timeout-ms <ms>            Toybox request timeout. Defaults to 90000.
  --toybox-command <command>    codex-toys command/path for spawned toyboxes.
  --codex-command <command>    Codex command used inside the toybox.
  --codex-arg <arg>            Extra Codex argument. Repeatable.

HTTP API:
  GET  /api/status
  GET  /api/schema
  POST /api/rpc
  POST /api/host/overview
  POST /api/app/:method
  POST /api/workspace/:method
  POST /api/workspace/overview
`;
}

function required(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function positiveInteger(value: string, flag: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${flag} must be a positive integer`);
	}
	return parsed;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
