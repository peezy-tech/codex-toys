import { validateMethodName } from "./actions.ts";
import { parseRemoteMode, type RemoteMode } from "./remote-provider.ts";
import { parseMode, type WorkspaceModeInput } from "./workspace-autonomy.ts";
import type { MemoryTransplantDirection } from "./memories.ts";

export type ParsedRemoteOptions = {
	sshTarget?: string;
	cwd?: string;
	remoteMode?: RemoteMode;
	localPort?: number;
	remoteHost?: string;
	remotePort?: number;
};

type ParsedCliBase =
	| { type: "help" }
	| {
			type: "fetch";
			appUrl: string;
			workspaceUrl: string;
			timeoutMs: number;
			color: boolean;
			json: boolean;
	  }
	| {
			type: "remote-status";
			appUrl: string;
			workspaceUrl: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "remote-turn-start";
			prompt: string;
			cwd?: string;
			via: "auto" | "workspace" | "app";
			appUrl: string;
			workspaceUrl: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "remote-tunnel-start";
			sshTarget?: string;
			localPort?: number;
			remoteHost?: string;
			remotePort?: number;
			dryRun: boolean;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "automation-run";
			target: string;
			eventPath?: string;
			prompt?: string;
			workspaceRoot?: string;
			cwd?: string;
			via: "auto" | "workspace" | "app";
			appUrl: string;
			workspaceUrl: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "automation-list";
			workspaceRoot?: string;
			json: boolean;
			pretty: boolean;
	  }
	| { type: "app-actions" }
	| {
			type: "app-call";
			method: string;
			paramsText?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| { type: "workspace-methods"; url: string; timeoutMs: number; pretty: boolean }
	| {
			type: "workspace-doctor";
			mode?: WorkspaceModeInput;
			workspaceRoot?: string;
			appUrl: string;
			workspaceUrl: string;
			timeoutMs: number;
			color: boolean;
			json: boolean;
	  }
	| {
			type: "workspace-tick";
			mode?: WorkspaceModeInput;
			workspaceRoot?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workspace-run";
			taskId: string;
			mode?: WorkspaceModeInput;
			workspaceRoot?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workspace-init-actions";
			workspaceRoot?: string;
			forgejo: boolean;
			github: boolean;
			withSmoke: boolean;
			withAgentTurn: boolean;
			overwrite: boolean;
			pretty: boolean;
	  }
	| {
			type: "workspace-backend-init-local";
			workspaceRoot?: string;
			overwrite: boolean;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workspace-backend-status";
			workspaceRoot?: string;
			appUrl: string;
			workspaceUrl: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workspace-backend-start";
			workspaceRoot?: string;
			dryRun: boolean;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workspace-call";
			method: string;
			paramsText?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workspace-app-call";
			method: string;
			paramsText?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "flow-dispatch";
			eventPath: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "flow-list-events";
			eventType?: string;
			limit?: number;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "flow-get-event";
			eventId: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "flow-replay";
			eventId: string;
			wait: boolean;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "flow-list-runs";
			eventId?: string;
			status?: string;
			limit?: number;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "flow-get-run";
			runId: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "actions-prepare-auth";
			workspaceRoot?: string;
			pretty: boolean;
	  }
	| {
			type: "actions-cleanup";
			workspaceRoot?: string;
			pretty: boolean;
	  }
	| {
			type: "actions-dispatch";
			workspaceRoot?: string;
			eventPath: string;
			pretty: boolean;
	  }
	| {
			type: "actions-assert-run";
			workspaceRoot?: string;
			flowName: string;
			stepName: string;
			artifactText?: string;
			pretty: boolean;
	  }
	| {
			type: "memories-transplant";
			direction: MemoryTransplantDirection;
			workspaceRoot?: string;
			globalCodexHome?: string;
			workspaceCodexHome?: string;
			apply: boolean;
			overwrite: boolean;
			merge?: "codex";
			backup: boolean;
			json: boolean;
	  }
	| {
			type: "threads-locate";
			threadId: string;
			codexHome?: string;
			json: boolean;
	  }
	| {
			type: "threads-inspect";
			threadIdOrPath: string;
			json: boolean;
			codexHome?: string;
	  }
	| {
			type: "threads-install-rollout";
			rolloutPath: string;
			codexHome?: string;
			replace: boolean;
			json: boolean;
	  }
	| {
			type: "threads-transplant";
			threadId: string;
			fromCodexHome?: string;
			toCodexHome?: string;
			replace: boolean;
			json: boolean;
	  }
	| {
			type: "pack-inspect";
			source: string;
			ref?: string;
			json: boolean;
	  }
	| {
			type: "pack-add";
			source: string;
			ref?: string;
			workspaceRoot?: string;
			apply: boolean;
			overwrite: boolean;
			include: string[];
			exclude: string[];
			json: boolean;
	  }
	| {
			type: "pack-doctor";
			workspaceRoot?: string;
			json: boolean;
	  }
	| {
			type: "pack-list";
			workspaceRoot?: string;
			json: boolean;
	  };

export type ParsedCli = ParsedCliBase & ParsedRemoteOptions;

export const DEFAULT_APP_SERVER_WS_URL = "ws://127.0.0.1:3585";
export const DEFAULT_WORKSPACE_BACKEND_WS_URL = "ws://127.0.0.1:3586";
const defaultTimeoutMs = 90_000;

export function parseArgs(
	argv: string[],
	env: Record<string, string | undefined> = process.env,
): ParsedCli {
	const positionals: string[] = [];
	let appUrl = env.CODEX_WORKSPACE_APP_SERVER_WS_URL ?? DEFAULT_APP_SERVER_WS_URL;
	let workspaceUrl = env.CODEX_WORKSPACE_BACKEND_WS_URL ??
		DEFAULT_WORKSPACE_BACKEND_WS_URL;
	let timeoutMs = defaultTimeoutMs;
	let pretty = true;
	let color = true;
	let json = false;
	let eventPath: string | undefined;
	let eventType: string | undefined;
	let eventId: string | undefined;
	let runId: string | undefined;
	let status: string | undefined;
	let limit: number | undefined;
	let flowName: string | undefined;
	let stepName: string | undefined;
	let artifactText: string | undefined;
	let wait = false;
	let mode: WorkspaceModeInput | undefined;
	let workspaceRoot: string | undefined;
	let globalCodexHome: string | undefined;
	let workspaceCodexHome: string | undefined;
	let codexHome: string | undefined;
	let fromCodexHome: string | undefined;
	let toCodexHome: string | undefined;
	let apply = false;
	let overwrite = false;
	let replace = false;
	let merge: "codex" | undefined;
	let backup = true;
	let ref: string | undefined;
	let forgejo = false;
	let github = false;
	let withSmoke = false;
	let withAgentTurn = false;
	let dryRun = false;
	let prompt: string | undefined;
	let cwd: string | undefined = env.CODEX_FLOWS_REMOTE_CWD;
	let via: "auto" | "workspace" | "app" = "auto";
	let sshTarget: string | undefined = env.CODEX_FLOWS_REMOTE_SSH_TARGET;
	let remoteMode: RemoteMode = parseRemoteMode(env.CODEX_FLOWS_REMOTE_MODE);
	let localPort: number | undefined;
	let remoteHost: string | undefined;
	let remotePort: number | undefined;
	const include: string[] = [];
	const exclude: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) {
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			return { type: "help" };
		}
		if (arg === "--url" || arg === "--ws-url") {
			const value = required(argv, ++index, arg);
			appUrl = value;
			workspaceUrl = value;
			continue;
		}
		if (arg.startsWith("--url=")) {
			const value = arg.slice("--url=".length);
			appUrl = value;
			workspaceUrl = value;
			continue;
		}
		if (arg.startsWith("--ws-url=")) {
			const value = arg.slice("--ws-url=".length);
			appUrl = value;
			workspaceUrl = value;
			continue;
		}
		if (arg === "--app-url" || arg === "--app-server-url") {
			appUrl = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--app-url=")) {
			appUrl = arg.slice("--app-url=".length);
			continue;
		}
		if (arg.startsWith("--app-server-url=")) {
			appUrl = arg.slice("--app-server-url=".length);
			continue;
		}
		if (arg === "--workspace-url" || arg === "--workspace-backend-url") {
			workspaceUrl = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--workspace-url=")) {
			workspaceUrl = arg.slice("--workspace-url=".length);
			continue;
		}
		if (arg.startsWith("--workspace-backend-url=")) {
			workspaceUrl = arg.slice("--workspace-backend-url=".length);
			continue;
		}
		if (arg === "--timeout-ms") {
			timeoutMs = positiveInteger(required(argv, ++index, arg), arg);
			continue;
		}
		if (arg.startsWith("--timeout-ms=")) {
			timeoutMs = positiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
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
		if (arg === "--no-color") {
			color = false;
			continue;
		}
		if (arg === "--color") {
			color = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--mode") {
			mode = parseMode(required(argv, ++index, arg));
			continue;
		}
		if (arg.startsWith("--mode=")) {
			mode = parseMode(arg.slice("--mode=".length));
			continue;
		}
		if (arg === "--workspace-root") {
			workspaceRoot = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--workspace-root=")) {
			workspaceRoot = arg.slice("--workspace-root=".length);
			continue;
		}
		if (arg === "--cwd") {
			cwd = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--cwd=")) {
			cwd = arg.slice("--cwd=".length);
			continue;
		}
		if (arg === "--global-codex-home") {
			globalCodexHome = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--global-codex-home=")) {
			globalCodexHome = arg.slice("--global-codex-home=".length);
			continue;
		}
		if (arg === "--workspace-codex-home") {
			workspaceCodexHome = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--workspace-codex-home=")) {
			workspaceCodexHome = arg.slice("--workspace-codex-home=".length);
			continue;
		}
		if (arg === "--codex-home") {
			codexHome = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--codex-home=")) {
			codexHome = arg.slice("--codex-home=".length);
			continue;
		}
		if (arg === "--from-codex-home") {
			fromCodexHome = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--from-codex-home=")) {
			fromCodexHome = arg.slice("--from-codex-home=".length);
			continue;
		}
		if (arg === "--to-codex-home") {
			toCodexHome = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--to-codex-home=")) {
			toCodexHome = arg.slice("--to-codex-home=".length);
			continue;
		}
		if (arg === "--apply") {
			apply = true;
			continue;
		}
		if (arg === "--overwrite") {
			overwrite = true;
			continue;
		}
		if (arg === "--replace") {
			replace = true;
			continue;
		}
		if (arg === "--ref") {
			ref = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--ref=")) {
			ref = arg.slice("--ref=".length);
			continue;
		}
		if (arg === "--include") {
			include.push(required(argv, ++index, arg));
			continue;
		}
		if (arg.startsWith("--include=")) {
			include.push(arg.slice("--include=".length));
			continue;
		}
		if (arg === "--exclude") {
			exclude.push(required(argv, ++index, arg));
			continue;
		}
		if (arg.startsWith("--exclude=")) {
			exclude.push(arg.slice("--exclude=".length));
			continue;
		}
		if (arg === "--merge") {
			const value = required(argv, ++index, arg);
			if (value !== "codex") {
				throw new Error("--merge currently supports only codex");
			}
			merge = "codex";
			continue;
		}
		if (arg.startsWith("--merge=")) {
			const value = arg.slice("--merge=".length);
			if (value !== "codex") {
				throw new Error("--merge currently supports only codex");
			}
			merge = "codex";
			continue;
		}
		if (arg === "--backup") {
			backup = true;
			continue;
		}
		if (arg === "--no-backup") {
			backup = false;
			continue;
		}
		if (arg === "--event") {
			eventPath = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--event=")) {
			eventPath = arg.slice("--event=".length);
			continue;
		}
		if (arg === "--event-id") {
			eventId = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--event-id=")) {
			eventId = arg.slice("--event-id=".length);
			continue;
		}
		if (arg === "--run-id") {
			runId = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--run-id=")) {
			runId = arg.slice("--run-id=".length);
			continue;
		}
		if (arg === "--type") {
			eventType = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--type=")) {
			eventType = arg.slice("--type=".length);
			continue;
		}
		if (arg === "--status") {
			status = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--status=")) {
			status = arg.slice("--status=".length);
			continue;
		}
		if (arg === "--flow") {
			flowName = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--flow=")) {
			flowName = arg.slice("--flow=".length);
			continue;
		}
		if (arg === "--step") {
			stepName = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--step=")) {
			stepName = arg.slice("--step=".length);
			continue;
		}
		if (arg === "--artifact-text") {
			artifactText = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--artifact-text=")) {
			artifactText = arg.slice("--artifact-text=".length);
			continue;
		}
		if (arg === "--limit") {
			limit = positiveInteger(required(argv, ++index, arg), arg);
			continue;
		}
		if (arg.startsWith("--limit=")) {
			limit = positiveInteger(arg.slice("--limit=".length), "--limit");
			continue;
		}
		if (arg === "--wait") {
			wait = true;
			continue;
		}
		if (arg === "--forgejo") {
			forgejo = true;
			continue;
		}
		if (arg === "--github") {
			github = true;
			continue;
		}
		if (arg === "--with-smoke") {
			withSmoke = true;
			continue;
		}
		if (arg === "--with-agent-turn") {
			withAgentTurn = true;
			continue;
		}
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--prompt") {
			prompt = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--prompt=")) {
			prompt = arg.slice("--prompt=".length);
			continue;
		}
		if (arg === "--via") {
			via = parseRemoteVia(required(argv, ++index, arg));
			continue;
		}
		if (arg.startsWith("--via=")) {
			via = parseRemoteVia(arg.slice("--via=".length));
			continue;
		}
		if (arg === "--remote-mode") {
			remoteMode = parseRemoteMode(required(argv, ++index, arg));
			continue;
		}
		if (arg.startsWith("--remote-mode=")) {
			remoteMode = parseRemoteMode(arg.slice("--remote-mode=".length));
			continue;
		}
		if (arg === "--ssh" || arg === "--ssh-target") {
			sshTarget = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--ssh=")) {
			sshTarget = arg.slice("--ssh=".length);
			continue;
		}
		if (arg.startsWith("--ssh-target=")) {
			sshTarget = arg.slice("--ssh-target=".length);
			continue;
		}
		if (arg === "--local-port") {
			localPort = positiveInteger(required(argv, ++index, arg), arg);
			continue;
		}
		if (arg.startsWith("--local-port=")) {
			localPort = positiveInteger(arg.slice("--local-port=".length), "--local-port");
			continue;
		}
		if (arg === "--remote-host") {
			remoteHost = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--remote-host=")) {
			remoteHost = arg.slice("--remote-host=".length);
			continue;
		}
		if (arg === "--remote-port") {
			remotePort = positiveInteger(required(argv, ++index, arg), arg);
			continue;
		}
		if (arg.startsWith("--remote-port=")) {
			remotePort = positiveInteger(arg.slice("--remote-port=".length), "--remote-port");
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

	const remoteFields = (): ParsedRemoteOptions => {
		const fields: ParsedRemoteOptions = {};
		if (sshTarget) {
			fields.sshTarget = sshTarget;
			fields.remoteMode = remoteMode;
			if (cwd) {
				fields.cwd = cwd;
			}
		}
		if (localPort !== undefined) {
			fields.localPort = localPort;
		}
		if (remoteHost !== undefined) {
			fields.remoteHost = remoteHost;
		}
		if (remotePort !== undefined) {
			fields.remotePort = remotePort;
		}
		return fields;
	};

	const command = positionals[0];
	if (!command || command === "help") {
		return { type: "help" };
	}
	if (command === "fetch" || command === "neofetch") {
		return {
			type: "fetch",
			appUrl,
			workspaceUrl,
			timeoutMs: timeoutMs === defaultTimeoutMs ? 1_500 : timeoutMs,
			color,
			json,
			...remoteFields(),
		};
	}
	if (command === "remote") {
		const subcommand = positionals[1];
		if (!subcommand || subcommand === "status") {
			return {
				type: "remote-status",
				appUrl,
				workspaceUrl,
				timeoutMs: timeoutMs === defaultTimeoutMs ? 1_500 : timeoutMs,
				json,
				pretty,
			};
		}
		if (subcommand === "turn") {
			const action = requiredPositional(positionals, 2, "remote turn requires start");
			if (action !== "start") {
				throw new Error("remote turn currently supports only start");
			}
			return {
				type: "remote-turn-start",
				prompt: prompt ?? requiredPositional(
					positionals,
					3,
					"remote turn start requires --prompt <text> or <text>",
				),
				cwd,
				via,
				appUrl,
				workspaceUrl,
				timeoutMs,
				json,
				pretty,
			};
		}
		if (subcommand === "tunnel") {
			const action = requiredPositional(positionals, 2, "remote tunnel requires start");
			if (action !== "start") {
				throw new Error("remote tunnel currently supports only start");
			}
			return {
				type: "remote-tunnel-start",
				sshTarget,
				localPort,
				remoteHost,
				remotePort,
				dryRun,
				json,
				pretty,
			};
		}
		throw new Error("remote requires status, turn, or tunnel");
	}
	if (command === "automation" || command === "automations") {
		const subcommand = positionals[1];
		if (subcommand === "list" || subcommand === "ls") {
			return {
				type: "automation-list",
				workspaceRoot,
				json,
				pretty,
			};
		}
		if (subcommand !== "run") {
			throw new Error("automation requires run or list");
		}
		return {
			type: "automation-run",
			target: requiredPositional(
				positionals,
				2,
				"automation run requires <script-or-name>",
			),
			eventPath,
			prompt,
			workspaceRoot,
			cwd,
			via,
			appUrl,
			workspaceUrl,
			timeoutMs,
			json,
			pretty,
			...remoteFields(),
		};
	}
	if (command === "app") {
		const subcommand = positionals[1];
		if (!subcommand || subcommand === "actions") {
			return { type: "app-actions" };
		}
		const method = subcommand === "call"
			? requiredPositional(positionals, 2, "app call requires <method>")
			: subcommand;
		const params = subcommand === "call" ? positionals.slice(3) : positionals.slice(2);
		return {
			type: "app-call",
			method: validateMethodName(method, "app method"),
			paramsText: paramsText(params),
			url: appUrl,
			timeoutMs,
			pretty,
			...remoteFields(),
		};
	}
	if (command === "workspace") {
		const subcommand = positionals[1];
		if (!subcommand || subcommand === "methods") {
			return {
				type: "workspace-methods",
				url: workspaceUrl,
				timeoutMs,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "doctor") {
			return {
				type: "workspace-doctor",
				mode,
				workspaceRoot,
				appUrl,
				workspaceUrl,
				timeoutMs: timeoutMs === defaultTimeoutMs ? 1_500 : timeoutMs,
				color,
				json,
				...remoteFields(),
			};
		}
		if (subcommand === "tick") {
			return {
				type: "workspace-tick",
				mode,
				workspaceRoot,
				url: workspaceUrl,
				timeoutMs,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "run") {
			return {
				type: "workspace-run",
				taskId: requiredPositional(positionals, 2, "workspace run requires <task-id>"),
				mode,
				workspaceRoot,
				url: workspaceUrl,
				timeoutMs,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "init") {
			const target = requiredPositional(positionals, 2, "workspace init requires actions");
			if (target !== "actions") {
				throw new Error("workspace init currently supports only actions");
			}
			return {
				type: "workspace-init-actions",
				workspaceRoot,
				forgejo,
				github,
				withSmoke,
				withAgentTurn,
				overwrite,
				pretty,
			};
		}
		if (subcommand === "backend") {
			const backendCommand = requiredPositional(
				positionals,
				2,
				"workspace backend requires init, status, or start",
			);
			if (backendCommand === "init") {
				const target = requiredPositional(
					positionals,
					3,
					"workspace backend init requires local",
				);
				if (target !== "local") {
					throw new Error("workspace backend init currently supports only local");
				}
				return {
					type: "workspace-backend-init-local",
					workspaceRoot,
					overwrite,
					json,
					pretty,
				};
			}
			if (backendCommand === "status") {
				return {
					type: "workspace-backend-status",
					workspaceRoot,
					appUrl,
					workspaceUrl,
					timeoutMs: timeoutMs === defaultTimeoutMs ? 1_500 : timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			if (backendCommand === "start") {
				return {
					type: "workspace-backend-start",
					workspaceRoot,
					dryRun,
					json,
					pretty,
				};
			}
			throw new Error("workspace backend requires init, status, or start");
		}
		if (subcommand === "app") {
			const method = requiredPositional(
				positionals,
				2,
				"workspace app requires <method>",
			);
			return {
				type: "workspace-app-call",
				method: validateMethodName(method, "app method"),
				paramsText: paramsText(positionals.slice(3)),
				url: workspaceUrl,
				timeoutMs,
				pretty,
				...remoteFields(),
			};
		}
		const method = subcommand === "call"
			? requiredPositional(positionals, 2, "workspace call requires <method>")
			: subcommand;
		const params = subcommand === "call" ? positionals.slice(3) : positionals.slice(2);
		return {
			type: "workspace-call",
			method: validateMethodName(method, "workspace method"),
			paramsText: paramsText(params),
			url: workspaceUrl,
			timeoutMs,
			pretty,
			...remoteFields(),
		};
	}
	if (command === "flow") {
		const subcommand = positionals[1];
		if (subcommand === "dispatch") {
			return {
				type: "flow-dispatch",
				eventPath: eventPath ?? requiredPositional(
					positionals,
					2,
					"flow dispatch requires --event <path> or <path>",
				),
				url: workspaceUrl,
				timeoutMs,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "events" || subcommand === "list-events") {
			return {
				type: "flow-list-events",
				eventType,
				limit,
				url: workspaceUrl,
				timeoutMs,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "event" || subcommand === "show-event") {
			return {
				type: "flow-get-event",
				eventId: eventId ?? requiredPositional(
					positionals,
					2,
					"flow event requires <event-id>",
				),
				url: workspaceUrl,
				timeoutMs,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "replay" || subcommand === "replay-event") {
			return {
				type: "flow-replay",
				eventId: eventId ?? requiredPositional(
					positionals,
					2,
					"flow replay requires <event-id>",
				),
				wait,
				url: workspaceUrl,
				timeoutMs,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "runs" || subcommand === "list-runs") {
			return {
				type: "flow-list-runs",
				eventId,
				status,
				limit,
				url: workspaceUrl,
				timeoutMs,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "run" || subcommand === "show-run") {
			return {
				type: "flow-get-run",
				runId: runId ?? requiredPositional(
					positionals,
					2,
					"flow run requires <run-id>",
				),
				url: workspaceUrl,
				timeoutMs,
				pretty,
				...remoteFields(),
			};
		}
		throw new Error("flow requires dispatch, events, event, replay, runs, or run");
	}
	if (command === "actions") {
		const subcommand = positionals[1];
		if (subcommand === "prepare-auth") {
			return { type: "actions-prepare-auth", workspaceRoot, pretty };
		}
		if (subcommand === "cleanup") {
			return { type: "actions-cleanup", workspaceRoot, pretty };
		}
		if (subcommand === "dispatch") {
			return {
				type: "actions-dispatch",
				workspaceRoot,
				eventPath: eventPath ?? requiredPositional(
					positionals,
					2,
					"actions dispatch requires --event <path> or <path>",
				),
				pretty,
			};
		}
		if (subcommand === "assert-run") {
			return {
				type: "actions-assert-run",
				workspaceRoot,
				flowName: flowName ?? requiredPositional(
					positionals,
					2,
					"actions assert-run requires --flow <name>",
				),
				stepName: stepName ?? requiredPositional(
					positionals,
					3,
					"actions assert-run requires --step <name>",
				),
				artifactText,
				pretty,
			};
		}
		throw new Error("actions requires prepare-auth, cleanup, dispatch, or assert-run");
	}
	if (command === "memories") {
		const subcommand = positionals[1];
		if (subcommand !== "transplant") {
			throw new Error("memories requires transplant");
		}
		const direction = requiredPositional(positionals, 2, "memories transplant requires a direction");
		if (direction !== "global-to-workspace" && direction !== "workspace-to-global") {
			throw new Error(`Invalid memories transplant direction: ${direction}`);
		}
		return {
			type: "memories-transplant",
			direction,
			workspaceRoot,
			globalCodexHome,
			workspaceCodexHome,
			apply,
			overwrite,
			merge,
			backup,
			json,
		};
	}
	if (command === "threads") {
		const subcommand = positionals[1];
		if (subcommand === "locate") {
			return {
				type: "threads-locate",
				threadId: requiredPositional(positionals, 2, "threads locate requires <thread-id>"),
				codexHome,
				json,
			};
		}
		if (subcommand === "inspect") {
			return {
				type: "threads-inspect",
				threadIdOrPath: requiredPositional(
					positionals,
					2,
					"threads inspect requires <thread-id-or-rollout-path>",
				),
				codexHome,
				json,
			};
		}
		if (subcommand === "install-rollout") {
			return {
				type: "threads-install-rollout",
				rolloutPath: requiredPositional(
					positionals,
					2,
					"threads install-rollout requires <rollout.jsonl>",
				),
				codexHome,
				replace,
				json,
			};
		}
		if (subcommand === "transplant") {
			return {
				type: "threads-transplant",
				threadId: requiredPositional(positionals, 2, "threads transplant requires <thread-id>"),
				fromCodexHome,
				toCodexHome: toCodexHome ?? requiredPositional(
					positionals,
					3,
					"threads transplant requires --to-codex-home <home>",
				),
				replace,
				json,
			};
		}
		throw new Error("threads requires locate, inspect, install-rollout, or transplant");
	}
	if (command === "pack") {
		const subcommand = positionals[1];
		if (subcommand === "inspect") {
			return {
				type: "pack-inspect",
				source: requiredPositional(positionals, 2, "pack inspect requires <source>"),
				ref,
				json,
			};
		}
		if (subcommand === "add") {
			return {
				type: "pack-add",
				source: requiredPositional(positionals, 2, "pack add requires <source>"),
				ref,
				workspaceRoot,
				apply,
				overwrite,
				include,
				exclude,
				json,
			};
		}
		if (subcommand === "doctor") {
			return {
				type: "pack-doctor",
				workspaceRoot,
				json,
			};
		}
		if (subcommand === "list") {
			return {
				type: "pack-list",
				workspaceRoot,
				json,
			};
		}
		throw new Error("pack requires inspect, add, doctor, or list");
	}
	throw new Error(`Unknown command: ${command}`);
}

function paramsText(values: string[]): string | undefined {
	return values.length > 0 ? values.join(" ") : undefined;
}

function parseRemoteVia(value: string): "auto" | "workspace" | "app" {
	if (value === "auto" || value === "workspace" || value === "app") {
		return value;
	}
	throw new Error("--via must be auto, workspace, or app");
}

function required(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function requiredPositional(args: string[], index: number, message: string): string {
	const value = args[index];
	if (!value) {
		throw new Error(message);
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
