import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseJsonText } from "./json.ts";
import type { WorkspaceContext } from "./workspace-autonomy.ts";

export const LOCAL_BACKEND_ENV_RELATIVE_PATH = ".codex/workspace/backend.local.env";
const defaultBackendCommand = "codex-workspace-backend-local";
const setupKeys = [
	"CODEX_WORKSPACE_BACKEND_HOST",
	"CODEX_WORKSPACE_BACKEND_PORT",
	"CODEX_WORKSPACE_BACKEND_LOCAL_APP_SERVER",
	"CODEX_WORKSPACE_BACKEND_CODEX_HOME",
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

export type WorkspaceBackendProfileInitResult = {
	profile: string;
	profilePath: string;
	workspaceRoot: string;
	codexHome: string;
	action: "created" | "updated" | "unchanged";
	nextCommand: string;
};

export type WorkspaceBackendServiceInstallResult = {
	profile: string;
	unitPath: string;
	unit: string;
	action: "created" | "updated" | "unchanged";
	dryRun: boolean;
	nextCommands: string[];
};

export type WorkspaceBackendProfile = {
	name: string;
	path: string;
	workspaceRoot: string;
	codexHome: string;
	host: string;
	port: string;
	localAppServer: boolean;
	appServerUrl?: string;
	workspaceBackendUrl: string;
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

export async function initGlobalLocalWorkspaceBackend(
	options: {
		profile?: string;
		workspaceRoot?: string;
		codexHome?: string;
		overwrite?: boolean;
		env?: Record<string, string | undefined>;
	} = {},
): Promise<WorkspaceBackendProfileInitResult> {
	const name = backendProfileName(options.profile);
	const profilePath = backendProfilePath(name, options.env);
	const workspaceRoot = path.resolve(expandHome(options.workspaceRoot ?? os.homedir()));
	const codexHome = path.resolve(expandHome(options.codexHome ?? path.join(os.homedir(), ".codex")));
	const text = backendProfileToml({
		name,
		path: profilePath,
		workspaceRoot,
		codexHome,
		host: "127.0.0.1",
		port: "3586",
		localAppServer: true,
		workspaceBackendUrl: "ws://127.0.0.1:3586",
	});
	await mkdir(path.dirname(profilePath), { recursive: true });
	const current = await readTextIfExists(profilePath);
	const action = current === undefined
		? "created"
		: current === text
			? "unchanged"
			: options.overwrite === true
				? "updated"
				: "unchanged";
	if (action === "created" || action === "updated") {
		await writeFile(profilePath, text);
	}
	await prepareHookSpool(path.join(workspaceRoot, ".codex", "workspace", "local", "hook-spool"));
	return {
		profile: name,
		profilePath,
		workspaceRoot,
		codexHome,
		action,
		nextCommand: `codex-flows workspace backend service install --profile ${name}`,
	};
}

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
	await prepareHookSpool(spoolDir);

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
	options: { profile?: string } = {},
): Promise<WorkspaceBackendSetupInfo> {
	const envFile = await readLocalBackendEnv(context);
	const profile = options.profile ? await readBackendProfile(options.profile, env) : undefined;
	const envPath = profile?.path ?? localBackendEnvPath(context);
	const effective = effectiveLocalBackendEnv(
		context,
		env,
		profile ? profileEnv(profile) : envFile.values,
	);
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
		envExists: profile ? true : envFile.exists,
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
		nextCommand: suggestedBackendSetupCommand(
			profile ? true : envFile.exists,
			pluginHooks.status,
			profile?.name,
		),
	};
}

