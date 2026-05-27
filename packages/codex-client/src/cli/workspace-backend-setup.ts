import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { parseJsonText } from "./json.ts";
import type { WorkspaceContext } from "./workspace-autonomy.ts";

export const LOCAL_BACKEND_ENV_RELATIVE_PATH = ".codex/workspace/backend.local.env";
const defaultBackendCommand = "codex-workspace-backend-local";
const setupKeys = [
	"CODEX_WORKSPACE_BACKEND_HOST",
	"CODEX_WORKSPACE_BACKEND_PORT",
	"CODEX_WORKSPACE_BACKEND_LOCAL_APP_SERVER",
	"CODEX_WORKSPACE_BACKEND_APP_SERVER_URL",
	"CODEX_WORKSPACE_BACKEND_WS_URL",
	"CODEX_FLOWS_HOOK_SPOOL_DIR",
] as const;

type SetupKey = typeof setupKeys[number];

export type WorkspaceBackendInitLocalResult = {
	workspaceRoot: string;
	envPath: string;
	action: "created" | "updated" | "unchanged";
	files: Array<{
		path: string;
		action: "created" | "updated" | "unchanged";
	}>;
	nextCommand: string;
};

export type WorkspaceBackendSetupInfo = {
	workspaceRoot: string;
	envPath: string;
	envExists: boolean;
	workspaceBackendUrl: string;
	node: {
		version: string;
		major: number | null;
		supported: boolean;
		requirement: string;
	};
	hookSpool: {
		path: string;
		pendingPath: string;
		exists: boolean;
		pendingCount: number;
		source: string;
	};
	pluginHooks: {
		status: "installed" | "missing";
		plugins: Array<{
			name: string;
			pluginRoot: string;
			hooksPath: string;
		}>;
	};
	effectiveEnv: Partial<Record<SetupKey, string>>;
	nextCommand: string;
};

export type WorkspaceBackendStartResult = {
	command: string[];
	env: Partial<Record<SetupKey, string>>;
	cwd: string;
	dryRun: boolean;
	exitCode?: number | null;
};

export async function initLocalWorkspaceBackend(
	context: WorkspaceContext,
	options: { overwrite?: boolean } = {},
): Promise<WorkspaceBackendInitLocalResult> {
	const envPath = localBackendEnvPath(context);
	const envText = localBackendEnvText(context);
	const files: WorkspaceBackendInitLocalResult["files"] = [];
	await mkdir(path.dirname(envPath), { recursive: true });
	const current = await readTextIfExists(envPath);
	const envAction = current === undefined
		? "created"
		: current === envText
			? "unchanged"
			: options.overwrite === true
				? "updated"
				: "unchanged";
	if (envAction === "created" || envAction === "updated") {
		await writeFile(envPath, envText);
	}
	files.push({ path: envPath, action: envAction });

	const defaults = localBackendDefaults(context);
	const spoolDir = absoluteFromWorkspace(
		context,
		defaults.CODEX_FLOWS_HOOK_SPOOL_DIR ?? ".codex/workspace/local/hook-spool",
	);
	for (const child of ["pending", "processed", "ignored", "failed"]) {
		await mkdir(path.join(spoolDir, child), { recursive: true });
	}

	files.push(await appendGitignoreEntries(context.repoRoot, [
		".codex/workspace/backend.local.env",
		".codex/workspace/local/",
	]));

	return {
		workspaceRoot: context.repoRoot,
		envPath,
		action: envAction,
		files,
		nextCommand: "codex-flows workspace backend start",
	};
}

export async function collectWorkspaceBackendSetupInfo(
	context: WorkspaceContext,
	env: Record<string, string | undefined> = process.env,
): Promise<WorkspaceBackendSetupInfo> {
	const envPath = localBackendEnvPath(context);
	const envFile = await readLocalBackendEnv(context);
	const effective = effectiveLocalBackendEnv(context, env, envFile.values);
	const hookSpoolSource = effective.CODEX_FLOWS_HOOK_SPOOL_DIR
		? "CODEX_FLOWS_HOOK_SPOOL_DIR"
		: "default";
	const hookSpoolPath = absoluteFromWorkspace(
		context,
		effective.CODEX_FLOWS_HOOK_SPOOL_DIR ??
			".codex/workspace/local/hook-spool",
	);
	const pendingPath = path.join(hookSpoolPath, "pending");
	const pluginHooks = await findCodexFlowsPluginHooks(context.runtimeCodexHome);
	return {
		workspaceRoot: context.repoRoot,
		envPath,
		envExists: envFile.exists,
		workspaceBackendUrl: workspaceBackendUrlFromEnv(effective),
		node: nodeInfo(),
		hookSpool: {
			path: hookSpoolPath,
			pendingPath,
			exists: await exists(pendingPath),
			pendingCount: await countJsonFiles(pendingPath),
			source: hookSpoolSource,
		},
		pluginHooks,
		effectiveEnv: pickSetupEnv(effective),
		nextCommand: suggestedBackendSetupCommand(envFile.exists, pluginHooks.status),
	};
}

