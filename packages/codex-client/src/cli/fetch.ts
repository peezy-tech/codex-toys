import os from "node:os";
import path from "node:path";
import {
	collectWorkspaceDoctorInfo,
	createWorkspaceContext,
	type WorkspaceDoctorInfo,
} from "./workspace-autonomy.ts";
import { readJsonFile } from "./json.ts";

export type FetchInfo = {
	package: string;
	version: string;
	runtime: string;
	node: string;
	platform: string;
	arch: string;
	shell?: string;
	cwd: string;
	codexCommand: string;
	appServerUrl: string;
	workspaceBackendUrl: string;
	codexHome: string;
	workspace?: WorkspaceDoctorInfo;
	backend: FetchBackendInfo;
};

export type FetchInfoOptions = {
	env?: Record<string, string | undefined>;
	cwd?: string;
	appUrl: string;
	workspaceUrl: string;
	backend?: FetchBackendInfo;
};

export type FetchBackendInfo = {
	mode: "workspace" | "app-server" | "local";
	status: "connected" | "unavailable";
	url?: string;
	server?: {
		name: string;
		version: string;
	};
	capabilities?: {
		workspaceMethods: number;
	};
	threads?: FetchThreadsInfo;
	delegations?: FetchCountInfo;
	error?: string;
};

export type FetchThreadsInfo = FetchCountInfo & {
	latest: FetchThreadSummary[];
	error?: string;
};

export type FetchThreadSummary = {
	id: string;
	label: string;
	status: string;
	cwd?: string;
	updatedAt?: string;
};

export type FetchCountInfo = {
	total: number;
	active: number;
	idle?: number;
	failed?: number;
	complete?: number;
	reported?: number;
	other?: number;
};

export async function collectFetchInfo(
	options: FetchInfoOptions,
): Promise<FetchInfo> {
	const env = options.env ?? process.env;
	const packageJson = await readPackageJson();
	const workspaceContext = await createWorkspaceContext({
		workspaceRoot: options.cwd,
		env,
	}).catch(() => undefined);
	const workspace = workspaceContext
		? await collectWorkspaceDoctorInfo(workspaceContext).catch(() => undefined)
		: undefined;
	return {
		package: packageJson.name,
		version: packageJson.version,
		runtime: nodeRuntime(),
		node: process.versions.node,
		platform: os.platform(),
		arch: os.arch(),
		...(env.SHELL || env.ComSpec ? { shell: env.SHELL ?? env.ComSpec } : {}),
		cwd: options.cwd ?? process.cwd(),
		codexCommand: env.CODEX_APP_SERVER_CODEX_COMMAND ?? "codex",
		appServerUrl: options.appUrl,
		workspaceBackendUrl: options.workspaceUrl,
		codexHome: env.CODEX_HOME ?? defaultCodexHome(),
		...(workspace ? { workspace } : {}),
		backend: options.backend ?? {
			mode: "local",
			status: "unavailable",
			error: "No backend probe was run",
		},
	};
}

export function formatFetchInfo(
	info: FetchInfo,
	options: { color?: boolean } = {},
): string {
	const paint = palette(options.color ?? true);
	const rows: Array<[string, string]> = [
		["package", `${info.package}@${info.version}`],
		["runtime", info.runtime],
		["node", info.node],
		["platform", `${info.platform}/${info.arch}`],
		["shell", info.shell ?? "unknown"],
		["cwd", info.cwd],
		["codex", info.codexCommand],
		["app-server", info.appServerUrl],
		["workspace", info.workspaceBackendUrl],
		["CODEX_HOME", info.codexHome],
		...(info.workspace
			? [
					["workspace mode", info.workspace.mode],
					["workspace root", info.workspace.repoRoot],
					["state root", info.workspace.stateRoot],
					["tasks", `${info.workspace.taskCount} configured, ${info.workspace.dueCount} due, ${info.workspace.failingCount} failing`],
				] as Array<[string, string]>
			: []),
		["backend", backendLabel(info.backend)],
		...backendRows(info.backend),
	];
	const logo = [
		"    ______          ",
		"   / ____/___  ____ ",
		"  / /   / __ \\/ __ \\",
		" / /___/ /_/ / /_/ /",
		" \\____/\\____/ .___/ ",
		"           /_/      ",
		"  codex-flows       ",
	];
	const width = Math.max(...logo.map((line) => line.length));
	const lines = rows.map(([label, value], index) => {
		const left = paint.logo(logo[index] ?? "".padEnd(width));
		return `${left}  ${paint.label(label.padEnd(13))}${paint.value(value)}`;
	});
	for (let index = rows.length; index < logo.length; index += 1) {
		lines.push(paint.logo(logo[index] ?? ""));
	}
	return `${lines.join("\n")}\n`;
}

