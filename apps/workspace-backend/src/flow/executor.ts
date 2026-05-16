import { createHash } from "node:crypto";
import type { FlowBackendConfig } from "./config.ts";

export type FlowCommandSpec = {
	command: string;
	args: string[];
	unit?: string;
};

export type ExecuteFlowRunOptions = {
	config: FlowBackendConfig;
	runId: string;
	eventPath: string;
	flowName: string;
	stepName: string;
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
	const result = await executeCommand(command, options.config, options.env);
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
	];
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
			...systemdSetEnvArgs(options.config, options.env ?? process.env),
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
	return next;
}

function systemdSetEnvArgs(config: FlowBackendConfig, env: Record<string, string | undefined>): string[] {
	return Object.entries(forwardedEnv(config, env)).map(([key, value]) => `--setenv=${key}=${value}`);
}

function safeUnit(value: string): string {
	const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
	return `${value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)}-${hash}`;
}
