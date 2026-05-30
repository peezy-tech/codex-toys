import { spawn } from "node:child_process";
import { readFile, statfs as nodeStatfs } from "node:fs/promises";
import os from "node:os";
import type { ToyboxMethodHandler, ToyboxMethodMetadata } from "./toybox/index.ts";

export const HOST_OVERVIEW_METHOD = "host.overview";

export type HostOverviewStatus =
	| "ok"
	| "degraded"
	| "unavailable"
	| "error"
	| "timeout";

export type HostOverviewSection = {
	ok: boolean;
	status: HostOverviewStatus;
	summary: string;
	error?: string;
};

export type HostOverviewCommandResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
	error?: string;
};

export type HostOverview = {
	ok: boolean;
	status: "ok" | "degraded";
	generatedAt: string;
	system: {
		platform: NodeJS.Platform;
		arch: string;
		uptimeSeconds: number;
	};
	disk: HostOverviewSection & {
		filesystems: HostOverviewFilesystem[];
	};
	memory: HostOverviewSection & HostOverviewMemory;
	docker: HostOverviewSection & {
		serverVersion?: string;
		containers?: number;
		running?: number;
		paused?: number;
		stopped?: number;
		images?: number;
	};
	systemd: HostOverviewSection & {
		failedUnits: HostOverviewFailedUnit[];
		truncated: boolean;
	};
	tailscale: HostOverviewSection & {
		backendState?: string;
		online?: boolean;
		health?: string[];
	};
	versions: HostOverviewSection & {
		packages: HostOverviewVersion[];
		toybox?: {
			name: string;
			version: string;
		};
	};
};

export type HostOverviewFilesystem = {
	path: string;
	totalBytes: number;
	freeBytes: number;
	availableBytes: number;
	usedBytes: number;
	usedPercent: number;
};

export type HostOverviewMemory = {
	totalBytes: number;
	freeBytes: number;
	usedBytes: number;
	usedPercent: number;
};

export type HostOverviewFailedUnit = {
	unit: string;
	load?: string;
	active?: string;
	sub?: string;
	description?: string;
};

export type HostOverviewVersion = {
	name: "node" | "codex-toys" | "codex-cli" | "docker" | "tailscale";
	ok: boolean;
	status: HostOverviewStatus;
	version?: string;
	error?: string;
};

export type HostOverviewOptions = {
	codexCommand?: string;
	commandTimeoutMs?: number;
	now?: () => Date;
	toyboxServerInfo?: {
		name: string;
		version: string;
	};
	runCommand?: (
		command: string,
		args: string[],
		timeoutMs: number,
	) => Promise<HostOverviewCommandResult>;
	statfs?: (path: string) => Promise<HostOverviewStatfs>;
	homedir?: () => string;
	totalmem?: () => number;
	freemem?: () => number;
	uptime?: () => number;
	platform?: () => NodeJS.Platform;
	arch?: () => string;
	packageVersion?: string;
};

type HostOverviewStatfs = {
	bsize: number;
	blocks: number;
	bfree: number;
	bavail: number;
};

const defaultCommandTimeoutMs = 1_500;
const maxCommandOutputBytes = 64 * 1024;
const maxFailedUnits = 20;
const maxHealthMessages = 8;

export const hostOverviewMethodMetadata: ToyboxMethodMetadata[] = [
	{
		name: HOST_OVERVIEW_METHOD,
		description: "Read a bounded host overview for local dashboards.",
		sideEffects: "read-only",
		category: "host",
	},
];

export function createHostOverviewMethods(
	options: HostOverviewOptions = {},
): Record<string, ToyboxMethodHandler> {
	return {
		[HOST_OVERVIEW_METHOD]: async () => await collectHostOverview(options),
	};
}

