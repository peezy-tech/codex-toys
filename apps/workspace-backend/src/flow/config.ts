import path from "node:path";
import { fileURLToPath } from "node:url";

export type FlowBackendExecutor = "direct" | "systemd-run";

export type FlowBackendConfig = {
	cwd: string;
	dataDir: string;
	host: string;
	port: number;
	secret?: string;
	executor: FlowBackendExecutor;
	nodeCommand: string;
	flowRunnerPath: string;
	forwardEnv: string[];
	workspaceBackendUrl?: string;
};

export type FlowBackendCli =
	| { kind: "help" }
	| { kind: "serve"; config: FlowBackendConfig }
	| { kind: "dispatch"; config: FlowBackendConfig; eventPath: string; wait: boolean }
	| { kind: "list-events"; config: FlowBackendConfig; limit?: number; type?: string }
	| { kind: "show-event"; config: FlowBackendConfig; eventId: string }
	| { kind: "replay-event"; config: FlowBackendConfig; eventId: string; wait: boolean }
	| { kind: "list-runs"; config: FlowBackendConfig; eventId?: string; status?: string; limit?: number }
	| { kind: "show-run"; config: FlowBackendConfig; runId: string };

export function readConfig(
	env: Record<string, string | undefined> = process.env,
	overrides: Partial<FlowBackendConfig> = {},
): FlowBackendConfig {
	const cwd = path.resolve(overrides.cwd ?? env.CODEX_FLOW_BACKEND_CWD ?? process.cwd());
	const dataDir = path.resolve(overrides.dataDir ?? env.CODEX_FLOW_BACKEND_DATA_DIR ?? path.join(cwd, ".codex", "flow-backend"));
	return {
		cwd,
		dataDir,
		host: overrides.host ?? env.CODEX_FLOW_BACKEND_HOST ?? "127.0.0.1",
		port: overrides.port ?? numberEnv(env.CODEX_FLOW_BACKEND_PORT, 7345),
		...(overrides.secret ?? env.CODEX_FLOW_BACKEND_SECRET
			? { secret: overrides.secret ?? env.CODEX_FLOW_BACKEND_SECRET }
			: {}),
		executor: overrides.executor ?? executorEnv(env.CODEX_FLOW_BACKEND_EXECUTOR),
		nodeCommand: overrides.nodeCommand ?? env.CODEX_FLOW_BACKEND_NODE ?? process.execPath,
		flowRunnerPath: path.resolve(
			overrides.flowRunnerPath ?? env.CODEX_FLOW_RUNNER_PATH ?? defaultFlowRunnerPath(),
		),
		forwardEnv: overrides.forwardEnv ?? forwardEnv(env.CODEX_FLOW_BACKEND_FORWARD_ENV),
		...(overrides.workspaceBackendUrl ?? env.CODEX_WORKSPACE_BACKEND_WS_URL
			? { workspaceBackendUrl: overrides.workspaceBackendUrl ?? env.CODEX_WORKSPACE_BACKEND_WS_URL }
			: {}),
	};
}