export async function startLocalWorkspaceBackend(
	context: WorkspaceContext,
	options: {
		dryRun?: boolean;
		env?: Record<string, string | undefined>;
		command?: string;
	} = {},
): Promise<WorkspaceBackendStartResult> {
	const sourceEnv = options.env ?? process.env;
	const envFile = await readLocalBackendEnv(context);
	const effective = effectiveLocalBackendEnv(context, sourceEnv, envFile.values);
	const command = options.command ?? sourceEnv.CODEX_WORKSPACE_BACKEND_COMMAND ??
		defaultBackendCommand;
	const args = localBackendStartArgs(context, effective);
	const result: WorkspaceBackendStartResult = {
		command: [command, ...args],
		env: pickSetupEnv(effective),
		cwd: context.repoRoot,
		dryRun: options.dryRun === true,
	};
	if (options.dryRun === true) {
		return result;
	}

	const child = spawn(command, args, {
		cwd: context.repoRoot,
		env: {
			...process.env,
			...Object.fromEntries(
				Object.entries(effective).filter((entry): entry is [string, string] =>
					typeof entry[1] === "string"
				),
			),
		},
		stdio: "inherit",
	});
	const exitCode = await exitCodeFor(child);
	if (exitCode !== 0) {
		throw new Error(`${command} exited with code ${exitCode}`);
	}
	return { ...result, exitCode };
}

export function formatWorkspaceBackendInitLocalResult(
	result: WorkspaceBackendInitLocalResult,
): string {
	const rows: Array<[string, string]> = [
		["workspace", result.workspaceRoot],
		["env", `${result.envPath} (${result.action})`],
		["next", result.nextCommand],
	];
	for (const file of result.files) {
		if (file.path === result.envPath) {
			continue;
		}
		rows.push(["file", `${file.path} (${file.action})`]);
	}
	return `${rows.map(([label, value]) => `${label.padEnd(19)} ${value}`).join("\n")}\n`;
}

export function formatWorkspaceBackendSetupInfo(
	info: WorkspaceBackendSetupInfo,
	options: { backendLabel?: string; nextCommand?: string } = {},
): string {
	const rows: Array<[string, string]> = [
		["backend env", `${info.envPath}${info.envExists ? "" : " (missing)"}`],
		["backend URL", info.workspaceBackendUrl],
		["backend", options.backendLabel ?? "not probed"],
		["node", `${info.node.version} (${info.node.supported ? "ok" : `requires ${info.node.requirement}`})`],
		["plugin hooks", info.pluginHooks.status === "installed"
			? info.pluginHooks.plugins.map((plugin) => plugin.name).join(", ")
			: "missing"],
		["hook spool", `${info.hookSpool.path}${info.hookSpool.exists ? "" : " (missing)"}`],
		["hook pending", String(info.hookSpool.pendingCount)],
		["next", options.nextCommand ?? info.nextCommand],
	];
	return `${rows.map(([label, value]) => `${label.padEnd(19)} ${value}`).join("\n")}\n`;
}

export function formatWorkspaceBackendStartResult(result: WorkspaceBackendStartResult): string {
	const rows: Array<[string, string]> = [
		["cwd", result.cwd],
		["command", shellCommand(result.command)],
	];
	if (result.exitCode !== undefined) {
		rows.push(["exit code", String(result.exitCode)]);
	}
	return `${rows.map(([label, value]) => `${label.padEnd(19)} ${value}`).join("\n")}\n`;
}

function localBackendEnvPath(context: WorkspaceContext): string {
	return path.join(context.repoRoot, LOCAL_BACKEND_ENV_RELATIVE_PATH);
}

