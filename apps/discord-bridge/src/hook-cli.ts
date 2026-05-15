import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeHookSpoolEvent } from "./stop-hook-spool.ts";

const defaultHookCommand = "codex-discord-bridge hook event";
const defaultBunxPackage = "codex-discord-bridge";
const gatewayHookEvents = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"Stop",
] as const;

export type HookInstallOptions = {
	command?: string;
	useBunx?: boolean;
	bunxPackage?: string;
	configPath?: string;
	hooksPath?: string;
	dryRun?: boolean;
};

export type HookInstallResult = {
	command: string;
	configPath: string;
	hooksPath: string;
	dryRun: boolean;
};

export async function handleHookCommand(argv: string[]): Promise<boolean> {
	if (argv[0] !== "hook") {
		return false;
	}
	const subcommand = argv[1] ?? "help";
	if (subcommand === "event" || subcommand === "stop") {
		await runHookEvent();
		return true;
	}
	if (subcommand === "install") {
		const result = await installStopHook(parseInstallArgs(argv.slice(2)));
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return true;
	}
	if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
		process.stdout.write(hookHelpText());
		return true;
	}
	throw new Error(`Unknown hook subcommand: ${subcommand}`);
}

export async function runHookEvent(): Promise<void> {
	let input = "";
	try {
		input = await new Response(Bun.stdin.stream()).text();
		const parsed = JSON.parse(input);
		const event = await writeHookSpoolEvent(parsed);
		if (eventSupportsContinueOutput(event.eventName)) {
			process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
		}
	} catch (error) {
		process.stderr.write(`discord gateway hook failed: ${errorMessage(error)}\n`);
		if (eventSupportsContinueOutput(eventNameFromHookInput(input))) {
			process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
		}
	}
}

export const runStopHook = runHookEvent;

export async function installStopHook(
	options: HookInstallOptions = {},
): Promise<HookInstallResult> {
	const configPath = path.resolve(
		expandHome(options.configPath ?? path.join(os.homedir(), ".codex", "config.toml")),
	);
	const hooksPath = path.resolve(
		expandHome(options.hooksPath ?? path.join(os.homedir(), ".codex", "hooks.json")),
	);
	const command = hookCommand(options);
	if (!options.dryRun) {
		const configText = await readTextIfExists(configPath);
		const hooksText = await readTextIfExists(hooksPath);
		await mkdir(path.dirname(configPath), { recursive: true });
		await mkdir(path.dirname(hooksPath), { recursive: true });
		await writeFile(configPath, enableHooksFeature(configText));
		await writeFile(hooksPath, `${JSON.stringify(upsertStopHookConfig(hooksText, command), null, 2)}\n`);
	}
	return {
		command,
		configPath,
		hooksPath,
		dryRun: Boolean(options.dryRun),
	};
}

export function enableHooksFeature(configText: string): string {
	const lines = configText.replace(/\s*$/, "").split(/\r?\n/);
	if (lines.length === 1 && lines[0] === "") {
		return "[features]\nhooks = true\n";
	}
	const featureHeaderIndex = lines.findIndex((line) => line.trim() === "[features]");
	if (featureHeaderIndex < 0) {
		return `${lines.join("\n")}\n\n[features]\nhooks = true\n`;
	}
	let insertIndex = featureHeaderIndex + 1;
	while (insertIndex < lines.length && !lines[insertIndex]?.trim().startsWith("[")) {
		const line = lines[insertIndex] ?? "";
		if (/^\s*hooks\s*=/.test(line)) {
			lines[insertIndex] = "hooks = true";
			return `${lines.join("\n")}\n`;
		}
		insertIndex += 1;
	}
	lines.splice(featureHeaderIndex + 1, 0, "hooks = true");
	return `${lines.join("\n")}\n`;
}

export function upsertStopHookConfig(
	hooksText: string,
	command: string,
): Record<string, unknown> {
	const config = parseHooksJson(hooksText);
	const hooks = record(config.hooks);
	for (const eventName of gatewayHookEvents) {
		const groups = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
		hooks[eventName] = [
			hookGroup(command),
			...groups
				.map(removeGatewayStopHookHandlers)
				.filter((group): group is Record<string, unknown> => group !== undefined),
		];
	}
	config.hooks = hooks;
	return config;
}

