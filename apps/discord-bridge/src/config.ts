import os from "node:os";
import path from "node:path";

import type {
	ReasoningEffort,
	ReasoningSummary,
	v2,
} from "@peezy.tech/codex-flows/generated";

import type {
	DiscordBridgeConfig,
	DiscordConsoleOutputMode,
	DiscordProgressMode,
} from "./types.ts";
import type { DiscordBridgeLogLevelSetting } from "./logger.ts";

export type ParsedConfig =
	| {
			type: "run";
			discordToken: string;
			appServerUrl?: string;
			localAppServer?: boolean;
			config: DiscordBridgeConfig;
	  }
	| { type: "help"; text: string };

const effortValues = new Set<ReasoningEffort>([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);
const summaryValues = new Set<ReasoningSummary>([
	"auto",
	"concise",
	"detailed",
	"none",
]);
const progressModeValues = new Set<DiscordProgressMode>([
	"summary",
	"commentary",
	"none",
]);
const consoleOutputValues = new Set<DiscordConsoleOutputMode>([
	"messages",
	"none",
]);
const logLevelValues = new Set<DiscordBridgeLogLevelSetting>([
	"debug",
	"info",
	"warn",
	"error",
	"silent",
]);
const approvalPolicyValues = new Set<string>([
	"untrusted",
	"on-failure",
	"on-request",
	"never",
]);
const sandboxValues = new Set<v2.SandboxMode>([
	"read-only",
	"workspace-write",
	"danger-full-access",
]);

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv): ParsedConfig {
	const args = parseFlags(argv);
	if (args.has("help") || args.has("h")) {
		return { type: "help", text: helpText() };
	}
	const discordToken = stringFlag(args, "token") ?? env.CODEX_DISCORD_BOT_TOKEN;
	if (!discordToken) {
		throw new Error("Missing Discord bot token. Set CODEX_DISCORD_BOT_TOKEN or pass --token.");
	}
	const allowedUserIds = csvSet(
		stringFlag(args, "allowed-user-ids") ?? env.CODEX_DISCORD_ALLOWED_USER_IDS,
	);
	if (allowedUserIds.size === 0) {
		throw new Error(
			"Missing allowed Discord users. Set CODEX_DISCORD_ALLOWED_USER_IDS or pass --allowed-user-ids.",
		);
	}
	const explicitAppServerUrl =
		stringFlag(args, "app-server-url") ??
		stringFlag(args, "url");
	const localAppServer = booleanFlag(args, "local-app-server");
	if (localAppServer && explicitAppServerUrl) {
		throw new Error("Cannot set both --local-app-server and --app-server-url.");
	}
	const appServerUrl = localAppServer
		? undefined
		: explicitAppServerUrl ?? env.CODEX_WORKSPACE_APP_SERVER_WS_URL;
	const statePath =
		stringFlag(args, "state-path") ??
		env.CODEX_DISCORD_STATE_PATH ??
		path.join(os.homedir(), ".codex", "discord-bridge", "state.json");
	const permissionsProfile = stringFlag(args, "permissions-profile") ??
		env.CODEX_DISCORD_PERMISSIONS_PROFILE;
	const approvalPolicy = optionalApprovalPolicy(
		stringFlag(args, "approval-policy") ?? env.CODEX_DISCORD_APPROVAL_POLICY,
	);
	const sandbox = optionalSandbox(
		stringFlag(args, "sandbox") ?? env.CODEX_DISCORD_SANDBOX,
	);
	if (sandbox && permissionsProfile) {
		throw new Error("Cannot set both --sandbox and --permissions-profile.");
	}
	const debug = booleanFlag(args, "debug") || envFlag(env.CODEX_DISCORD_DEBUG);
	const logLevel = optionalLogLevel(
		stringFlag(args, "log-level") ?? env.CODEX_DISCORD_LOG_LEVEL,
	) ?? (debug ? "debug" : undefined);

	return {
		type: "run",
		discordToken,
		appServerUrl,
		localAppServer,
		config: {
			allowedUserIds,
			allowedChannelIds: csvSet(
				stringFlag(args, "allowed-channel-ids") ??
					env.CODEX_DISCORD_ALLOWED_CHANNEL_IDS,
			),
			statePath,
			cwd: resolveHomeDir(
				stringFlag(args, "dir") ??
					stringFlag(args, "positional-dir") ??
					env.CODEX_DISCORD_DIR ??
					stringFlag(args, "cwd") ??
					env.CODEX_DISCORD_CWD,
			),
			model: stringFlag(args, "model") ?? env.CODEX_DISCORD_MODEL,
			modelProvider:
				stringFlag(args, "model-provider") ??
				env.CODEX_DISCORD_MODEL_PROVIDER,
			serviceTier:
				stringFlag(args, "service-tier") ?? env.CODEX_DISCORD_SERVICE_TIER,
			effort: optionalEffort(
				stringFlag(args, "effort") ?? env.CODEX_DISCORD_EFFORT,
			),
			summary: optionalSummary(
				stringFlag(args, "summary") ??
					env.CODEX_DISCORD_REASONING_SUMMARY ??
					"auto",
			),
			progressMode: optionalProgressMode(
				stringFlag(args, "progress-mode") ??
					env.CODEX_DISCORD_PROGRESS_MODE ??
					"summary",
			),
			consoleOutput: optionalConsoleOutput(
				stringFlag(args, "console-output") ??
					env.CODEX_DISCORD_CONSOLE_OUTPUT,
			),
			logLevel,
			approvalPolicy,
			sandbox,
			permissions: permissionsProfile
				? { type: "profile", id: permissionsProfile }
				: undefined,
			debug,
		},
	};
}

