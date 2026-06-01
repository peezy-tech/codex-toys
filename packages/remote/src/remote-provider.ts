import { CodexStdioTransport } from "@codex-toys/bridge/app-server/stdio-transport";
import type { CodexToyboxTransport } from "@codex-toys/toybox";
import { parseJsonText } from "@codex-toys/bridge/json";

export type SshRemoteProviderOptions = {
	sshTarget?: string;
	cwd?: string;
	remotePathPrepend?: string;
	toyboxCommand?: string;
	remoteCodexCommand?: string;
	remoteCodexArgs?: string[];
	timeoutMs: number;
	env?: Record<string, string | undefined>;
};

export type ResolvedSshRemoteOptions = {
	sshTarget: string;
	cwd?: string;
	remotePathPrepend?: string;
	sshCommand: string;
	toyboxCommand: string;
	remoteCodexCommand: string;
	remoteCodexArgs: string[];
	timeoutMs: number;
};

export type ToyboxPlan = {
	kind: "toybox";
	command: string[];
	remoteCommand: string;
};

export type ToyboxTransport = CodexStdioTransport & {
	toyboxPlan: ToyboxPlan;
	toyboxStderr: string[];
};

const removedRemoteEnvVars = [
	"CODEX_TOYS_REMOTE_MODE",
	"CODEX_TOYS_REMOTE_TUNNEL_PORT",
	"CODEX_TOYS_REMOTE_BACKEND_HOST",
	"CODEX_TOYS_REMOTE_BACKEND_PORT",
	"CODEX_TOYS_REMOTE_TOYBOX_COMMAND",
	"CODEX_TOYS_REMOTE_TOYBOX_ARGS",
];

export function hasSshRemote(
	options: Pick<SshRemoteProviderOptions, "sshTarget" | "env">,
): boolean {
	return Boolean(options.sshTarget ?? options.env?.CODEX_TOYS_REMOTE_SSH_TARGET);
}

export function resolveSshRemoteOptions(
	options: SshRemoteProviderOptions,
): ResolvedSshRemoteOptions {
	const env = options.env ?? process.env;
	rejectRemovedRemoteEnvVars(env);
	const sshTarget = options.sshTarget ?? env.CODEX_TOYS_REMOTE_SSH_TARGET;
	if (!sshTarget?.trim()) {
		throw new Error(
			"SSH remote provider requires --ssh <target> or CODEX_TOYS_REMOTE_SSH_TARGET",
		);
	}
	const toyboxCommand = options.toyboxCommand ??
		env.CODEX_TOYS_TOYBOX_COMMAND ??
		"codex-toys";
	const remoteCodexCommand = options.remoteCodexCommand ??
		env.CODEX_TOYS_REMOTE_CODEX_COMMAND ??
		"codex";
	rejectInlineEnvCommand(
		"CODEX_TOYS_TOYBOX_COMMAND",
		toyboxCommand,
	);
	rejectInlineEnvCommand(
		"CODEX_TOYS_REMOTE_CODEX_COMMAND",
		remoteCodexCommand,
	);
	return {
		sshTarget,
		...(options.cwd ?? env.CODEX_TOYS_REMOTE_CWD
			? { cwd: options.cwd ?? env.CODEX_TOYS_REMOTE_CWD }
			: {}),
		...(options.remotePathPrepend ?? env.CODEX_TOYS_REMOTE_PATH_PREPEND
			? { remotePathPrepend: options.remotePathPrepend ?? env.CODEX_TOYS_REMOTE_PATH_PREPEND }
			: {}),
		sshCommand: env.CODEX_TOYS_SSH_COMMAND ?? "ssh",
		toyboxCommand,
		remoteCodexCommand,
		remoteCodexArgs: options.remoteCodexArgs ??
			envJsonStringArray(env.CODEX_TOYS_REMOTE_CODEX_ARGS, "CODEX_TOYS_REMOTE_CODEX_ARGS") ??
			[],
		timeoutMs: options.timeoutMs,
	};
}

export function createSshToyboxPlan(
	options: SshRemoteProviderOptions,
): ToyboxPlan {
	const resolved = resolveSshRemoteOptions(options);
	const toyboxArgs = [
		"toybox",
		"serve",
		"--timeout-ms",
		String(resolved.timeoutMs),
		...(resolved.cwd ? ["--cwd", resolved.cwd] : []),
		"--codex-command",
		resolved.remoteCodexCommand,
		...resolved.remoteCodexArgs.flatMap((arg) => ["--codex-arg", arg]),
	];
	const remoteCommand = withRemoteBootstrap(
		resolved,
		`exec ${shellCommand(resolved.toyboxCommand, toyboxArgs)}`,
	);
	return {
		kind: "toybox",
		command: [
			resolved.sshCommand,
			"-T",
			resolved.sshTarget,
			remoteCommand,
		],
		remoteCommand,
	};
}

export function createSshToyboxTransport(
	options: SshRemoteProviderOptions,
): ToyboxTransport {
	const plan = createSshToyboxPlan(options);
	const stderr: string[] = [];
	const transport = new CodexStdioTransport({
		codexCommand: plan.command[0],
		args: plan.command.slice(1),
		requestTimeoutMs: options.timeoutMs,
	}) as ToyboxTransport;
	transport.toyboxPlan = plan;
	transport.toyboxStderr = stderr;
	transport.on("stderr", (line) => {
		stderr.push(line);
		trimBuffer(stderr);
	});
	return transport;
}

