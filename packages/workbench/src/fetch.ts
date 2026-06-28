import os from "node:os";
import path from "node:path";
import {
	collectWorkbenchDoctorInfo,
	createWorkbenchContext,
	type WorkbenchDoctorInfo,
} from "./workbench-runtime.ts";
import { readJsonFile } from "@codex-toys/bridge/json";

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
	runtimeUrl: string;
	codexHome: string;
	workbench?: WorkbenchDoctorInfo;
	runtimeTransport: FetchRuntimeTransportInfo;
};

export type FetchInfoOptions = {
	env?: Record<string, string | undefined>;
	cwd?: string;
	appUrl: string;
	workbenchUrl: string;
	runtimeTransport?: FetchRuntimeTransportInfo;
};

export type FetchRuntimeTransportInfo = {
	transport: "local" | "ssh";
	status: "connected" | "unavailable";
	url?: string;
	server?: {
		name: string;
		version: string;
	};
	capabilities?: {
		methods: number;
	};
	threads?: FetchThreadsInfo;
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
	const workbenchContext = await createWorkbenchContext({
		workbenchRoot: options.cwd,
		env,
	}).catch(() => undefined);
	const workbench = workbenchContext
		? await collectWorkbenchDoctorInfo(workbenchContext).catch(() => undefined)
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
		runtimeUrl: options.workbenchUrl,
		codexHome: env.CODEX_HOME ?? defaultCodexHome(),
		...(workbench ? { workbench } : {}),
		runtimeTransport: options.runtimeTransport ?? {
			transport: "local",
			status: "unavailable",
			error: "No runtime probe was run",
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
		["runtime transport", info.runtimeUrl],
		["CODEX_HOME", info.codexHome],
		...(info.workbench
			? [
					["workbench mode", info.workbench.mode],
					["workbench root", info.workbench.repoRoot],
					["state root", info.workbench.stateRoot],
					["tasks", `${info.workbench.taskCount} configured, ${info.workbench.failingCount} failing`],
				] as Array<[string, string]>
			: []),
		["runtime status", runtimeTransportLabel(info.runtimeTransport)],
		...runtimeTransportRows(info.runtimeTransport),
	];
	const logo = [
		"    ______          ",
		"   / ____/___  ____ ",
		"  / /   / __ \\/ __ \\",
		" / /___/ /_/ / /_/ /",
		" \\____/\\____/ .___/ ",
		"           /_/      ",
		"  codex-toys       ",
	];
	const width = Math.max(...logo.map((line) => line.length));
	const lines = rows.map(([label, value], index) => {
		const left = paint.logo(logo[index] ?? "".padEnd(width));
		const paddedLabel = label.padEnd(Math.max(13, label.length + 1));
		return `${left}  ${paint.label(paddedLabel)}${paint.value(value)}`;
	});
	for (let index = rows.length; index < logo.length; index += 1) {
		lines.push(paint.logo(logo[index] ?? ""));
	}
	return `${lines.join("\n")}\n`;
}

function runtimeTransportLabel(runtimeTransport: FetchRuntimeTransportInfo): string {
	if (runtimeTransport.status === "connected") {
		return runtimeTransport.url
			? `${runtimeTransport.transport} connected (${runtimeTransport.url})`
			: `${runtimeTransport.transport} connected`;
	}
	return runtimeTransport.error ? `unavailable (${runtimeTransport.error})` : "unavailable";
}

function runtimeTransportRows(runtimeTransport: FetchRuntimeTransportInfo): Array<[string, string]> {
	const rows: Array<[string, string]> = [];
	if (runtimeTransport.server) {
		rows.push(["server", `${runtimeTransport.server.name}@${runtimeTransport.server.version}`]);
	}
	if (runtimeTransport.capabilities) {
		rows.push([
			"capabilities",
			`${runtimeTransport.capabilities.methods} methods`,
		]);
	}
	if (runtimeTransport.threads) {
		rows.push(["threads", countLabel(runtimeTransport.threads)]);
		for (const thread of runtimeTransport.threads.latest.slice(0, 3)) {
			rows.push(["latest", `${thread.status} ${thread.label} ${compactId(thread.id)}`]);
		}
		if (runtimeTransport.threads.error) {
			rows.push(["thread error", runtimeTransport.threads.error]);
		}
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
	const packageUrl = new URL("../package.json", import.meta.url);
	const parsed = await readJsonFile(packageUrl, "package.json");
	if (!isRecord(parsed) || typeof parsed.name !== "string" || typeof parsed.version !== "string") {
		return { name: "codex-toys", version: "unknown" };
	}
	return { name: "codex-toys", version: parsed.version };
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