export async function collectHostOverview(
	options: HostOverviewOptions = {},
): Promise<HostOverview> {
	const commandTimeoutMs = options.commandTimeoutMs ?? defaultCommandTimeoutMs;
	const runCommand = options.runCommand ?? runBoundedCommand;
	const now = options.now ?? (() => new Date());
	const [
		disk,
		docker,
		systemd,
		tailscale,
		versions,
	] = await Promise.all([
		collectDisk(options),
		collectDocker(runCommand, commandTimeoutMs),
		collectSystemd(runCommand, commandTimeoutMs),
		collectTailscale(runCommand, commandTimeoutMs),
		collectVersions(options, runCommand, commandTimeoutMs),
	]);
	const memory = collectMemory(options);
	const sections = [disk, memory, docker, systemd, tailscale, versions];
	const status = sections.every((section) => section.ok) ? "ok" : "degraded";
	return {
		ok: true,
		status,
		generatedAt: now().toISOString(),
		system: {
			platform: (options.platform ?? os.platform)(),
			arch: (options.arch ?? os.arch)(),
			uptimeSeconds: Math.round((options.uptime ?? os.uptime)()),
		},
		disk,
		memory,
		docker,
		systemd,
		tailscale,
		versions,
	};
}

async function collectDisk(
	options: HostOverviewOptions,
): Promise<HostOverview["disk"]> {
	const statfs = options.statfs ?? nodeStatfs;
	const home = (options.homedir ?? os.homedir)();
	const paths = Array.from(new Set(["/", home].filter(Boolean)));
	const filesystems: HostOverviewFilesystem[] = [];
	for (const path of paths) {
		try {
			const stats = await statfs(path);
			const totalBytes = stats.blocks * stats.bsize;
			const freeBytes = stats.bfree * stats.bsize;
			const availableBytes = stats.bavail * stats.bsize;
			const usedBytes = Math.max(0, totalBytes - freeBytes);
			filesystems.push({
				path,
				totalBytes,
				freeBytes,
				availableBytes,
				usedBytes,
				usedPercent: percent(usedBytes, totalBytes),
			});
		} catch (error) {
			return {
				ok: false,
				status: "error",
				summary: "disk probe failed",
				error: errorMessage(error),
				filesystems,
			};
		}
	}
	return {
		ok: true,
		status: "ok",
		summary: filesystems
			.map((entry) => `${entry.path} ${formatBytes(entry.availableBytes)} available`)
			.join("; "),
		filesystems,
	};
}

function collectMemory(options: HostOverviewOptions): HostOverview["memory"] {
	const totalBytes = (options.totalmem ?? os.totalmem)();
	const freeBytes = (options.freemem ?? os.freemem)();
	const usedBytes = Math.max(0, totalBytes - freeBytes);
	return {
		ok: true,
		status: "ok",
		summary: `${formatBytes(freeBytes)} free of ${formatBytes(totalBytes)}`,
		totalBytes,
		freeBytes,
		usedBytes,
		usedPercent: percent(usedBytes, totalBytes),
	};
}

async function collectDocker(
	runCommand: HostOverviewOptions["runCommand"] & {},
	timeoutMs: number,
): Promise<HostOverview["docker"]> {
	const result = await runCommand("docker", [
		"info",
		"--format",
		"{{json .}}",
	], timeoutMs);
	const unavailable = commandUnavailable("docker", result);
	if (unavailable) {
		return { ...unavailable };
	}
	if (result.code !== 0) {
		return commandFailure("docker", result);
	}
	const info = record(parseJson(result.stdout));
	const containers = numberValue(info.Containers);
	const running = numberValue(info.ContainersRunning);
	const serverVersion = stringValue(info.ServerVersion);
	return {
		ok: true,
		status: "ok",
		summary: serverVersion
			? `docker ${serverVersion}${running !== undefined ? `, ${running} running` : ""}`
			: "docker is available",
		...(serverVersion ? { serverVersion } : {}),
		...(containers !== undefined ? { containers } : {}),
		...(running !== undefined ? { running } : {}),
		...(numberValue(info.ContainersPaused) !== undefined ? { paused: numberValue(info.ContainersPaused) } : {}),
		...(numberValue(info.ContainersStopped) !== undefined ? { stopped: numberValue(info.ContainersStopped) } : {}),
		...(numberValue(info.Images) !== undefined ? { images: numberValue(info.Images) } : {}),
	};
}