export function parseCli(argv: string[], env: Record<string, string | undefined> = process.env): FlowBackendCli {
	const command = argv[0];
	if (!command || command === "help" || command === "-h" || command === "--help") {
		return { kind: "help" };
	}

	let cwd: string | undefined;
	let dataDir: string | undefined;
	let host: string | undefined;
	let port: number | undefined;
	let secret: string | undefined;
	let executor: FlowBackendExecutor | undefined;
	let nodeCommand: string | undefined;
	let flowRunnerPath: string | undefined;
	let workspaceBackendUrl: string | undefined;
	let wait = false;
	let eventPath: string | undefined;
	let eventId: string | undefined;
	let runId: string | undefined;
	let status: string | undefined;
	let limit: number | undefined;
	let type: string | undefined;
	const rest = argv.slice(1);
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		if (!arg) {
			continue;
		}
		if (arg === "--cwd") {
			cwd = required(rest, ++index, arg);
			continue;
		}
		if (arg === "--data-dir") {
			dataDir = required(rest, ++index, arg);
			continue;
		}
		if (arg === "--host") {
			host = required(rest, ++index, arg);
			continue;
		}
		if (arg === "--port") {
			port = Number(required(rest, ++index, arg));
			continue;
		}
		if (arg === "--secret") {
			secret = required(rest, ++index, arg);
			continue;
		}
		if (arg === "--executor") {
			executor = executorEnv(required(rest, ++index, arg));
			continue;
		}
		if (arg === "--node") {
			nodeCommand = required(rest, ++index, arg);
			continue;
		}
		if (arg === "--flow-runner") {
			flowRunnerPath = required(rest, ++index, arg);
			continue;
		}
		if (arg === "--workspace-backend-url") {
			workspaceBackendUrl = required(rest, ++index, arg);
			continue;
		}
		if (arg.startsWith("--workspace-backend-url=")) {
			workspaceBackendUrl = arg.slice("--workspace-backend-url=".length);
			continue;
		}
		if (arg === "--event") {
			eventPath = required(rest, ++index, arg);
			continue;
		}
		if (arg === "--wait") {
			wait = true;
			continue;
		}
		if (arg === "--event-id") {
			eventId = required(rest, ++index, arg);
			continue;
		}
		if (arg.startsWith("--event-id=")) {
			eventId = arg.slice("--event-id=".length);
			continue;
		}
		if (arg === "--run-id") {
			runId = required(rest, ++index, arg);
			continue;
		}
		if (arg.startsWith("--run-id=")) {
			runId = arg.slice("--run-id=".length);
			continue;
		}
		if (arg === "--status") {
			status = required(rest, ++index, arg);
			continue;
		}
		if (arg.startsWith("--status=")) {
			status = arg.slice("--status=".length);
			continue;
		}
		if (arg === "--limit") {
			limit = Number(required(rest, ++index, arg));
			continue;
		}
		if (arg.startsWith("--limit=")) {
			limit = Number(arg.slice("--limit=".length));
			continue;
		}
		if (arg === "--type") {
			type = required(rest, ++index, arg);
			continue;
		}
		if (arg.startsWith("--type=")) {
			type = arg.slice("--type=".length);
			continue;
		}
		if (!arg.startsWith("-") && !eventId && (command === "show-event" || command === "replay-event")) {
			eventId = arg;
			continue;
		}
		if (!arg.startsWith("-") && !runId && command === "show-run") {
			runId = arg;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	const config = readConfig(env, {
		...(cwd ? { cwd } : {}),
		...(dataDir ? { dataDir } : {}),
		...(host ? { host } : {}),
		...(port !== undefined ? { port } : {}),
		...(secret ? { secret } : {}),
		...(executor ? { executor } : {}),
		...(nodeCommand ? { nodeCommand } : {}),
		...(flowRunnerPath ? { flowRunnerPath } : {}),
		...(workspaceBackendUrl ? { workspaceBackendUrl } : {}),
	});
	if (command === "serve") {
		return { kind: "serve", config };
	}
	if (command === "dispatch") {
		if (!eventPath) {
			throw new Error("dispatch requires --event <path>");
		}
		return { kind: "dispatch", config, eventPath, wait };
	}
	if (command === "list-events" || command === "events") {
		return { kind: "list-events", config, limit, type };
	}
	if (command === "show-event" || command === "event") {
		return { kind: "show-event", config, eventId: requireValue(eventId, "show-event requires <event-id>") };
	}
	if (command === "replay-event" || command === "replay") {
		return { kind: "replay-event", config, eventId: requireValue(eventId, "replay-event requires <event-id>"), wait };
	}
	if (command === "list-runs" || command === "runs") {
		return { kind: "list-runs", config, eventId, status, limit };
	}
	if (command === "show-run" || command === "run") {
		return { kind: "show-run", config, runId: requireValue(runId, "show-run requires <run-id>") };
	}
	throw new Error(`Unknown command: ${command}`);
}

export function defaultFlowRunnerPath(): string {
	return path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"..",
		"flow-runner",
		"src",
		"index.ts",
	);
}

export function helpText(): string {
	return [
		"Usage:",
		"  codex-workspace-backend-local serve [--cwd <dir>] [--data-dir <dir>] [--host <host>] [--port <port>]",
		"  codex-workspace-backend-local dispatch --event <event.json> [--cwd <dir>] [--data-dir <dir>] [--wait]",
		"  codex-workspace-backend-local list-events [--type <type>] [--limit <n>]",
		"  codex-workspace-backend-local show-event <event-id>",
		"  codex-workspace-backend-local replay-event <event-id> [--wait]",
		"  codex-workspace-backend-local list-runs [--event-id <event-id>] [--status <status>] [--limit <n>]",
		"  codex-workspace-backend-local show-run <run-id>",
		"",
		"Environment:",
		"  CODEX_FLOW_BACKEND_SECRET       Optional HMAC secret for HTTP dispatches",
		"  CODEX_FLOW_BACKEND_EXECUTOR     direct or systemd-run",
		"  CODEX_WORKSPACE_BACKEND_WS_URL  Workspace backend WebSocket URL passed to flow steps",
		"  CODEX_FLOW_PUSH/PUBLISH         Optional release-flow action gates",
		"",
	].join("\n");
}

function numberEnv(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function executorEnv(value: string | undefined): FlowBackendExecutor {
	if (value === "systemd-run") {
		return "systemd-run";
	}
	if (!value || value === "direct") {
		return "direct";
	}
	throw new Error("executor must be direct or systemd-run");
}

function forwardEnv(value: string | undefined): string[] {
	const defaults = [
		"CODEX_FLOW_COMMIT",
		"CODEX_FLOW_PUSH",
		"CODEX_FLOW_PUBLISH",
		"CODEX_FLOW_FORCE",
		"CODEX_FLOW_SQUASH_PATCH_STACK",
		"CODEX_APP_SERVER_CODEX_COMMAND",
		"CODEX_APP_SERVER_CODEX_PACKAGE",
		"CODEX_APP_SERVER_DLX_COMMAND",
		"CODEX_FLOW_ATTEMPT_ID",
		"CODEX_HOME",
		"CODEX_FLOW_EVENT_ID",
		"PEEZY_CODEX_REPO",
		"CODEX_FLOW_LAUNCHED_BY",
		"CODEX_FLOW_REPLAY",
		"CODEX_FLOW_RUN_ID",
		"CODEX_WORKSPACE_BACKEND_WS_URL",
		"PEEZY_CODEX_TARGET_BRANCH",
		"PEEZY_CODEX_CARGO_TARGET_DIR",
		"HOME",
		"PATH",
	];
	if (!value) {
		return defaults;
	}
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function required(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function requireValue<T>(value: T | undefined, message: string): T {
	if (value === undefined) {
		throw new Error(message);
	}
	return value;
}
