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
	agentUrl: string;
	codexHome: string;
	workspace?: WorkspaceDoctorInfo;
	agent: FetchAgentInfo;
};

export type FetchInfoOptions = {
	env?: Record<string, string | undefined>;
	cwd?: string;
	appUrl: string;
	workspaceUrl: string;
	agent?: FetchAgentInfo;
};

export type FetchAgentInfo = {
	transport: "local" | "ssh";
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
		agentUrl: options.workspaceUrl,
		codexHome: env.CODEX_HOME ?? defaultCodexHome(),
		...(workspace ? { workspace } : {}),
		agent: options.agent ?? {
			transport: "local",
			status: "unavailable",
			error: "No agent probe was run",
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
		["agent", info.agentUrl],
		["CODEX_HOME", info.codexHome],
		...(info.workspace
			? [
					["workspace mode", info.workspace.mode],
					["workspace root", info.workspace.repoRoot],
					["state root", info.workspace.stateRoot],
					["tasks", `${info.workspace.taskCount} configured, ${info.workspace.dueCount} due, ${info.workspace.failingCount} failing`],
				] as Array<[string, string]>
			: []),
		["agent status", agentLabel(info.agent)],
		...agentRows(info.agent),
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

function agentLabel(agent: FetchAgentInfo): string {
	if (agent.status === "connected") {
		return agent.url ? `${agent.transport} connected (${agent.url})` : `${agent.transport} connected`;
	}
	return agent.error ? `unavailable (${agent.error})` : "unavailable";
}

function agentRows(agent: FetchAgentInfo): Array<[string, string]> {
	const rows: Array<[string, string]> = [];
	if (agent.server) {
		rows.push(["server", `${agent.server.name}@${agent.server.version}`]);
	}
	if (agent.capabilities) {
		rows.push([
			"capabilities",
			`${agent.capabilities.workspaceMethods} methods`,
		]);
	}
	if (agent.threads) {
		rows.push(["threads", countLabel(agent.threads)]);
		for (const thread of agent.threads.latest.slice(0, 3)) {
			rows.push(["latest", `${thread.status} ${thread.label} ${compactId(thread.id)}`]);
		}
		if (agent.threads.error) {
			rows.push(["thread error", agent.threads.error]);
		}
	}
	if (agent.delegations) {
		rows.push(["delegations", countLabel(agent.delegations)]);
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