function localBackendDefaults(context: WorkspaceContext): Record<SetupKey, string | undefined> {
	const host = "127.0.0.1";
	const port = "3586";
	return {
		CODEX_WORKSPACE_BACKEND_HOST: host,
		CODEX_WORKSPACE_BACKEND_PORT: port,
		CODEX_WORKSPACE_BACKEND_LOCAL_APP_SERVER: "1",
		CODEX_WORKSPACE_BACKEND_APP_SERVER_URL: undefined,
		CODEX_WORKSPACE_BACKEND_WS_URL: `ws://${host}:${port}`,
		CODEX_FLOWS_HOOK_SPOOL_DIR: ".codex/workspace/local/hook-spool",
	};
}

function localBackendEnvText(context: WorkspaceContext): string {
	const defaults = localBackendDefaults(context);
	const lines = [
		"# codex-flows local workspace backend",
		"# Generated by: codex-flows workspace backend init local",
		`CODEX_WORKSPACE_BACKEND_HOST=${defaults.CODEX_WORKSPACE_BACKEND_HOST}`,
		`CODEX_WORKSPACE_BACKEND_PORT=${defaults.CODEX_WORKSPACE_BACKEND_PORT}`,
		`CODEX_WORKSPACE_BACKEND_LOCAL_APP_SERVER=${defaults.CODEX_WORKSPACE_BACKEND_LOCAL_APP_SERVER}`,
		`CODEX_WORKSPACE_BACKEND_WS_URL=${defaults.CODEX_WORKSPACE_BACKEND_WS_URL}`,
		`CODEX_FLOWS_HOOK_SPOOL_DIR=${defaults.CODEX_FLOWS_HOOK_SPOOL_DIR}`,
		"",
		"# Optional:",
		"# CODEX_WORKSPACE_BACKEND_APP_SERVER_URL=ws://127.0.0.1:3585",
		"",
	];
	return `${lines.join("\n")}`;
}

async function readLocalBackendEnv(
	context: WorkspaceContext,
): Promise<{ exists: boolean; values: Partial<Record<SetupKey, string>> }> {
	const text = await readTextIfExists(localBackendEnvPath(context));
	if (text === undefined) {
		return { exists: false, values: {} };
	}
	return { exists: true, values: parseEnvText(text) };
}

function parseEnvText(text: string): Partial<Record<SetupKey, string>> {
	const values: Partial<Record<SetupKey, string>> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		const index = line.indexOf("=");
		if (index < 0) {
			continue;
		}
		const key = line.slice(0, index).trim();
		if (!isSetupKey(key)) {
			continue;
		}
		values[key] = stripEnvQuotes(line.slice(index + 1).trim());
	}
	return values;
}

function effectiveLocalBackendEnv(
	context: WorkspaceContext,
	env: Record<string, string | undefined>,
	envFile: Partial<Record<SetupKey, string>>,
): Record<SetupKey, string | undefined> {
	const defaults = localBackendDefaults(context);
	const effective = { ...defaults, ...envFile };
	for (const key of setupKeys) {
		if (env[key] !== undefined) {
			effective[key] = env[key];
		}
	}
	return effective;
}

function localBackendStartArgs(
	context: WorkspaceContext,
	env: Record<SetupKey, string | undefined>,
): string[] {
	const args = [
		"serve",
		"--host",
		env.CODEX_WORKSPACE_BACKEND_HOST ?? "127.0.0.1",
		"--port",
		env.CODEX_WORKSPACE_BACKEND_PORT ?? "3586",
		"--cwd",
		context.repoRoot,
	];
	if (env.CODEX_WORKSPACE_BACKEND_LOCAL_APP_SERVER !== "0" &&
		env.CODEX_WORKSPACE_BACKEND_LOCAL_APP_SERVER !== "false" &&
		!env.CODEX_WORKSPACE_BACKEND_APP_SERVER_URL) {
		args.push("--local-app-server");
	}
	if (env.CODEX_WORKSPACE_BACKEND_APP_SERVER_URL) {
		args.push("--app-server-url", env.CODEX_WORKSPACE_BACKEND_APP_SERVER_URL);
	}
	return args;
}

function workspaceBackendUrlFromEnv(env: Record<SetupKey, string | undefined>): string {
	if (env.CODEX_WORKSPACE_BACKEND_WS_URL) {
		return env.CODEX_WORKSPACE_BACKEND_WS_URL;
	}
	return `ws://${env.CODEX_WORKSPACE_BACKEND_HOST ?? "127.0.0.1"}:${
		env.CODEX_WORKSPACE_BACKEND_PORT ?? "3586"
	}`;
}

