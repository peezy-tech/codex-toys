import { validateMethodName } from "./actions.ts";
import { parseMode, type WorkspaceModeInput } from "./workspace-autonomy.ts";
import type { MemoryTransplantDirection } from "./memories.ts";

export type ParsedRemoteOptions = {
	sshTarget?: string;
	cwd?: string;
	remotePathPrepend?: string;
	remoteAgentCommand?: string;
	remoteCodexCommand?: string;
	remoteCodexArgs?: string[];
};

export type RemoteTurnApprovalPolicy =
	| "never"
	| "on-failure"
	| "on-request"
	| "untrusted";

export type RemoteTurnSandbox =
	| "danger-full-access"
	| "read-only"
	| "workspace-write";

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
				type: "remote-preflight";
				cwd?: string;
				timeoutMs: number;
				json: boolean;
				pretty: boolean;
		  }
		| {
				type: "remote-turn-start";
				prompt: string;
				threadId?: string;
				cwd?: string;
				via: "workspace" | "app";
				appUrl: string;
				workspaceUrl: string;
				timeoutMs: number;
				wait: boolean;
				sandbox?: RemoteTurnSandbox;
				approvalPolicy?: RemoteTurnApprovalPolicy;
				permissions?: string;
				model?: string;
				json: boolean;
				pretty: boolean;
		  }
		| {
				type: "remote-agent-serve";
				cwd?: string;
				timeoutMs: number;
		  }
	| {
			type: "automation-run";
			target: string;
			eventPath?: string;
			prompt?: string;
			workspaceRoot?: string;
			cwd?: string;
			via: "workspace" | "app";
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
				type: "turn-run";
				prompt: string;
				threadId?: string;
				cwd?: string;
				appUrl: string;
				workspaceUrl: string;
				timeoutMs: number;
				wait: boolean;
				sandbox?: RemoteTurnSandbox;
				approvalPolicy?: RemoteTurnApprovalPolicy;
				permissions?: string;
				model?: string;
				json: boolean;
				pretty: boolean;
		  }
		| {
				type: "app-call";
				method: string;
				paramsText?: string;
				paramsFile?: string;
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
			overwrite: boolean;
			pretty: boolean;
	  }
	| {
			type: "workspace-backend-init-local";
			workspaceRoot?: string;
			codexHome?: string;
			profile?: string;
			globalProfile: boolean;
			overwrite: boolean;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workspace-backend-status";
			workspaceRoot?: string;
			profile?: string;
			appUrl: string;
			workspaceUrl: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workspace-backend-start";
			workspaceRoot?: string;
			profile?: string;
			dryRun: boolean;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workspace-backend-service-install";
			profile?: string;
			dryRun: boolean;
			overwrite: boolean;
			json: boolean;
			pretty: boolean;
	  }
		| {
				type: "workspace-call";
				method: string;
				paramsText?: string;
				paramsFile?: string;
				url: string;
				timeoutMs: number;
				pretty: boolean;
		  }
		| {
				type: "workspace-app-call";
				method: string;
				paramsText?: string;
				paramsFile?: string;
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
	let mode: WorkspaceModeInput | undefined;
	let workspaceRoot: string | undefined;
	let backendProfile: string | undefined;
	let globalBackendProfile = false;
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
	let dryRun = false;
	let prompt: string | undefined;
	let threadId: string | undefined;
	let wait = false;
	let model: string | undefined;
	let paramsJson: string | undefined;
	let paramsFile: string | undefined;
	let cwd: string | undefined = env.CODEX_FLOWS_REMOTE_CWD;
	let via: "workspace" | "app" = "workspace";
	let sshTarget: string | undefined = env.CODEX_FLOWS_REMOTE_SSH_TARGET;
	let remotePathPrepend: string | undefined = env.CODEX_FLOWS_REMOTE_PATH_PREPEND;
	let remoteAgentCommand: string | undefined;
	let remoteCodexCommand: string | undefined;
	const remoteCodexArgs: string[] = [];
	let sandbox: RemoteTurnSandbox | undefined;
	let approvalPolicy: RemoteTurnApprovalPolicy | undefined;
	let permissions: string | undefined;
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
			if (arg === "--params-json") {
				paramsJson = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--params-json=")) {
				paramsJson = arg.slice("--params-json=".length);
				continue;
			}
			if (arg === "--params-file") {
				paramsFile = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--params-file=")) {
				paramsFile = arg.slice("--params-file=".length);
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
		if (arg === "--profile" || arg === "--name") {
			backendProfile = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--profile=")) {
			backendProfile = arg.slice("--profile=".length);
			continue;
		}
		if (arg.startsWith("--name=")) {
			backendProfile = arg.slice("--name=".length);
			continue;
		}
		if (arg === "--global") {
			globalBackendProfile = true;
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
		if (arg === "--forgejo") {
			forgejo = true;
			continue;
		}
		if (arg === "--github") {
			github = true;
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
			if (arg === "--thread-id") {
				threadId = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--thread-id=")) {
				threadId = arg.slice("--thread-id=".length);
				continue;
			}
			if (arg === "--wait") {
				wait = true;
				continue;
			}
			if (arg === "--model") {
				model = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--model=")) {
				model = arg.slice("--model=".length);
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
		if (arg === "--sandbox") {
			sandbox = parseRemoteTurnSandbox(required(argv, ++index, arg));
			continue;
		}
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseRemoteTurnSandbox(arg.slice("--sandbox=".length));
			continue;
		}
		if (arg === "--approval-policy") {
			approvalPolicy = parseRemoteTurnApprovalPolicy(required(argv, ++index, arg));
			continue;
		}
		if (arg.startsWith("--approval-policy=")) {
			approvalPolicy = parseRemoteTurnApprovalPolicy(
				arg.slice("--approval-policy=".length),
			);
			continue;
		}
		if (arg === "--permissions") {
			permissions = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--permissions=")) {
			permissions = arg.slice("--permissions=".length);
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
		if (arg === "--remote-path-prepend") {
			remotePathPrepend = required(argv, ++index, arg);
			continue;
		}
			if (arg.startsWith("--remote-path-prepend=")) {
				remotePathPrepend = arg.slice("--remote-path-prepend=".length);
				continue;
			}
			if (arg === "--remote-agent-command") {
				remoteAgentCommand = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--remote-agent-command=")) {
				remoteAgentCommand = arg.slice("--remote-agent-command=".length);
				continue;
			}
			if (arg === "--remote-codex-command") {
				remoteCodexCommand = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--remote-codex-command=")) {
				remoteCodexCommand = arg.slice("--remote-codex-command=".length);
				continue;
			}
			if (arg === "--remote-codex-arg") {
				remoteCodexArgs.push(required(argv, ++index, arg));
				continue;
			}
			if (arg.startsWith("--remote-codex-arg=")) {
				remoteCodexArgs.push(arg.slice("--remote-codex-arg=".length));
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
			if (cwd) {
				fields.cwd = cwd;
			}
		}
			if (remotePathPrepend !== undefined) {
				fields.remotePathPrepend = remotePathPrepend;
			}
			if (remoteAgentCommand !== undefined) {
				fields.remoteAgentCommand = remoteAgentCommand;
			}
			if (remoteCodexCommand !== undefined) {
				fields.remoteCodexCommand = remoteCodexCommand;
			}
			if (remoteCodexArgs.length > 0) {
				fields.remoteCodexArgs = remoteCodexArgs;
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
			if (subcommand === "preflight") {
				return {
					type: "remote-preflight",
					cwd,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
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
					threadId,
					cwd,
					via,
					appUrl,
					workspaceUrl,
					timeoutMs,
					wait,
					sandbox,
					approvalPolicy,
					permissions,
					model,
					json,
					pretty,
					...remoteFields(),
				};
		}
			if (subcommand === "agent" || subcommand === "remote-agent") {
				const action = requiredPositional(positionals, 2, "remote agent requires serve");
				if (action !== "serve") {
					throw new Error("remote agent currently supports only serve");
				}
				return {
					type: "remote-agent-serve",
					cwd,
					timeoutMs,
					...remoteFields(),
				};
			}
			throw new Error("remote requires status, preflight, turn, or agent");
		}
		if (command === "remote-agent") {
			const subcommand = requiredPositional(positionals, 1, "remote-agent requires serve");
			if (subcommand !== "serve") {
				throw new Error("remote-agent currently supports only serve");
			}
			return {
				type: "remote-agent-serve",
				cwd,
				timeoutMs,
				...remoteFields(),
			};
		}
		if (command === "turn") {
			const subcommand = positionals[1];
			if (subcommand !== "run") {
				throw new Error("turn requires run");
			}
			return {
				type: "turn-run",
				prompt: prompt ?? requiredPositional(
					positionals,
					2,
					"turn run requires <prompt> or --prompt <text>",
				),
				threadId,
				cwd,
				appUrl,
				workspaceUrl,
				timeoutMs,
				wait,
				sandbox,
				approvalPolicy,
				permissions,
				model,
				json,
				pretty,
				...remoteFields(),
			};
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
			target: requiredPositional(positionals, 2, "automation run requires <name>"),
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
				...paramsSource(params, paramsJson, paramsFile),
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
					codexHome,
					profile: backendProfile,
					globalProfile: globalBackendProfile,
					overwrite,
					json,
					pretty,
				};
			}
			if (backendCommand === "status") {
				return {
					type: "workspace-backend-status",
					workspaceRoot,
					profile: backendProfile,
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
					profile: backendProfile,
					dryRun,
					json,
					pretty,
				};
			}
			if (backendCommand === "service") {
				const serviceCommand = requiredPositional(
					positionals,
					3,
					"workspace backend service requires install",
				);
				if (serviceCommand !== "install") {
					throw new Error("workspace backend service currently supports only install");
				}
				return {
					type: "workspace-backend-service-install",
					profile: backendProfile,
					dryRun,
					overwrite,
					json,
					pretty,
				};
			}
			if (backendCommand === "install-service") {
				return {
					type: "workspace-backend-service-install",
					profile: backendProfile,
					dryRun,
					overwrite,
					json,
					pretty,
				};
			}
			throw new Error("workspace backend requires init, status, start, or service");
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
					...paramsSource(positionals.slice(3), paramsJson, paramsFile),
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
				...paramsSource(params, paramsJson, paramsFile),
				url: workspaceUrl,
				timeoutMs,
				pretty,
			...remoteFields(),
		};
	}
	if (command === "actions") {
		const subcommand = positionals[1];
		if (subcommand === "prepare-auth") {
			return { type: "actions-prepare-auth", workspaceRoot, pretty };
		}
		if (subcommand === "cleanup") {
			return { type: "actions-cleanup", workspaceRoot, pretty };
		}
		throw new Error("actions requires prepare-auth or cleanup");
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

function paramsSource(
	values: string[],
	paramsJson: string | undefined,
	paramsFile: string | undefined,
): { paramsText?: string; paramsFile?: string } {
	const positional = paramsText(values);
	if (paramsJson !== undefined && paramsFile !== undefined) {
		throw new Error("--params-json cannot be combined with --params-file");
	}
	if (positional !== undefined && (paramsJson !== undefined || paramsFile !== undefined)) {
		throw new Error("inline JSON params cannot be combined with --params-json or --params-file");
	}
	if (paramsJson !== undefined) {
		return { paramsText: paramsJson };
	}
	if (paramsFile !== undefined) {
		return { paramsFile };
	}
	return positional === undefined ? {} : { paramsText: positional };
}

function parseRemoteVia(value: string): "workspace" | "app" {
	if (value === "workspace" || value === "app") {
		return value;
	}
	throw new Error("--via must be workspace or app");
}

function parseRemoteTurnSandbox(value: string): RemoteTurnSandbox {
	if (
		value === "danger-full-access" ||
		value === "read-only" ||
		value === "workspace-write"
	) {
		return value;
	}
	throw new Error("--sandbox must be danger-full-access, workspace-write, or read-only");
}

function parseRemoteTurnApprovalPolicy(value: string): RemoteTurnApprovalPolicy {
	if (
		value === "never" ||
		value === "on-failure" ||
		value === "on-request" ||
		value === "untrusted"
	) {
		return value;
	}
	throw new Error("--approval-policy must be never, on-failure, on-request, or untrusted");
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