function backendLabel(backend: FetchBackendInfo): string {
	if (backend.status === "connected") {
		return backend.url ? `${backend.mode} connected (${backend.url})` : `${backend.mode} connected`;
	}
	return backend.error ? `local only (${backend.error})` : "local only";
}

function backendRows(backend: FetchBackendInfo): Array<[string, string]> {
	const rows: Array<[string, string]> = [];
	if (backend.server) {
		rows.push(["server", `${backend.server.name}@${backend.server.version}`]);
	}
	if (backend.capabilities) {
		rows.push([
			"capabilities",
			`${backend.capabilities.workspaceMethods} methods`,
		]);
	}
	if (backend.threads) {
		rows.push(["threads", countLabel(backend.threads)]);
		for (const thread of backend.threads.latest.slice(0, 3)) {
			rows.push(["latest", `${thread.status} ${thread.label} ${compactId(thread.id)}`]);
		}
		if (backend.threads.error) {
			rows.push(["thread error", backend.threads.error]);
		}
	}
	if (backend.delegations) {
		rows.push(["delegations", countLabel(backend.delegations)]);
	}
	return rows;
}

function countLabel(info: FetchCountInfo): string {
	const parts = [`${info.total} listed`, `${info.active} active`];
	if (info.idle !== undefined) {
		parts.push(`${info.idle} idle`);
	}
	if (info.failed !== undefined && info.failed > 0) {
		parts.push(`${info.failed} failed`);
	}
	if (info.complete !== undefined && info.complete > 0) {
		parts.push(`${info.complete} complete`);
	}
	if (info.reported !== undefined && info.reported > 0) {
		parts.push(`${info.reported} reported`);
	}
	if (info.other !== undefined && info.other > 0) {
		parts.push(`${info.other} other`);
	}
	return parts.join(", ");
}

function compactId(id: string): string {
	return id.length > 10 ? id.slice(0, 10) : id;
}

async function readPackageJson(): Promise<{ name: string; version: string }> {
	const packageUrl = new URL("../../package.json", import.meta.url);
	const parsed = await readJsonFile(packageUrl, "package.json");
	if (!isRecord(parsed) || typeof parsed.name !== "string" || typeof parsed.version !== "string") {
		return { name: "@peezy.tech/codex-flows", version: "unknown" };
	}
	return { name: parsed.name, version: parsed.version };
}

function nodeRuntime(): string {
	return `node ${process.versions.node}`;
}

function defaultCodexHome(): string {
	return process.env.HOME ? path.join(process.env.HOME, ".codex") : "default";
}

function palette(enabled: boolean): {
	logo(value: string): string;
	label(value: string): string;
	value(value: string): string;
} {
	if (!enabled) {
		return {
			logo: (value) => value,
			label: (value) => value,
			value: (value) => value,
		};
	}
	return {
		logo: (value) => `\x1b[36m${value}\x1b[0m`,
		label: (value) => `\x1b[1m${value}\x1b[0m`,
		value: (value) => value,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
