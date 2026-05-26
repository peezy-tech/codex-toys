import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServerClient } from "../app-server/client.ts";
import { CodexStdioTransport } from "../app-server/stdio-transport.ts";
import { CodexWebSocketTransport } from "../app-server/websocket-transport.ts";
import { WORKSPACE_BACKEND_INITIALIZE_METHOD } from "../workspace-backend/protocol.ts";
import { parseJsonText } from "./json.ts";

export type RemoteMode = "existing" | "spawn";

export type SshRemoteProviderOptions = {
	sshTarget?: string;
	cwd?: string;
	remoteMode?: RemoteMode;
	localPort?: number;
	remoteHost?: string;
	remotePort?: number;
	remotePathPrepend?: string;
	remoteCodexCommand?: string;
	remoteCodexArgs?: string[];
	remoteWorkspaceBackendCommand?: string;
	remoteWorkspaceBackendArgs?: string[];
	timeoutMs: number;
	env?: Record<string, string | undefined>;
};

export type ResolvedSshRemoteOptions = {
	sshTarget: string;
	cwd?: string;
	remoteMode: RemoteMode;
	localPort: number;
	remoteHost: string;
	remotePort: number;
	remotePathPrepend?: string;
	sshCommand: string;
	remoteCodexCommand: string;
	remoteCodexArgs: string[];
	remoteWorkspaceBackendCommand: string;
	remoteWorkspaceBackendArgs: string[];
	timeoutMs: number;
};

export type SshCommandPlan = {
	kind: "existing-backend" | "spawn-backend" | "app-server";
	workspaceUrl?: string;
	command: string[];
	remoteCommand?: string;
};

export type SshWorkspaceBackendHandle = {
	kind: "ssh-existing-backend" | "ssh-spawn-backend";
	workspaceUrl: string;
	close(): void;
};

type ProcessHandle = {
	child: ChildProcess;
	stderr: string[];
	stdout: string[];
	error?: Error;
	close(): void;
};

export function hasSshRemote(
	options: Pick<SshRemoteProviderOptions, "sshTarget" | "env">,
): boolean {
	return Boolean(options.sshTarget ?? options.env?.CODEX_FLOWS_REMOTE_SSH_TARGET);
}

export function parseRemoteMode(value: string | undefined): RemoteMode {
	if (!value || value === "spawn") {
		return "spawn";
	}
	if (value === "existing") {
		return value;
	}
	throw new Error("--remote-mode must be existing or spawn");
}

export function resolveSshRemoteOptions(
	options: SshRemoteProviderOptions,
): ResolvedSshRemoteOptions {
	const env = options.env ?? process.env;
	const sshTarget = options.sshTarget ?? env.CODEX_FLOWS_REMOTE_SSH_TARGET;
	if (!sshTarget?.trim()) {
		throw new Error(
			"SSH remote provider requires --ssh <target> or CODEX_FLOWS_REMOTE_SSH_TARGET",
		);
	}
	const remoteCodexCommand = options.remoteCodexCommand ??
		env.CODEX_FLOWS_REMOTE_CODEX_COMMAND ??
		"codex";
	const remoteWorkspaceBackendCommand =
		options.remoteWorkspaceBackendCommand ??
		env.CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND ??
		"codex-workspace-backend-local";
	rejectInlineEnvCommand(
		"CODEX_FLOWS_REMOTE_CODEX_COMMAND",
		remoteCodexCommand,
	);
	rejectInlineEnvCommand(
		"CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND",
		remoteWorkspaceBackendCommand,
	);
	return {
		sshTarget,
		...(options.cwd ?? env.CODEX_FLOWS_REMOTE_CWD
			? { cwd: options.cwd ?? env.CODEX_FLOWS_REMOTE_CWD }
			: {}),
		remoteMode: options.remoteMode ?? parseRemoteMode(env.CODEX_FLOWS_REMOTE_MODE),
		localPort: options.localPort ??
			envInteger(env.CODEX_FLOWS_REMOTE_TUNNEL_PORT) ??
			3586,
		remoteHost: options.remoteHost ??
			env.CODEX_FLOWS_REMOTE_BACKEND_HOST ??
			"127.0.0.1",
		remotePort: options.remotePort ??
			envInteger(env.CODEX_FLOWS_REMOTE_BACKEND_PORT) ??
			3586,
		...(options.remotePathPrepend ?? env.CODEX_FLOWS_REMOTE_PATH_PREPEND
			? { remotePathPrepend: options.remotePathPrepend ?? env.CODEX_FLOWS_REMOTE_PATH_PREPEND }
			: {}),
		sshCommand: env.CODEX_FLOWS_SSH_COMMAND ?? "ssh",
		remoteCodexCommand,
		remoteCodexArgs: options.remoteCodexArgs ??
			envJsonStringArray(env.CODEX_FLOWS_REMOTE_CODEX_ARGS, "CODEX_FLOWS_REMOTE_CODEX_ARGS") ??
			[],
		remoteWorkspaceBackendCommand,
		remoteWorkspaceBackendArgs: options.remoteWorkspaceBackendArgs ??
			envJsonStringArray(
				env.CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_ARGS,
				"CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_ARGS",
			) ??
			[],
		timeoutMs: options.timeoutMs,
	};
}

