import { spawn } from "node:child_process";
import type { CodexWorkspaceBackendTransport } from "../workspace-backend/client.ts";
import {
	APP_SERVER_CALL_METHOD,
	WORKSPACE_BACKEND_INITIALIZE_METHOD,
} from "../workspace-backend/protocol.ts";
import {
	createSshAgentTransport,
	resolveSshRemoteOptions,
	type ResolvedSshRemoteOptions,
	type SshRemoteProviderOptions,
} from "./remote-provider.ts";

export type RemotePreflightCheck = {
	name: string;
	status: "ok" | "fail" | "skip";
	detail?: string;
	path?: string;
	version?: string;
	error?: string;
	suggestion?: string;
	stderr?: string;
};

export type RemotePreflightResult = {
	ok: boolean;
	sshTarget: string;
	cwd?: string;
	remotePathPrepend?: string;
	agentCommand: string;
	remoteCodexCommand: string;
	remoteCodexArgs: string[];
	checks: RemotePreflightCheck[];
};

type ShellResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

export async function collectRemotePreflight(
	options: SshRemoteProviderOptions,
): Promise<RemotePreflightResult> {
	const resolved = resolveSshRemoteOptions(options);
	const checks: RemotePreflightCheck[] = [];
	const result: RemotePreflightResult = {
		ok: false,
		sshTarget: resolved.sshTarget,
		...(resolved.cwd ? { cwd: resolved.cwd } : {}),
		...(resolved.remotePathPrepend ? { remotePathPrepend: resolved.remotePathPrepend } : {}),
		agentCommand: resolved.agentCommand,
		remoteCodexCommand: resolved.remoteCodexCommand,
		remoteCodexArgs: resolved.remoteCodexArgs,
		checks,
	};

	const ssh = await runRemoteShell(resolved, "true", options.timeoutMs);
	if (ssh.code !== 0) {
		checks.push(failCheck(
			"SSH",
			ssh,
			"Fix local OpenSSH config, target reachability, or use --ssh user@host.",
		));
		return result;
	}
	checks.push({ name: "SSH", status: "ok" });

	if (resolved.cwd) {
		const cwd = await runRemoteShell(
			resolved,
			`test -d ${shellQuote(resolved.cwd)} && printf '%s\\n' ${shellQuote(resolved.cwd)}`,
			options.timeoutMs,
		);
		if (cwd.code !== 0) {
			checks.push(failCheck(
				"cwd",
				cwd,
				"Create the remote workspace directory or pass --cwd /path/to/workspace.",
			));
			return result;
		}
		checks.push({ name: "cwd", status: "ok", detail: firstLine(cwd.stdout) ?? resolved.cwd });
	} else {
		checks.push({
			name: "cwd",
			status: "skip",
			suggestion: "Pass --cwd <remote-workspace> for workspace-backed commands.",
		});
	}

	checks.push(await commandCheck(
		resolved,
		"node",
		"node",
		["--version"],
		options.timeoutMs,
		{
			validateVersion: (version) => /^v24\./.test(version),
			suggestion: "Set CODEX_FLOWS_REMOTE_PATH_PREPEND to a Node 24 bin directory or install Node 24 remotely.",
		},
	));
	checks.push(await commandCheck(
		resolved,
		"codex-flows",
		resolved.agentCommand,
		["--help"],
		options.timeoutMs,
		{
			suggestion:
				"Install @peezy.tech/codex-flows on the SSH target or set CODEX_FLOWS_AGENT_COMMAND to its remote path.",
		},
	));
	checks.push(await commandCheck(
		resolved,
		"codex",
		resolved.remoteCodexCommand,
		["--version"],
		options.timeoutMs,
		{
			suggestion: "Set CODEX_FLOWS_REMOTE_CODEX_COMMAND to the remote Codex binary path or add it through CODEX_FLOWS_REMOTE_PATH_PREPEND.",
		},
	));

	if (checks.some((check) => check.status === "fail")) {
		return result;
	}

	const agent = await probeSshAgent(options);
	checks.push(...agent);
	result.ok = checks.every((check) => check.status !== "fail");
	return result;
}

export function formatRemotePreflight(result: RemotePreflightResult): string {
	return result.checks.map((check) => {
		const label = check.name.padEnd(25, " ");
		if (check.status === "ok") {
			return `${label}ok${check.path ? ` ${check.path}` : ""}${
				check.version ? ` ${check.version}` : ""
			}${check.detail ? ` ${check.detail}` : ""}`;
		}
		if (check.status === "skip") {
			return `${label}skip${check.suggestion ? ` ${check.suggestion}` : ""}`;
		}
		return `${label}fail ${[
			check.error,
			check.suggestion,
		].filter(Boolean).join(" ")}`;
	}).join("\n") + "\n";
}