async function collectSystemd(
	runCommand: HostOverviewOptions["runCommand"] & {},
	timeoutMs: number,
): Promise<HostOverview["systemd"]> {
	const result = await runCommand("systemctl", [
		"list-units",
		"--failed",
		"--no-legend",
		"--no-pager",
		"--plain",
	], timeoutMs);
	const unavailable = commandUnavailable("systemctl", result);
	if (unavailable) {
		return { ...unavailable, failedUnits: [], truncated: false };
	}
	if (result.code !== 0) {
		return { ...commandFailure("systemd", result), failedUnits: [], truncated: false };
	}
	const lines = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const failedUnits = lines
		.slice(0, maxFailedUnits)
		.map(parseSystemdUnitLine);
	return {
		ok: failedUnits.length === 0,
		status: failedUnits.length === 0 ? "ok" : "degraded",
		summary: failedUnits.length === 0
			? "no failed systemd units"
			: `${failedUnits.length}${lines.length > failedUnits.length ? ` of ${lines.length}` : ""} failed systemd units`,
		failedUnits,
		truncated: lines.length > failedUnits.length,
	};
}

async function collectTailscale(
	runCommand: HostOverviewOptions["runCommand"] & {},
	timeoutMs: number,
): Promise<HostOverview["tailscale"]> {
	const result = await runCommand("tailscale", ["status", "--json"], timeoutMs);
	const unavailable = commandUnavailable("tailscale", result);
	if (unavailable) {
		return { ...unavailable, health: [] };
	}
	if (result.code !== 0) {
		return { ...commandFailure("tailscale", result), health: [] };
	}
	const status = record(parseJson(result.stdout));
	const backendState = stringValue(status.BackendState);
	const self = record(status.Self);
	const online = booleanValue(self.Online);
	const health = arrayValue(status.Health)
		.map((entry) => truncate(String(entry), 160))
		.slice(0, maxHealthMessages);
	const healthy = health.length === 0 &&
		(backendState === undefined || backendState === "Running") &&
		(online === undefined || online);
	return {
		ok: healthy,
		status: healthy ? "ok" : "degraded",
		summary: healthy
			? "tailscale healthy"
			: `tailscale ${backendState ?? "status"}${health.length > 0 ? `, ${health.length} health messages` : ""}`,
		...(backendState ? { backendState } : {}),
		...(online !== undefined ? { online } : {}),
		health,
	};
}

async function collectVersions(
	options: HostOverviewOptions,
	runCommand: HostOverviewOptions["runCommand"] & {},
	timeoutMs: number,
): Promise<HostOverview["versions"]> {
	const packageVersion = options.packageVersion ?? await readPackageVersion();
	const codexCommand = options.codexCommand ?? "codex";
	const [
		codexCli,
		docker,
		tailscale,
	] = await Promise.all([
		commandVersion("codex-cli", codexCommand, ["--version"], runCommand, timeoutMs),
		commandVersion("docker", "docker", ["--version"], runCommand, timeoutMs),
		commandVersion("tailscale", "tailscale", ["version"], runCommand, timeoutMs),
	]);
	const packages: HostOverviewVersion[] = [
		{
			name: "node",
			ok: true,
			status: "ok",
			version: process.version,
		},
		{
			name: "codex-toys",
			ok: packageVersion !== "unknown",
			status: packageVersion === "unknown" ? "unavailable" : "ok",
			version: packageVersion,
		},
		codexCli,
		docker,
		tailscale,
	];
	const ok = packages.every((entry) => entry.ok);
	return {
		ok,
		status: ok ? "ok" : "degraded",
		summary: packages
			.filter((entry) => entry.version)
			.map((entry) => `${entry.name} ${entry.version}`)
			.join("; "),
		packages,
		...(options.toyboxServerInfo ? { toybox: options.toyboxServerInfo } : {}),
	};
}