function parseFlags(argv: string[]): Map<string, string | boolean> {
	const flags = new Map<string, string | boolean>();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg?.startsWith("--")) {
			if (flags.has("positional-dir")) {
				throw new Error(`Unexpected argument: ${arg ?? ""}`);
			}
			flags.set("positional-dir", arg ?? "");
			continue;
		}
		const [rawName, inlineValue] = arg.slice(2).split("=", 2);
		if (!rawName) {
			throw new Error(`Invalid flag: ${arg}`);
		}
		if (inlineValue !== undefined) {
			flags.set(rawName, inlineValue);
			continue;
		}
		if (booleanFlagNames.has(rawName)) {
			flags.set(rawName, true);
			continue;
		}
		const next = argv[index + 1];
		if (!next || next.startsWith("--")) {
			flags.set(rawName, true);
			continue;
		}
		flags.set(rawName, next);
		index += 1;
	}
	if (
		flags.has("positional-dir") &&
		(flags.has("dir") || flags.has("cwd"))
	) {
		throw new Error("Cannot set both positional directory and --dir/--cwd.");
	}
	return flags;
}

const booleanFlagNames = new Set(["debug", "help", "h", "local-app-server"]);

function stringFlag(
	flags: Map<string, string | boolean>,
	name: string,
): string | undefined {
	const value = flags.get(name);
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function csvSet(value: string | undefined): Set<string> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean),
	);
}

function booleanFlag(flags: Map<string, string | boolean>, name: string): boolean {
	const value = flags.get(name);
	if (value === true) {
		return true;
	}
	return envFlag(typeof value === "string" ? value : undefined);
}

