#!/usr/bin/env node
import { CodexAppServerClient } from "@peezy.tech/codex-flows";

import { APP_SERVER_ACTIONS } from "./actions.ts";
import { DEFAULT_WS_URL, parseArgs } from "./args.ts";
import {
	extractCodeModeCandidates,
	extractCodeModeToolInputCandidates,
	runCodeModeCandidate,
} from "./recipes.ts";

async function main() {
	try {
		const parsed = parseArgs(process.argv.slice(2), process.env);
		switch (parsed.type) {
			case "help":
				write(helpText());
				return;
			case "actions":
				write(`${APP_SERVER_ACTIONS.join("\n")}\n`);
				return;
			case "extract-code-mode":
				await extractCodeMode(parsed.outputDir);
				return;
			case "extract-code-mode-tool-input":
				await extractCodeModeToolInput(parsed.outputDir);
				return;
			case "run-code-mode":
				write(formatJson(await runCodeModeCandidate(parsed), parsed.pretty));
				return;
			case "call":
				await callAction(parsed);
				return;
		}
	} catch (error) {
		writeError(`${errorMessage(error)}\n`);
		process.exitCode = 1;
	}
}

async function extractCodeMode(outputDir: string | undefined) {
	const result = await extractCodeModeCandidates({
		stdin: process.stdin,
		outputDir,
	});
	for (const saved of result.saved) {
		writeError(`saved ${saved.codePath}\n`);
	}
	write(formatJson({ continue: true }, true));
}

async function extractCodeModeToolInput(outputDir: string | undefined) {
	const result = await extractCodeModeToolInputCandidates({
		stdin: process.stdin,
		outputDir,
	});
	for (const saved of result.saved) {
		writeError(`saved ${saved.codePath}\n`);
	}
	write(formatJson({ continue: true }, true));
}

type CallArgs = Extract<ReturnType<typeof parseArgs>, { type: "call" }>;

async function callAction(args: CallArgs) {
	const params = await readParams(args.paramsText);
	const client = new CodexAppServerClient({
		webSocketTransportOptions: {
			url: args.url,
			requestTimeoutMs: args.timeoutMs,
		},
		clientName: "codex-app-cli",
		clientTitle: "Codex App CLI",
		clientVersion: "0.1.0",
	});

	client.on("request", (message) => {
		client.respondError(message.id, -32603, "codex-app CLI does not handle server requests");
	});

	try {
		await client.connect();
		const result = await client.request(args.action, params);
		write(formatJson(result, args.pretty));
	} finally {
		client.close();
	}
}

async function readParams(paramsText: string | undefined) {
	if (paramsText !== undefined) {
		return parseJsonParams(paramsText);
	}
	if (process.stdin.isTTY) {
		return undefined;
	}
	const text = await readStdin();
	if (!text.trim()) {
		return undefined;
	}
	return parseJsonParams(text);
}

async function readStdin() {
	let text = "";
	for await (const chunk of process.stdin) {
		text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
	}
	return text;
}

function parseJsonParams(text: string) {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`Failed to parse params JSON: ${errorMessage(error)}`);
	}
}

function formatJson(value: unknown, pretty: boolean) {
	return `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;
}

function helpText() {
	return `codex-app sends JSON-RPC actions to a running Codex app-server.

Usage:
  codex-app [options] <action> [params-json]
  codex-app [options] call <action> [params-json]
  echo '<params-json>' | codex-app [options] <action>
  codex-app actions
  codex-app extract-code-mode [--output-dir <dir>]
  codex-app extract-code-mode-tool-input [--output-dir <dir>]
  codex-app run-code-mode <candidate.mjs> [--cwd <dir>]

Options:
  --url, --ws-url <url>       App-server URL; use stdio:// to spawn a Codex app-server
                              Defaults to CODEX_WORKSPACE_APP_SERVER_WS_URL or ${DEFAULT_WS_URL}
  --timeout-ms <ms>           Request timeout in milliseconds
  --cwd <dir>                 Working directory for run-code-mode
  --output-dir <dir>          Candidate output dir for extract-code-mode
  --codex-command <path>      Codex binary for run-code-mode with --url stdio://
                              Defaults to CODEX_APP_SERVER_CODEX_COMMAND.
                              With CODEX_FLOWS_MODE=code-mode, falls back to
                              vp dlx @peezy.tech/codex.
  --compact                   Print compact JSON
  --pretty                    Print pretty JSON
  -h, --help                  Show this help

Examples:
  codex-app thread/list '{"limit": 20, "sourceKinds": []}'
  echo '{"refreshToken": false}' | codex-app account/read
  codex-app extract-code-mode < stop-hook-payload.json
  codex-app extract-code-mode-tool-input < pre-tool-use-hook-payload.json
  CODEX_FLOWS_MODE=code-mode codex-app --url=stdio:// run-code-mode .codex/code-mode-candidates/turn-a1b2c3.mjs
`;
}

function write(text: string) {
	process.stdout.write(text);
}

function writeError(text: string) {
	process.stderr.write(text);
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

await main();
