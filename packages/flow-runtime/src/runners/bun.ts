import path from "node:path";
import { fileURLToPath } from "node:url";
import { stepScriptPath } from "../manifest.ts";
import { parseFlowResult } from "../result.ts";
import type {
	FlowEvent,
	FlowResult,
	FlowRunContext,
	FlowRunRuntimeInput,
	FlowStep,
	LoadedFlow,
} from "../types.ts";

export type RunBunStepOptions = {
	flow: LoadedFlow;
	step: FlowStep;
	event: FlowEvent;
	env?: Record<string, string | undefined>;
	runtime?: FlowRunRuntimeInput;
};

export async function runBunStep(options: RunBunStepOptions): Promise<FlowResult> {
	const scriptPath = stepScriptPath(options.flow, options.step);
	const cwd = options.step.cwd
		? path.resolve(options.flow.root, options.step.cwd)
		: options.flow.root;
	const context = runContext(options);
	const commandPath = await bunCommandPath(scriptPath);
	const subprocess = Bun.spawn({
		cmd: commandPath,
		cwd,
		env: {
			...process.env,
			...options.env,
			...runtimeEnv(context),
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	subprocess.stdin.write(`${JSON.stringify(context, null, 2)}\n`);
	subprocess.stdin.end();
	const timer = setTimeout(() => subprocess.kill("SIGTERM"), options.step.timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
		subprocess.exited,
	]).finally(() => clearTimeout(timer));
	if (exitCode !== 0) {
		throw new Error(`Bun flow step ${options.flow.manifest.name}/${options.step.name} failed:\n${stderr || stdout}`);
	}
	return parseFlowResult(stdout);
}

async function bunCommandPath(scriptPath: string): Promise<string[]> {
	if (await isModuleStyleScript(scriptPath)) {
		return [process.execPath, siblingRuntimePath("bun-module-runner"), scriptPath];
	}
	return [process.execPath, scriptPath];
}

async function isModuleStyleScript(scriptPath: string): Promise<boolean> {
	const source = await Bun.file(scriptPath).text();
	return /\bexport\s+default\b/.test(source) ||
		/\bas\s+default\b/.test(source) ||
		/\bdefineBunFlow\s*\(/.test(source);
}

function siblingRuntimePath(basename: string): string {
	const currentPath = fileURLToPath(import.meta.url);
	const extension = path.extname(currentPath) || ".ts";
	return path.join(path.dirname(currentPath), `${basename}${extension}`);
}

function runContext(options: RunBunStepOptions): FlowRunContext {
	const env = options.env ?? process.env;
	const runtime = {
		eventId: options.runtime?.eventId ?? env.CODEX_FLOW_EVENT_ID ?? options.event.id,
		runId: options.runtime?.runId ?? env.CODEX_FLOW_RUN_ID,
		attemptId: options.runtime?.attemptId ?? env.CODEX_FLOW_ATTEMPT_ID,
		replay: options.runtime?.replay ?? booleanEnv(env.CODEX_FLOW_REPLAY),
		workspaceBackendUrl: options.runtime?.workspaceBackendUrl ?? env.CODEX_WORKSPACE_BACKEND_WS_URL,
		launchedBy: options.runtime?.launchedBy ?? env.CODEX_FLOW_LAUNCHED_BY,
	};
	return {
		flow: {
			name: options.flow.manifest.name,
			version: options.flow.manifest.version,
			root: options.flow.root,
			step: options.step.name,
			...(options.flow.manifest.config ? { config: options.flow.manifest.config } : {}),
			event: options.event,
		},
		runtime: compactUndefined(runtime),
	};
}

function runtimeEnv(context: FlowRunContext): Record<string, string> {
	return compactStringEnv({
		CODEX_FLOW_EVENT_ID: context.runtime.eventId,
		CODEX_FLOW_RUN_ID: context.runtime.runId,
		CODEX_FLOW_ATTEMPT_ID: context.runtime.attemptId,
		CODEX_FLOW_REPLAY: context.runtime.replay ? "1" : "0",
		CODEX_WORKSPACE_BACKEND_WS_URL: context.runtime.workspaceBackendUrl,
		CODEX_FLOW_LAUNCHED_BY: context.runtime.launchedBy,
	});
}

function booleanEnv(value: string | undefined): boolean {
	return value === "1" || value === "true" || value === "yes";
}

function compactUndefined<T extends Record<string, unknown>>(value: T): T {
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			result[key] = entry;
		}
	}
	return result as T;
}

function compactStringEnv(value: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			result[key] = entry;
		}
	}
	return result;
}