export async function startLocalWorkspaceBackend(
	context: WorkspaceContext,
	options: {
		dryRun?: boolean;
		env?: Record<string, string | undefined>;
		command?: string;
		profile?: string;
	} = {},
): Promise<WorkspaceBackendStartResult> {
	const sourceEnv = options.env ?? process.env;
	const envFile = await readLocalBackendEnv(context);
	const profile = options.profile ? await readBackendProfile(options.profile, sourceEnv) : undefined;
	const effective = effectiveLocalBackendEnv(
		context,
		sourceEnv,
		profile ? profileEnv(profile) : envFile.values,
	);
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

export async function installWorkspaceBackendService(
	options: {
		profile?: string;
		dryRun?: boolean;
		overwrite?: boolean;
		env?: Record<string, string | undefined>;
	} = {},
): Promise<WorkspaceBackendServiceInstallResult> {
	const profile = await readBackendProfile(backendProfileName(options.profile), options.env);
	const unitPath = path.join(
		systemdUserUnitDir(options.env),
		`codex-flows-backend-${profile.name}.service`,
	);
	const command = localBackendCommandForProfile(profile);
	const unit = [
		"[Unit]",
		`Description=Codex Flows workspace backend (${profile.name})`,
		"After=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		`ExecStart=${shellCommand(command)}`,
		"Restart=on-failure",
		"RestartSec=2",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
	const current = await readTextIfExists(unitPath);
	const action = current === undefined
		? "created"
		: current === unit
			? "unchanged"
			: options.overwrite === true
				? "updated"
				: "unchanged";
	if (options.dryRun !== true && (action === "created" || action === "updated")) {
		await mkdir(path.dirname(unitPath), { recursive: true });
		await writeFile(unitPath, unit);
	}
	return {
		profile: profile.name,
		unitPath,
		unit,
		action,
		dryRun: options.dryRun === true,
		nextCommands: [
			"systemctl --user daemon-reload",
			`systemctl --user enable --now codex-flows-backend-${profile.name}.service`,
			`systemctl --user status codex-flows-backend-${profile.name}.service`,
		],
	};
}

export async function readWorkspaceBackendProfile(
	name = "home",
	env: Record<string, string | undefined> = process.env,
): Promise<WorkspaceBackendProfile> {
	return await readBackendProfile(name, env);
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

export function formatWorkspaceBackendProfileInitResult(
	result: WorkspaceBackendProfileInitResult,
): string {
	const rows: Array<[string, string]> = [
		["profile", result.profile],
		["profile path", `${result.profilePath} (${result.action})`],
		["workspace", result.workspaceRoot],
		["CODEX_HOME", result.codexHome],
		["next", result.nextCommand],
	];
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

export function formatWorkspaceBackendServiceInstallResult(
	result: WorkspaceBackendServiceInstallResult,
): string {
	const rows: Array<[string, string]> = [
		["profile", result.profile],
		["unit", `${result.unitPath} (${result.dryRun ? "dry-run" : result.action})`],
		...result.nextCommands.map((command): [string, string] => ["next", command]),
	];
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
		CODEX_WORKSPACE_BACKEND_CODEX_HOME: context.globalCodexHome,
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
		`CODEX_WORKSPACE_BACKEND_CODEX_HOME=${defaults.CODEX_WORKSPACE_BACKEND_CODEX_HOME}`,
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
	if (env.CODEX_WORKSPACE_BACKEND_CODEX_HOME) {
		args.push("--codex-home", env.CODEX_WORKSPACE_BACKEND_CODEX_HOME);
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

async function readBackendProfile(
	name: string,
	env: Record<string, string | undefined> = process.env,
): Promise<WorkspaceBackendProfile> {
	const profileName = backendProfileName(name);
	const filePath = backendProfilePath(profileName, env);
	const text = await readFile(filePath, "utf8");
	const parsed = parseToml(text) as unknown;
	if (!isRecord(parsed) || !isRecord(parsed.backend)) {
		throw new Error(`backend profile must contain [backend]: ${filePath}`);
	}
	const backend = parsed.backend;
	const host = stringValue(backend.host, "127.0.0.1");
	const port = String(numberOrString(backend.port, "3586"));
	const workspaceRoot = path.resolve(expandHome(requiredString(backend.root, "backend.root")));
	const codexHome = path.resolve(expandHome(stringValue(
		backend.codex_home,
		path.join(os.homedir(), ".codex"),
	)));
	const appServerUrl = optionalString(backend.app_server_url);
	return {
		name: profileName,
		path: filePath,
		workspaceRoot,
		codexHome,
		host,
		port,
		localAppServer: booleanValue(backend.local_app_server, true),
		...(appServerUrl ? { appServerUrl } : {}),
		workspaceBackendUrl: stringValue(backend.workspace_backend_url, `ws://${host}:${port}`),
	};
}

function profileEnv(profile: WorkspaceBackendProfile): Partial<Record<SetupKey, string>> {
	return {
		CODEX_WORKSPACE_BACKEND_HOST: profile.host,
		CODEX_WORKSPACE_BACKEND_PORT: profile.port,
		CODEX_WORKSPACE_BACKEND_LOCAL_APP_SERVER: profile.localAppServer ? "1" : "0",
		CODEX_WORKSPACE_BACKEND_CODEX_HOME: profile.codexHome,
		...(profile.appServerUrl
			? { CODEX_WORKSPACE_BACKEND_APP_SERVER_URL: profile.appServerUrl }
			: {}),
		CODEX_WORKSPACE_BACKEND_WS_URL: profile.workspaceBackendUrl,
		CODEX_FLOWS_HOOK_SPOOL_DIR: path.join(profile.workspaceRoot, ".codex", "workspace", "local", "hook-spool"),
	};
}

function backendProfileName(name = "home"): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
		throw new Error(`Invalid backend profile name: ${name}`);
	}
	return name;
}

function backendProfilePath(
	name: string,
	env: Record<string, string | undefined> = process.env,
): string {
	return path.join(configHome(env), "codex-flows", "backends", `${name}.toml`);
}

function configHome(env: Record<string, string | undefined>): string {
	return path.resolve(expandHome(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")));
}

function systemdUserUnitDir(env: Record<string, string | undefined> = process.env): string {
	return path.join(configHome(env), "systemd", "user");
}

function backendProfileToml(profile: WorkspaceBackendProfile): string {
	const lines = [
		"[backend]",
		`root = ${tomlString(profile.workspaceRoot)}`,
		`codex_home = ${tomlString(profile.codexHome)}`,
		`host = ${tomlString(profile.host)}`,
		`port = ${profile.port}`,
		`local_app_server = ${profile.localAppServer ? "true" : "false"}`,
		`workspace_backend_url = ${tomlString(profile.workspaceBackendUrl)}`,
		"",
	];
	return lines.join("\n");
}

function localBackendCommandForProfile(profile: WorkspaceBackendProfile): string[] {
	const command = [
		"codex-workspace-backend-local",
		"serve",
		"--host",
		profile.host,
		"--port",
		profile.port,
		"--cwd",
		profile.workspaceRoot,
		"--codex-home",
		profile.codexHome,
	];
	if (profile.localAppServer && !profile.appServerUrl) {
		command.push("--local-app-server");
	}
	if (profile.appServerUrl) {
		command.push("--app-server-url", profile.appServerUrl);
	}
	return command;
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

async function prepareHookSpool(spoolDir: string): Promise<void> {
	for (const child of ["pending", "processed", "ignored", "failed"]) {
		await mkdir(path.join(spoolDir, child), { recursive: true });
	}
}

function suggestedBackendSetupCommand(
	envExists: boolean,
	hooksStatus: "installed" | "missing",
	profile?: string,
): string {
	if (!envExists) {
		return "codex-flows workspace backend init local";
	}
	if (hooksStatus === "missing") {
		return "codex plugin add codex-flows-local-workspace@codex-flows";
	}
	if (profile) {
		return `codex-flows workspace backend start --profile ${profile}`;
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

function expandHome(value: string): string {
	if (value === "~") {
		return os.homedir();
	}
	if (value.startsWith("~/")) {
		return path.join(os.homedir(), value.slice(2));
	}
	return value;
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${label} must be a string`);
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value : fallback;
}

function numberOrString(value: unknown, fallback: string): string | number {
	return typeof value === "number" || typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
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