function parseInstallArgs(argv: string[]): HookInstallOptions {
	const options: HookInstallOptions = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) {
			continue;
		}
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--bunx") {
			options.useBunx = true;
			continue;
		}
		if (arg === "--command") {
			options.command = requiredNext(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--command=")) {
			options.command = arg.slice("--command=".length);
			continue;
		}
		if (arg === "--bunx-package") {
			options.useBunx = true;
			options.bunxPackage = requiredNext(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--bunx-package=")) {
			options.useBunx = true;
			options.bunxPackage = arg.slice("--bunx-package=".length);
			continue;
		}
		if (arg === "--config-path") {
			options.configPath = requiredNext(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--config-path=")) {
			options.configPath = arg.slice("--config-path=".length);
			continue;
		}
		if (arg === "--hooks-path") {
			options.hooksPath = requiredNext(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--hooks-path=")) {
			options.hooksPath = arg.slice("--hooks-path=".length);
			continue;
		}
		throw new Error(`Unknown hook install option: ${arg}`);
	}
	return options;
}

function hookCommand(options: HookInstallOptions): string {
	if (options.command && options.useBunx) {
		throw new Error("Cannot set both --command and --bunx.");
	}
	if (options.command) {
		return options.command;
	}
	if (options.useBunx || options.bunxPackage) {
		return `bunx --package ${options.bunxPackage ?? defaultBunxPackage} ${defaultHookCommand}`;
	}
	return defaultHookCommand;
}

function hookGroup(command: string): Record<string, unknown> {
	return {
		hooks: [
			{
				type: "command",
				command,
				timeout: 10,
			},
		],
	};
}

function removeGatewayStopHookHandlers(input: unknown): Record<string, unknown> | undefined {
	const group = record(input);
	const handlers = Array.isArray(group.hooks)
		? group.hooks.filter((handler) => !isGatewayStopHookHandler(handler))
		: [];
	if (handlers.length === 0) {
		return undefined;
	}
	return { ...group, hooks: handlers };
}

function isGatewayStopHookHandler(input: unknown): boolean {
	const handler = record(input);
	const command = typeof handler.command === "string" ? handler.command : "";
	return command.includes("codex-discord-bridge hook stop") ||
		command.includes("codex-discord-bridge hook event") ||
		command.includes("codex-discord-gateway-stop-hook") ||
		command.includes("apps/discord-bridge/src/stop-hook.ts");
}

function eventSupportsContinueOutput(eventName: string): boolean {
	return eventName === "SessionStart" ||
		eventName === "UserPromptSubmit" ||
		eventName === "Stop";
}

function eventNameFromHookInput(input: string): string {
	try {
		const parsed = record(JSON.parse(input));
		return typeof parsed.hook_event_name === "string"
			? parsed.hook_event_name
			: typeof parsed.eventName === "string"
			? parsed.eventName
			: "";
	} catch {
		return "";
	}
}

async function readTextIfExists(filePath: string): Promise<string> {
	try {
		return await readFile(filePath, "utf8");
	} catch (error) {
		const code = error instanceof Error && "code" in error
			? String((error as NodeJS.ErrnoException).code)
			: "";
		if (code === "ENOENT") {
			return "";
		}
		throw error;
	}
}

function parseHooksJson(text: string): Record<string, unknown> {
	if (!text.trim()) {
		return {};
	}
	try {
		return record(JSON.parse(text));
	} catch (error) {
		throw new Error(`Failed to parse hooks.json: ${errorMessage(error)}`);
	}
}

function expandHome(value: string): string {
	if (value === "~") {
		return os.homedir();
	}
	if (value.startsWith("~/")) {
		return path.join(os.homedir(), value.slice(2));
	}
	return value;
}

function requiredNext(argv: string[], index: number, flag: string): string {
	const value = argv[index];
	if (!value) {
		throw new Error(`${flag} requires a value.`);
	}
	return value;
}

function hookHelpText(): string {
	return `codex-discord-bridge hook manages the global Codex observability hooks.

Usage:
  codex-discord-bridge hook install [options]
  codex-discord-bridge hook event

Options:
  --command <cmd>          Hook command to write. Defaults to "codex-discord-bridge hook event".
  --bunx                  Write a bunx command instead of the global binary command.
  --bunx-package <pkg>    Package for bunx --package. Defaults to codex-discord-bridge.
  --config-path <path>    Codex config.toml path.
  --hooks-path <path>     Codex hooks.json path.
  --dry-run               Print the planned install result without writing files.
`;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
