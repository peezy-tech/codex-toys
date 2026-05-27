import { isAppServerAction, type AppServerAction } from "./actions.ts";

export type ParsedArgs =
	| { type: "help" }
	| { type: "actions" }
	| {
			type: "call";
			action: AppServerAction;
			paramsText: string | undefined;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  };

export const DEFAULT_WS_URL = "ws://127.0.0.1:3585";
const defaultTimeoutMs = 90_000;

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ParsedArgs {
	const positionals: string[] = [];
	let url = env.CODEX_WORKSPACE_APP_SERVER_WS_URL ?? DEFAULT_WS_URL;
	let timeoutMs = defaultTimeoutMs;
	let pretty = true;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) {
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			return { type: "help" };
		}
		if (arg === "--url" || arg === "--ws-url") {
			const value = argv[index + 1];
			if (!value) {
				throw new Error(`${arg} requires a WebSocket URL`);
			}
			url = value;
			index += 1;
			continue;
		}
		if (arg.startsWith("--url=")) {
			url = arg.slice("--url=".length);
			continue;
		}
		if (arg.startsWith("--ws-url=")) {
			url = arg.slice("--ws-url=".length);
			continue;
		}
		if (arg === "--timeout-ms") {
			const value = argv[index + 1];
			if (!value) {
				throw new Error("--timeout-ms requires a number");
			}
			timeoutMs = parseTimeout(value);
			index += 1;
			continue;
		}
		if (arg.startsWith("--timeout-ms=")) {
			timeoutMs = parseTimeout(arg.slice("--timeout-ms=".length));
			continue;
		}
		if (arg === "--compact") {
			pretty = false;
			continue;
		}
		if (arg === "--pretty") {
			pretty = true;
			continue;
		}
		if (arg === "--") {
			positionals.push(...argv.slice(index + 1));
			break;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		}
		positionals.push(arg);
	}

	const command = positionals[0];
	if (!command) {
		return { type: "help" };
	}
	if (command === "help") {
		return { type: "help" };
	}
	if (command === "actions") {
		return { type: "actions" };
	}

	const action = command === "call" ? positionals[1] : command;
	const paramsParts = command === "call" ? positionals.slice(2) : positionals.slice(1);
	if (!action) {
		throw new Error("call requires an action name");
	}
	if (!isAppServerAction(action)) {
		throw new Error(`Unknown action: ${action}`);
	}
	return {
		type: "call",
		action,
		paramsText: paramsParts.length > 0 ? paramsParts.join(" ") : undefined,
		url,
		timeoutMs,
		pretty,
	};
}

function parseTimeout(value: string) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error("--timeout-ms must be a positive integer");
	}
	return parsed;
}