export function createSshExistingBackendTunnelPlan(
	options: SshRemoteProviderOptions,
): SshCommandPlan {
	const resolved = resolveSshRemoteOptions(options);
	return {
		kind: "existing-backend",
		workspaceUrl: workspaceUrl(resolved.localPort),
		command: [
			resolved.sshCommand,
			"-N",
			"-o",
			"ExitOnForwardFailure=yes",
			"-L",
			`${resolved.localPort}:${resolved.remoteHost}:${resolved.remotePort}`,
			resolved.sshTarget,
		],
	};
}

export function createSshSpawnBackendPlan(
	options: SshRemoteProviderOptions,
): SshCommandPlan {
	const resolved = resolveSshRemoteOptions(options);
	const args = [
		"serve",
		"--host",
		resolved.remoteHost,
		"--port",
		String(resolved.remotePort),
		"--local-app-server",
		...(resolved.cwd ? ["--cwd", resolved.cwd] : []),
	];
	const codexCommand = shellCommand(
		resolved.remoteCodexCommand,
		resolved.remoteCodexArgs,
	);
	const envPrefix = resolved.remoteCodexCommand === "codex" &&
			resolved.remoteCodexArgs.length === 0
		? ""
		: `CODEX_APP_SERVER_CODEX_COMMAND=${shellQuote(codexCommand)} `;
	const remoteCommand = withRemoteBootstrap(
		resolved,
		`${envPrefix}exec ${
			shellCommand(resolved.remoteWorkspaceBackendCommand, [
				...resolved.remoteWorkspaceBackendArgs,
				...args,
			])
		}`,
	);
	return {
		kind: "spawn-backend",
		workspaceUrl: workspaceUrl(resolved.localPort),
		command: [
			resolved.sshCommand,
			"-T",
			"-o",
			"ExitOnForwardFailure=yes",
			"-L",
			`${resolved.localPort}:${resolved.remoteHost}:${resolved.remotePort}`,
			resolved.sshTarget,
			remoteCommand,
		],
		remoteCommand,
	};
}

export function createSshAppServerPlan(
	options: SshRemoteProviderOptions,
): SshCommandPlan {
	const resolved = resolveSshRemoteOptions(options);
	const args = [
		"app-server",
		"--listen",
		"stdio://",
		"--enable",
		"apps",
		"--enable",
		"hooks",
	];
	const remoteCommand = withRemoteBootstrap(
		resolved,
		`exec ${shellCommand(resolved.remoteCodexCommand, [
			...resolved.remoteCodexArgs,
			...args,
		])}`,
	);
	return {
		kind: "app-server",
		command: [
			resolved.sshCommand,
			"-T",
			resolved.sshTarget,
			remoteCommand,
		],
		remoteCommand,
	};
}