export function createLocalToyboxTransport(
	options: Pick<SshRemoteProviderOptions, "cwd" | "toyboxCommand" | "remoteCodexCommand" | "remoteCodexArgs" | "timeoutMs" | "env">,
): ToyboxTransport {
	const env = options.env ?? process.env;
	const toyboxCommand = options.toyboxCommand ??
		env.CODEX_TOYS_TOYBOX_COMMAND ??
		"codex-toys";
	const codexCommand = options.remoteCodexCommand ??
		env.CODEX_TOYS_CODEX_COMMAND ??
		env.CODEX_TOYS_REMOTE_CODEX_COMMAND ??
		"codex";
	const codexArgs = options.remoteCodexArgs ??
		envJsonStringArray(env.CODEX_TOYS_CODEX_ARGS, "CODEX_TOYS_CODEX_ARGS") ??
		envJsonStringArray(env.CODEX_TOYS_REMOTE_CODEX_ARGS, "CODEX_TOYS_REMOTE_CODEX_ARGS") ??
		[];
	const command = [
		toyboxCommand,
		"toybox",
		"serve",
		"--timeout-ms",
		String(options.timeoutMs),
		...(options.cwd ? ["--cwd", options.cwd] : []),
		"--codex-command",
		codexCommand,
		...codexArgs.flatMap((arg) => ["--codex-arg", arg]),
	];
	const transport = new CodexStdioTransport({
		codexCommand: command[0],
		args: command.slice(1),
		requestTimeoutMs: options.timeoutMs,
	}) as ToyboxTransport;
	transport.toyboxPlan = {
		kind: "toybox",
		command,
		remoteCommand: shellCommand(command[0]!, command.slice(1)),
	};
	transport.toyboxStderr = [];
	transport.on("stderr", (line) => {
		transport.toyboxStderr.push(line);
		trimBuffer(transport.toyboxStderr);
	});
	return transport;
}

export async function withSshRemoteToyboxTransport<T>(
	options: SshRemoteProviderOptions,
	callback: (transport: CodexToyboxTransport) => Promise<T>,
): Promise<T> {
	const resolved = resolveSshRemoteOptions(options);
	const transport = createSshToyboxTransport(options);
	try {
		transport.start();
		return await callback(transport);
	} catch (error) {
		throw remoteProviderError(error, resolved, transport.toyboxStderr);
	} finally {
		transport.close();
	}
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

function remoteProviderError(
	error: unknown,
	resolved: ResolvedSshRemoteOptions,
	stderr: string[],
): Error {
	const remoteOutput = stderr.join("\n").trim();
	return new Error(
		[
			"SSH remote provider could not use the CodexToys remote toybox.",
			`target: ${resolved.sshTarget}`,
			`cwd: ${resolved.cwd ?? "(not set)"}`,
			`remote path prepend: ${resolved.remotePathPrepend ?? "(not set)"}`,
			`toybox command: ${resolved.toyboxCommand}`,
			`remote codex command: ${
				[resolved.remoteCodexCommand, ...resolved.remoteCodexArgs].join(" ")
			}`,
			`error: ${errorMessage(error)}`,
			...(remoteOutput
				? [`remote stderr:\n${redact(remoteOutput).split(/\r?\n/).slice(0, 20).join("\n")}`]
				: []),
			"Install codex-toys on the SSH target, ensure node and codex are available in the non-interactive SSH PATH, or set CODEX_TOYS_REMOTE_PATH_PREPEND / CODEX_TOYS_TOYBOX_COMMAND / CODEX_TOYS_REMOTE_CODEX_COMMAND.",
		].join("\n"),
	);
}

function rejectInlineEnvCommand(label: string, command: string): void {
	if (/^\s*[A-Za-z_][A-Za-z0-9_]*=.*\s+\S/.test(command)) {
		throw new Error(
			`${label} must be a command name or path, not an inline environment assignment. ` +
				"Set CODEX_TOYS_REMOTE_PATH_PREPEND for PATH changes or use an absolute command path.",
		);
	}
}

function rejectRemovedRemoteEnvVars(env: Record<string, string | undefined>): void {
	const present = removedRemoteEnvVars.filter((name) => env[name]?.trim());
	if (present.length === 0) {
		return;
	}
	throw new Error(
		`Removed SSH backend/tunnel environment variables are no longer supported: ${
			present.join(", ")
			}. Install codex-toys on the SSH target and use the SSH toybox provider instead.`,
	);
}

function envJsonStringArray(value: string | undefined, label: string): string[] | undefined {
	if (!value?.trim()) {
		return undefined;
	}
	const parsed = parseJsonText(value, label);
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
		throw new Error(`${label} must be a JSON array of strings`);
	}
	return parsed as string[];
}

function trimBuffer(chunks: string[]): void {
	while (chunks.join("\n").length > 4_000) {
		chunks.shift();
	}
}

function redact(value: string): string {
	return value
		.replace(/(token|password|secret|key)=\S+/gi, "$1=<redacted>")
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, "$1<redacted>");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