async function commandVersion(
	name: HostOverviewVersion["name"],
	command: string,
	args: string[],
	runCommand: HostOverviewOptions["runCommand"] & {},
	timeoutMs: number,
): Promise<HostOverviewVersion> {
	const result = await runCommand(command, args, timeoutMs);
	const unavailable = commandUnavailable(name, result);
	if (unavailable) {
		return { name, ...unavailable };
	}
	if (result.code !== 0) {
		const failed = commandFailure(name, result);
		return {
			name,
			ok: false,
			status: failed.status,
			error: failed.error,
		};
	}
	return {
		name,
		ok: true,
		status: "ok",
		version: firstLine(result.stdout) ?? firstLine(result.stderr) ?? "available",
	};
}

function parseSystemdUnitLine(line: string): HostOverviewFailedUnit {
	const parts = line.split(/\s+/);
	const [unit, load, active, sub, ...description] = parts;
	return {
		unit: unit ?? "unknown",
		...(load ? { load } : {}),
		...(active ? { active } : {}),
		...(sub ? { sub } : {}),
		...(description.length > 0 ? { description: truncate(description.join(" "), 160) } : {}),
	};
}

async function readPackageVersion(): Promise<string> {
	try {
		const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
		const parsed = record(JSON.parse(raw) as unknown);
		return stringValue(parsed.version) ?? "unknown";
	} catch {
		return "unknown";
	}
}

async function runBoundedCommand(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<HostOverviewCommandResult> {
	return await new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const finish = (result: HostOverviewCommandResult) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const append = (current: string, chunk: string) =>
			truncateBytes(current + chunk, maxCommandOutputBytes);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout = append(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr = append(stderr, chunk);
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);
		child.on("error", (error) => {
			finish({
				code: errorMessage(error).includes("ENOENT") ? 127 : 1,
				signal: null,
				stdout,
				stderr,
				error: errorMessage(error),
			});
		});
		child.on("exit", (code, signal) => {
			finish({ code: timedOut ? 124 : code, signal, stdout, stderr, timedOut });
		});
	});
}

function commandUnavailable(
	name: string,
	result: HostOverviewCommandResult,
): HostOverviewSection | undefined {
	if (result.code === 127 || result.error?.includes("ENOENT")) {
		return {
			ok: false,
			status: "unavailable",
			summary: `${name} is unavailable`,
			error: `${name} not found`,
		};
	}
	return undefined;
}

function commandFailure(
	name: string,
	result: HostOverviewCommandResult,
): HostOverviewSection {
	const status = result.timedOut || result.code === 124 ? "timeout" : "error";
	const stderr = firstLine(result.stderr);
	const stdout = firstLine(result.stdout);
	return {
		ok: false,
		status,
		summary: `${name} probe ${status}`,
		error: result.error ?? stderr ?? stdout ?? `exited with code ${result.code ?? "unknown"}`,
	};
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return {};
	}
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function firstLine(value: string): string | undefined {
	const line = value.trim().split(/\r?\n/)[0]?.trim();
	return line ? truncate(line, 160) : undefined;
}

function percent(value: number, total: number): number {
	if (total <= 0) {
		return 0;
	}
	return Math.round((value / total) * 1000) / 10;
}

function formatBytes(value: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let amount = value;
	let unit = units[0] ?? "B";
	for (const candidate of units) {
		unit = candidate;
		if (Math.abs(amount) < 1024 || candidate === units[units.length - 1]) {
			break;
		}
		amount /= 1024;
	}
	return `${amount >= 10 || unit === "B" ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function truncateBytes(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value) <= maxBytes) {
		return value;
	}
	return Buffer.from(value).subarray(0, maxBytes).toString("utf8");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