async function probeSshAgent(
	options: SshRemoteProviderOptions,
): Promise<RemotePreflightCheck[]> {
	const transport = createSshAgentTransport(options);
	try {
		transport.start();
		const status = await transport.request("agent.status", {});
		const detail = statusDetail(status);
		await initializeWorkspaceTransport(transport);
		await transport.request(APP_SERVER_CALL_METHOD, {
			method: "thread/list",
			params: { limit: 1, sourceKinds: [] },
		});
		return [
			{ name: "SSH agent", status: "ok", detail },
			{ name: "app-server initialize", status: "ok" },
		];
	} catch (error) {
		const stderr = transport.agentStderr.join("\n").trim();
		return [{
			name: "SSH agent",
			status: "fail",
			error: errorMessage(error),
			suggestion:
				"Inspect remote stderr, ensure codex-flows and codex run from non-interactive SSH, and adjust CODEX_FLOWS_REMOTE_PATH_PREPEND if needed.",
			...(stderr ? { stderr: redact(stderr) } : {}),
		}];
	} finally {
		transport.close();
	}
}

async function initializeWorkspaceTransport(
	transport: CodexWorkspaceBackendTransport,
): Promise<void> {
	await transport.request(WORKSPACE_BACKEND_INITIALIZE_METHOD, {
		clientInfo: {
			name: "codex-flows-remote-preflight",
			title: "Codex Flows Remote Preflight",
			version: "0.1.0",
		},
		capabilities: {
			appServerPassThrough: true,
		},
	});
}

async function commandCheck(
	resolved: ResolvedSshRemoteOptions,
	name: string,
	command: string,
	versionArgs: string[],
	timeoutMs: number,
	options: {
		validateVersion?: (version: string) => boolean;
		suggestion: string;
	},
): Promise<RemotePreflightCheck> {
	const script = [
		`command_path=$(command -v ${shellQuote(command)} 2>/dev/null || true)`,
		`if [ -z "$command_path" ] && [ -x ${shellQuote(command)} ]; then command_path=${shellQuote(command)}; fi`,
		`if [ -z "$command_path" ]; then echo ${shellQuote(`${command} not found`)} >&2; exit 127; fi`,
		`printf '%s\\n' "$command_path"`,
		`"$command_path" ${versionArgs.map(shellQuote).join(" ")} 2>&1 | head -n 1 || true`,
	].join("; ");
	const output = await runRemoteShell(
		resolved,
		withRemotePath(resolved, script),
		timeoutMs,
	);
	if (output.code !== 0) {
		return failCheck(name, output, options.suggestion);
	}
	const [path, version] = output.stdout.trim().split(/\r?\n/);
	if (!path) {
		return {
			name,
			status: "fail",
			error: `${command} did not report a path`,
			suggestion: options.suggestion,
		};
	}
	if (version && options.validateVersion && !options.validateVersion(version)) {
		return {
			name,
			status: "fail",
			path,
			version,
			error: `${command} version ${version} does not satisfy required major 24`,
			suggestion: options.suggestion,
		};
	}
	return {
		name,
		status: "ok",
		path,
		...(version ? { version } : {}),
	};
}

async function runRemoteShell(
	resolved: ResolvedSshRemoteOptions,
	remoteCommand: string,
	timeoutMs: number,
): Promise<ShellResult> {
	const child = spawn(
		resolved.sshCommand,
		["-T", resolved.sshTarget, remoteCommand],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	let timeout = false;
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const timer = setTimeout(() => {
		timeout = true;
		child.kill("SIGTERM");
	}, timeoutMs);
	const exit = new Promise<ShellResult>((resolve) => {
		child.on("error", (error) => {
			stderr += error.message;
			resolve({ code: 1, signal: null, stdout, stderr });
		});
		child.on("exit", (code, signal) => {
			resolve({ code: timeout ? 124 : code, signal, stdout, stderr });
		});
	});
	try {
		return await exit;
	} finally {
		clearTimeout(timer);
	}
}

function withRemotePath(
	options: Pick<ResolvedSshRemoteOptions, "remotePathPrepend">,
	command: string,
): string {
	if (!options.remotePathPrepend) {
		return command;
	}
	return `export PATH=${shellQuote(options.remotePathPrepend)}\${PATH:+":$PATH"} && ${command}`;
}

function failCheck(
	name: string,
	result: ShellResult,
	suggestion: string,
): RemotePreflightCheck {
	const stderr = redact(result.stderr.trim());
	const error = result.code === 124
		? "timed out"
		: stderr || `remote command exited with code ${result.code ?? "unknown"}`;
	return {
		name,
		status: "fail",
		error,
		suggestion,
		...(stderr ? { stderr } : {}),
	};
}

function statusDetail(value: unknown): string | undefined {
	const record = typeof value === "object" && value !== null
		? value as Record<string, unknown>
		: {};
	const cwd = typeof record.cwd === "string" ? record.cwd : undefined;
	const node = typeof record.node === "string" ? record.node : undefined;
	return [cwd, node].filter(Boolean).join(" ") || undefined;
}

function firstLine(text: string): string | undefined {
	return text.trim().split(/\r?\n/).find(Boolean);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function redact(value: string): string {
	return value
		.replace(/(token|password|secret|key)=\S+/gi, "$1=<redacted>")
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, "$1<redacted>");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