export async function startSshWorkspaceBackend(
	options: SshRemoteProviderOptions,
): Promise<SshWorkspaceBackendHandle> {
	const resolved = resolveSshRemoteOptions(options);
	const failures: string[] = [];
	if (resolved.remoteMode === "existing") {
		try {
			return await startWorkspacePlan(
				createSshExistingBackendTunnelPlan(options),
				"ssh-existing-backend",
				resolved.timeoutMs,
			);
			} catch (error) {
				failures.push(`existing backend: ${errorMessage(error)}`);
				throw remoteProviderError(failures, resolved);
			}
	}
	try {
		return await startWorkspacePlan(
			createSshSpawnBackendPlan(options),
			"ssh-spawn-backend",
			resolved.timeoutMs,
		);
	} catch (error) {
		failures.push(`spawn backend: ${errorMessage(error)}`);
	}
	throw remoteProviderError(failures, resolved);
}

export function createSshAppServerClient(
	options: SshRemoteProviderOptions,
	clientInfo: { name: string; title: string; version?: string },
): CodexAppServerClient {
	const plan = createSshAppServerPlan(options);
	const transport = new CodexStdioTransport({
		codexCommand: plan.command[0],
		args: plan.command.slice(1),
		requestTimeoutMs: options.timeoutMs,
	});
	return new CodexAppServerClient({
		transport,
		clientName: clientInfo.name,
		clientTitle: clientInfo.title,
		clientVersion: clientInfo.version ?? "0.1.0",
	});
}

async function startWorkspacePlan(
	plan: SshCommandPlan,
	kind: SshWorkspaceBackendHandle["kind"],
	timeoutMs: number,
): Promise<SshWorkspaceBackendHandle> {
	if (!plan.workspaceUrl) {
		throw new Error("SSH workspace plan did not include a workspace URL");
	}
	const processHandle = spawnRemoteProcess(plan.command);
	try {
		await waitForWorkspaceBackend(plan.workspaceUrl, timeoutMs, processHandle);
	} catch (error) {
		processHandle.close();
		throw error;
	}
	return {
		kind,
		workspaceUrl: plan.workspaceUrl,
		close: () => processHandle.close(),
	};
}

function spawnRemoteProcess(command: string[]): ProcessHandle {
	const stderr: string[] = [];
	const stdout: string[] = [];
	let spawnError: Error | undefined;
	const child = spawn(command[0]!, command.slice(1), {
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	child.on("error", (error) => {
		spawnError = error;
		stderr.push(error.message);
		trimBuffer(stderr);
	});
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout.push(chunk);
		trimBuffer(stdout);
	});
	child.stderr?.on("data", (chunk: string) => {
		stderr.push(chunk);
		trimBuffer(stderr);
	});
	return {
		child,
		stderr,
		stdout,
		get error() {
			return spawnError;
		},
		close: () => closeChild(child),
	};
}

async function waitForWorkspaceBackend(
	url: string,
	timeoutMs: number,
	processHandle: ProcessHandle,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (processHandle.error) {
			throw processHandle.error;
		}
		if (processHandle.child.exitCode !== null) {
			throw new Error(
				`ssh process exited before workspace backend became ready: ${
					processHandle.child.exitCode
				}${processOutputSuffix(processHandle)}`,
			);
		}
		try {
			await probeWorkspaceBackend(url, Math.min(1_000, timeoutMs));
			return;
		} catch (error) {
			lastError = error;
			await delay(150);
		}
	}
	throw new Error(
		`workspace backend did not become ready at ${url}: ${errorMessage(lastError)}${
			processOutputSuffix(processHandle)
		}`,
	);
}

