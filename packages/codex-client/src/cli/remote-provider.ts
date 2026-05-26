import { CodexStdioTransport } from "../app-server/stdio-transport.ts";
import type { CodexWorkspaceBackendTransport } from "../workspace-backend/client.ts";
import { parseJsonText } from "./json.ts";

export type SshRemoteProviderOptions = {
	sshTarget?: string;
	cwd?: string;
	remotePathPrepend?: string;
	remoteAgentCommand?: string;
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
	remoteAgentCommand: string;
	remoteCodexCommand: string;
	remoteCodexArgs: string[];
	timeoutMs: number;
};

export type SshRemoteAgentPlan = {
	kind: "remote-agent";
	command: string[];
	remoteCommand: string;
};

export type SshRemoteAgentTransport = CodexStdioTransport & {
	remoteAgentPlan: SshRemoteAgentPlan;
	remoteAgentStderr: string[];
};

const removedRemoteEnvVars = [
	"CODEX_FLOWS_REMOTE_MODE",
	"CODEX_FLOWS_REMOTE_TUNNEL_PORT",
	"CODEX_FLOWS_REMOTE_BACKEND_HOST",
	"CODEX_FLOWS_REMOTE_BACKEND_PORT",
	"CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND",
	"CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_ARGS",
];

export function hasSshRemote(
	options: Pick<SshRemoteProviderOptions, "sshTarget" | "env">,
): boolean {
	return Boolean(options.sshTarget ?? options.env?.CODEX_FLOWS_REMOTE_SSH_TARGET);
}

export function resolveSshRemoteOptions(
	options: SshRemoteProviderOptions,
): ResolvedSshRemoteOptions {
	const env = options.env ?? process.env;
	rejectRemovedRemoteEnvVars(env);
	const sshTarget = options.sshTarget ?? env.CODEX_FLOWS_REMOTE_SSH_TARGET;
	if (!sshTarget?.trim()) {
		throw new Error(
			"SSH remote provider requires --ssh <target> or CODEX_FLOWS_REMOTE_SSH_TARGET",
		);
	}
	const remoteAgentCommand = options.remoteAgentCommand ??
		env.CODEX_FLOWS_REMOTE_AGENT_COMMAND ??
		"codex-flows";
	const remoteCodexCommand = options.remoteCodexCommand ??
		env.CODEX_FLOWS_REMOTE_CODEX_COMMAND ??
		"codex";
	rejectInlineEnvCommand(
		"CODEX_FLOWS_REMOTE_AGENT_COMMAND",
		remoteAgentCommand,
	);
	rejectInlineEnvCommand(
		"CODEX_FLOWS_REMOTE_CODEX_COMMAND",
		remoteCodexCommand,
	);
	return {
		sshTarget,
		...(options.cwd ?? env.CODEX_FLOWS_REMOTE_CWD
			? { cwd: options.cwd ?? env.CODEX_FLOWS_REMOTE_CWD }
			: {}),
		...(options.remotePathPrepend ?? env.CODEX_FLOWS_REMOTE_PATH_PREPEND
			? { remotePathPrepend: options.remotePathPrepend ?? env.CODEX_FLOWS_REMOTE_PATH_PREPEND }
			: {}),
		sshCommand: env.CODEX_FLOWS_SSH_COMMAND ?? "ssh",
		remoteAgentCommand,
		remoteCodexCommand,
		remoteCodexArgs: options.remoteCodexArgs ??
			envJsonStringArray(env.CODEX_FLOWS_REMOTE_CODEX_ARGS, "CODEX_FLOWS_REMOTE_CODEX_ARGS") ??
			[],
		timeoutMs: options.timeoutMs,
	};
}

export function createSshRemoteAgentPlan(
	options: SshRemoteProviderOptions,
): SshRemoteAgentPlan {
	const resolved = resolveSshRemoteOptions(options);
	const remoteAgentArgs = [
		"remote-agent",
		"serve",
		"--timeout-ms",
		String(resolved.timeoutMs),
		...(resolved.cwd ? ["--cwd", resolved.cwd] : []),
		"--remote-codex-command",
		resolved.remoteCodexCommand,
		...resolved.remoteCodexArgs.flatMap((arg) => ["--remote-codex-arg", arg]),
	];
	const remoteCommand = withRemoteBootstrap(
		resolved,
		`exec ${shellCommand(resolved.remoteAgentCommand, remoteAgentArgs)}`,
	);
	return {
		kind: "remote-agent",
		command: [
			resolved.sshCommand,
			"-T",
			resolved.sshTarget,
			remoteCommand,
		],
		remoteCommand,
	};
}

export function createSshRemoteAgentTransport(
	options: SshRemoteProviderOptions,
): SshRemoteAgentTransport {
	const plan = createSshRemoteAgentPlan(options);
	const stderr: string[] = [];
	const transport = new CodexStdioTransport({
		codexCommand: plan.command[0],
		args: plan.command.slice(1),
		requestTimeoutMs: options.timeoutMs,
	}) as SshRemoteAgentTransport;
	transport.remoteAgentPlan = plan;
	transport.remoteAgentStderr = stderr;
	transport.on("stderr", (line) => {
		stderr.push(line);
		trimBuffer(stderr);
	});
	return transport;
}

export async function withSshRemoteWorkspaceTransport<T>(
	options: SshRemoteProviderOptions,
	callback: (transport: CodexWorkspaceBackendTransport) => Promise<T>,
): Promise<T> {
	const resolved = resolveSshRemoteOptions(options);
	const transport = createSshRemoteAgentTransport(options);
	try {
		transport.start();
		return await callback(transport);
	} catch (error) {
		throw remoteProviderError(error, resolved, transport.remoteAgentStderr);
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
			"SSH remote provider could not use the CodexFlows remote agent.",
			`target: ${resolved.sshTarget}`,
			`cwd: ${resolved.cwd ?? "(not set)"}`,
			`remote path prepend: ${resolved.remotePathPrepend ?? "(not set)"}`,
			`remote agent command: ${resolved.remoteAgentCommand}`,
			`remote codex command: ${
				[resolved.remoteCodexCommand, ...resolved.remoteCodexArgs].join(" ")
			}`,
			`error: ${errorMessage(error)}`,
			...(remoteOutput
				? [`remote stderr:\n${redact(remoteOutput).split(/\r?\n/).slice(0, 20).join("\n")}`]
				: []),
			"Install @peezy.tech/codex-flows on the SSH target, ensure node and codex are available in the non-interactive SSH PATH, or set CODEX_FLOWS_REMOTE_PATH_PREPEND / CODEX_FLOWS_REMOTE_AGENT_COMMAND / CODEX_FLOWS_REMOTE_CODEX_COMMAND.",
		].join("\n"),
	);
}

function rejectInlineEnvCommand(label: string, command: string): void {
	if (/^\s*[A-Za-z_][A-Za-z0-9_]*=.*\s+\S/.test(command)) {
		throw new Error(
			`${label} must be a command name or path, not an inline environment assignment. ` +
				"Set CODEX_FLOWS_REMOTE_PATH_PREPEND for PATH changes or use an absolute command path.",
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
		}. Install @peezy.tech/codex-flows on the SSH target and use the remote-agent provider instead.`,
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
