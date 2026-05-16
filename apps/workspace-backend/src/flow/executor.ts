import { createHash } from "node:crypto";
import type { FlowBackendConfig } from "./config.ts";

const flowRuntimeEnvNames = [
	"CODEX_FLOW_EVENT_ID",
	"CODEX_FLOW_RUN_ID",
	"CODEX_FLOW_ATTEMPT_ID",
	"CODEX_FLOW_REPLAY",
	"CODEX_WORKSPACE_BACKEND_WS_URL",
	"CODEX_FLOW_LAUNCHED_BY",
];

export type FlowCommandSpec = {
	command: string;
	args: string[];
	unit?: string;
};

export type ExecuteFlowRunOptions = {
	config: FlowBackendConfig;
	runId: string;
	eventId: string;
	eventPath: string;
	flowName: string;
	stepName: string;
	attemptId?: string;
	replay?: boolean;
	workspaceBackendUrl?: string;
	env?: Record<string, string | undefined>;
};

export type ExecuteFlowRunResult = {
	command: FlowCommandSpec;
	exitCode: number | null;
	stdout: string;
	stderr: string;
};

export async function executeFlowRun(options: ExecuteFlowRunOptions): Promise<ExecuteFlowRunResult> {
	const command = flowCommand(options);
	const result = await executeCommand(command, options.config, flowRunExecutionEnv(options));
	return { command, ...result };
}

export async function executeCommand(
	command: FlowCommandSpec,
	config: FlowBackendConfig,
	env: Record<string, string | undefined> = process.env,
): Promise<Omit<ExecuteFlowRunResult, "command">> {
	const child = Bun.spawn([command.command, ...command.args], {
		cwd: config.cwd,
		env: forwardedEnv(config, env),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

export function flowCommand(options: ExecuteFlowRunOptions): FlowCommandSpec {
	const runnerArgs = [
		options.config.flowRunnerPath,
		"--cwd",
		options.config.cwd,
		"run",
		options.flowName,
		options.stepName,
		"--event",
		options.eventPath,
		"--run-id",
		options.runId,
		"--attempt-id",
		options.attemptId ?? options.runId,
	];
	const workspaceBackendUrl = options.workspaceBackendUrl ?? options.config.workspaceBackendUrl;
	if (workspaceBackendUrl) {
		runnerArgs.push("--workspace-backend-url", workspaceBackendUrl);
	}
	if (options.replay) {
		runnerArgs.push("--replay");
	}
	if (options.config.executor === "direct") {
		return { command: options.config.bunCommand, args: runnerArgs };
	}
	const unit = `codex-flow-${safeUnit(options.runId)}`;
	return {
		command: "systemd-run",
		unit,
		args: [
			"--user",
			"--collect",
			"--wait",
			`--unit=${unit}`,
			`--working-directory=${options.config.cwd}`,
			...systemdSetEnvArgs(options.config, flowRunExecutionEnv(options)),
			options.config.bunCommand,
			...runnerArgs,
		],
	};
}

export function parseRunnerResult(stdout: string): string | undefined {
	const trimmed = stdout.trim();
	if (!trimmed.startsWith("{")) {
		return undefined;
	}
	try {
		return JSON.stringify(JSON.parse(trimmed));
	} catch {
		return undefined;
	}
}

function forwardedEnv(config: FlowBackendConfig, env: Record<string, string | undefined>): Record<string, string> {
	const next: Record<string, string> = {};
	const source: Record<string, string | undefined> = { ...process.env, ...env };
	for (const name of config.forwardEnv) {
		const value = source[name];
		if (value !== undefined) {
			next[name] = value;
		}
	}
	for (const name of flowRuntimeEnvNames) {
		const value = source[name];
		if (value !== undefined) {
			next[name] = value;
		}
	}
	return next;
}

export function flowRunExecutionEnv(options: ExecuteFlowRunOptions): Record<string, string | undefined> {
	return {
		...(options.env ?? process.env),
		CODEX_FLOW_EVENT_ID: options.eventId,
		CODEX_FLOW_RUN_ID: options.runId,
		CODEX_FLOW_ATTEMPT_ID: options.attemptId ?? options.runId,
		CODEX_FLOW_REPLAY: options.replay ? "1" : "0",
		CODEX_WORKSPACE_BACKEND_WS_URL: options.workspaceBackendUrl ?? options.config.workspaceBackendUrl,
		CODEX_FLOW_LAUNCHED_BY: "codex-workspace-backend-local",
	};
}

function systemdSetEnvArgs(config: FlowBackendConfig, env: Record<string, string | undefined>): string[] {
	return Object.entries(forwardedEnv(config, env)).map(([key, value]) => `--setenv=${key}=${value}`);
}

function safeUnit(value: string): string {
	const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
	return `${value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)}-${hash}`;
}