function nodeInfo(): WorkspaceBackendSetupInfo["node"] {
	const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
	return {
		version: process.version,
		major: Number.isFinite(major) ? major : null,
		supported: Number.isFinite(major) && major >= 24 && major < 25,
		requirement: ">=24.0.0 <25",
	};
}

async function findCodexFlowsPluginHooks(
	codexHome: string,
): Promise<WorkspaceBackendSetupInfo["pluginHooks"]> {
	const cacheRoot = path.join(codexHome, "plugins", "cache");
	const plugins = await findPluginHookFiles(cacheRoot, 6);
	const filtered = plugins.filter((plugin) =>
		plugin.name === "codex-flows-local-workspace" || plugin.name === "codex-flows"
	);
	return {
		status: filtered.length > 0 ? "installed" : "missing",
		plugins: filtered,
	};
}

async function findPluginHookFiles(
	root: string,
	maxDepth: number,
): Promise<WorkspaceBackendSetupInfo["pluginHooks"]["plugins"]> {
	if (maxDepth < 0 || !await exists(root)) {
		return [];
	}
	const found: WorkspaceBackendSetupInfo["pluginHooks"]["plugins"] = [];
	let entries: Array<{ name: string; isDirectory: () => boolean }>;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	if (await exists(path.join(root, ".codex-plugin", "plugin.json")) &&
		await exists(path.join(root, "hooks", "hooks.json"))) {
		const name = await pluginName(root);
		if (name) {
			found.push({
				name,
				pluginRoot: root,
				hooksPath: path.join(root, "hooks", "hooks.json"),
			});
		}
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) {
			continue;
		}
		found.push(...await findPluginHookFiles(path.join(root, entry.name), maxDepth - 1));
	}
	return found;
}

async function pluginName(pluginRoot: string): Promise<string | undefined> {
	try {
			const manifest = parseJsonText(
				await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
				path.join(pluginRoot, ".codex-plugin", "plugin.json"),
			) as { name?: unknown };
		return typeof manifest.name === "string" ? manifest.name : undefined;
	} catch {
		return undefined;
	}
}

function suggestedBackendSetupCommand(envExists: boolean, hooksStatus: "installed" | "missing"): string {
	if (!envExists) {
		return "codex-flows workspace backend init local";
	}
	if (hooksStatus === "missing") {
		return "codex plugin add codex-flows-local-workspace@codex-flows";
	}
	return "codex-flows workspace backend start";
}

async function appendGitignoreEntries(
	workspaceRoot: string,
	entries: string[],
): Promise<{ path: string; action: "created" | "updated" | "unchanged" }> {
	const gitignorePath = path.join(workspaceRoot, ".gitignore");
	const existing = await readTextIfExists(gitignorePath);
	const lines = existing?.split(/\r?\n/) ?? [];
	const present = new Set(lines.map((line) => line.trim()).filter(Boolean));
	const missing = entries.filter((entry) => !present.has(entry));
	if (missing.length === 0) {
		return { path: gitignorePath, action: existing === undefined ? "created" : "unchanged" };
	}
	const next = [
		...(existing ? [existing.trimEnd()] : []),
		"",
		"# codex-flows local backend runtime",
		...missing,
		"",
	].join("\n");
	await writeFile(gitignorePath, next);
	return { path: gitignorePath, action: existing === undefined ? "created" : "updated" };
}

async function countJsonFiles(dir: string): Promise<number> {
	try {
		return (await readdir(dir)).filter((entry) => entry.endsWith(".json")).length;
	} catch {
		return 0;
	}
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

function absoluteFromWorkspace(context: WorkspaceContext, value: string): string {
	if (value.startsWith("~/")) {
		return path.join(os.homedir(), value.slice(2));
	}
	if (path.isAbsolute(value)) {
		return value;
	}
	return path.join(context.repoRoot, value);
}

function stripEnvQuotes(value: string): string {
	if ((value.startsWith("\"") && value.endsWith("\"")) ||
		(value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}

function pickSetupEnv(
	env: Record<SetupKey, string | undefined>,
): Partial<Record<SetupKey, string>> {
	return Object.fromEntries(
		setupKeys.flatMap((key) => env[key] ? [[key, env[key]]] : []),
	) as Partial<Record<SetupKey, string>>;
}

function isSetupKey(value: string): value is SetupKey {
	return setupKeys.includes(value as SetupKey);
}

function shellCommand(argv: string[]): string {
	return argv.map(shellArg).join(" ");
}

function shellArg(value: string): string {
	if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function exitCodeFor(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
}