async function probeWorkspaceBackend(url: string, timeoutMs: number): Promise<void> {
	const transport = new CodexWebSocketTransport({ url, requestTimeoutMs: timeoutMs });
	transport.on("error", () => {});
	try {
		transport.start();
		await transport.request(WORKSPACE_BACKEND_INITIALIZE_METHOD, {
			clientInfo: {
				name: "codex-flows-ssh-provider",
				title: "Codex Flows SSH Provider",
				version: "0.1.0",
			},
			capabilities: {
				appServerPassThrough: true,
			},
		});
	} finally {
		transport.close();
	}
}

function workspaceUrl(localPort: number): string {
	return `ws://127.0.0.1:${localPort}`;
}

function withRemoteBootstrap(
	options: Pick<ResolvedSshRemoteOptions, "cwd" | "remotePathPrepend">,
	command: string,
): string {
	const parts = [];
	if (options.cwd) {
		parts.push(`cd ${shellQuote(options.cwd)}`);
	}
	if (options.remotePathPrepend) {
		parts.push(
			`export PATH=${shellQuote(options.remotePathPrepend)}\${PATH:+":$PATH"}`,
		);
	}
	parts.push(command);
	return parts.join(" && ");
}

function shellCommand(command: string, args: string[]): string {
	return [shellQuote(command), ...args.map(shellQuote)].join(" ");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function closeChild(child: ChildProcess): void {
	if (child.exitCode !== null) {
		return;
	}
	signalChild(child, "SIGTERM");
	const timer = setTimeout(() => {
		if (child.exitCode !== null) {
			return;
		}
		signalChild(child, "SIGKILL");
	}, 1_000);
	timer.unref();
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
	let signaled = false;
	if (process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid, signal);
			signaled = true;
		} catch {
			// Fall back to the direct child below.
		}
	}
	if (!signaled) {
		try {
			child.kill(signal);
		} catch {
			// Process may have already exited.
		}
	}
}

function processOutputSuffix(processHandle: ProcessHandle): string {
	const output = [...processHandle.stderr, ...processHandle.stdout].join("").trim();
	return output ? `\n${redact(output).split(/\r?\n/).slice(0, 20).join("\n")}` : "";
}

function remoteProviderError(
	failures: string[],
	resolved: ResolvedSshRemoteOptions,
): Error {
	return new Error(
		[
			"SSH remote provider could not connect to a workspace backend.",
			`target: ${resolved.sshTarget}`,
			`cwd: ${resolved.cwd ?? "(not set)"}`,
			`remote path prepend: ${resolved.remotePathPrepend ?? "(not set)"}`,
			`remote codex command: ${
				[resolved.remoteCodexCommand, ...resolved.remoteCodexArgs].join(" ")
			}`,
			`remote workspace backend command: ${
				[resolved.remoteWorkspaceBackendCommand, ...resolved.remoteWorkspaceBackendArgs].join(" ")
			}`,
			...failures.map((failure) => `- ${failure}`),
			"Ensure the remote non-interactive SSH environment has node, codex-workspace-backend-local, and codex on PATH.",
			"Set CODEX_FLOWS_REMOTE_PATH_PREPEND for remote bin directories, or use absolute CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND / CODEX_FLOWS_REMOTE_CODEX_COMMAND values.",
		].join("\n"),
	);
}

function trimBuffer(chunks: string[]): void {
	while (chunks.join("").length > 4_000) {
		chunks.shift();
	}
}

function envInteger(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function rejectInlineEnvCommand(label: string, command: string): void {
	if (/^\s*[A-Za-z_][A-Za-z0-9_]*=.*\s+\S/.test(command)) {
		throw new Error(
			`${label} must be a command name or path, not an inline environment assignment. ` +
				"Set CODEX_FLOWS_REMOTE_PATH_PREPEND for PATH changes or use an absolute command path.",
		);
	}
}

function redact(value: string): string {
	return value
		.replace(/(token|password|secret|key)=\S+/gi, "$1=<redacted>")
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, "$1<redacted>");
}

function envJsonStringArray(value: string | undefined, label: string): string[] | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = parseJsonText(value, label);
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
		throw new Error(`${label} must be a JSON array of strings`);
	}
	return parsed as string[];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