function envFlag(value: string | undefined): boolean {
	return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function optionalEffort(value: string | undefined): ReasoningEffort | undefined {
	if (!value) {
		return undefined;
	}
	if (!effortValues.has(value as ReasoningEffort)) {
		throw new Error("Invalid effort. Expected none, minimal, low, medium, high, or xhigh.");
	}
	return value as ReasoningEffort;
}

function optionalSummary(value: string | undefined): ReasoningSummary | undefined {
	if (!value) {
		return undefined;
	}
	if (!summaryValues.has(value as ReasoningSummary)) {
		throw new Error("Invalid summary. Expected auto, concise, detailed, or none.");
	}
	return value as ReasoningSummary;
}

function optionalProgressMode(value: string | undefined): DiscordProgressMode | undefined {
	if (!value) {
		return undefined;
	}
	if (!progressModeValues.has(value as DiscordProgressMode)) {
		throw new Error("Invalid progress mode. Expected summary, commentary, or none.");
	}
	return value as DiscordProgressMode;
}

function optionalConsoleOutput(
	value: string | undefined,
): DiscordConsoleOutputMode | undefined {
	if (!value) {
		return undefined;
	}
	if (!consoleOutputValues.has(value as DiscordConsoleOutputMode)) {
		throw new Error("Invalid console output. Expected messages or none.");
	}
	return value as DiscordConsoleOutputMode;
}

function optionalLogLevel(
	value: string | undefined,
): DiscordBridgeLogLevelSetting | undefined {
	if (!value) {
		return undefined;
	}
	if (!logLevelValues.has(value as DiscordBridgeLogLevelSetting)) {
		throw new Error("Invalid log level. Expected debug, info, warn, error, or silent.");
	}
	return value as DiscordBridgeLogLevelSetting;
}

function optionalApprovalPolicy(
	value: string | undefined,
): v2.AskForApproval | undefined {
	if (!value) {
		return undefined;
	}
	if (!approvalPolicyValues.has(value)) {
		throw new Error(
			"Invalid approval policy. Expected untrusted, on-failure, on-request, or never.",
		);
	}
	return value as v2.AskForApproval;
}

function optionalSandbox(value: string | undefined): v2.SandboxMode | undefined {
	if (!value) {
		return undefined;
	}
	if (!sandboxValues.has(value as v2.SandboxMode)) {
		throw new Error(
			"Invalid sandbox. Expected read-only, workspace-write, or danger-full-access.",
		);
	}
	return value as v2.SandboxMode;
}

function helpText(): string {
	return `codex-discord-bridge connects Discord threads to Codex app-server threads.

Usage:
  codex-discord-bridge [options] [dir]

Required:
  --token <token>                 Discord bot token, or CODEX_DISCORD_BOT_TOKEN
  --allowed-user-ids <ids>        Comma-separated Discord user ids, or CODEX_DISCORD_ALLOWED_USER_IDS

Options:
  --app-server-url <url>          Existing app-server WebSocket URL
  --local-app-server              Start a local app-server over stdio
  --state-path <path>             Persistent bridge state file
  --allowed-channel-ids <ids>     Comma-separated parent channel ids
  [dir]                           Optional Codex thread directory, resolved from home
  --dir <path>                    Codex thread directory, resolved from home
  --cwd <path>                    Alias for --dir
  --model <model>                 Codex model override
  --model-provider <provider>     Codex model provider override
  --service-tier <tier>           Codex service tier override
  --effort <effort>               none|minimal|low|medium|high|xhigh
  --summary <summary>             auto|concise|detailed|none
  --progress-mode <mode>          summary|commentary|none
  --console-output <mode>         messages|none
  --log-level <level>             debug|info|warn|error|silent
  --approval-policy <policy>      untrusted|on-failure|on-request|never
  --sandbox <mode>                read-only|workspace-write|danger-full-access
  --permissions-profile <id>      Named Codex permissions profile
  --debug                         Emit verbose bridge diagnostics to stderr
  --help                          Show this help
`;
}

function resolveHomeDir(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	if (value === "~") {
		return os.homedir();
	}
	if (value.startsWith("~/")) {
		return path.join(os.homedir(), value.slice(2));
	}
	if (path.isAbsolute(value)) {
		return value;
	}
	return path.join(os.homedir(), value);
}
