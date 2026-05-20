import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FlowProgressSink } from "../client-types.ts";
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

export type RunNodeStepOptions = {
	flow: LoadedFlow;
	step: FlowStep;
	event: FlowEvent;
	env?: Record<string, string | undefined>;
	runtime?: FlowRunRuntimeInput;
	progress?: FlowProgressSink;
};

export async function runNodeStep(options: RunNodeStepOptions): Promise<FlowResult> {
	const scriptPath = stepScriptPath(options.flow, options.step);
	const cwd = options.step.cwd
		? path.resolve(options.flow.root, options.step.cwd)
		: options.flow.root;
	const context = runContext(options);
	const commandPath = await nodeCommandPath(scriptPath);
	const subprocess = spawn(commandPath[0] ?? process.execPath, commandPath.slice(1), {
		cwd,
		env: {
			...process.env,
			...options.env,
			...runtimeEnv(context),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	subprocess.stdin.end(`${JSON.stringify(context, null, 2)}\n`);
	const timer = setTimeout(() => subprocess.kill("SIGTERM"), options.step.timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(subprocess.stdout),
		collectText(subprocess.stderr, (text) => {
			options.progress?.({
				kind: "stderr",
				createdAt: new Date().toISOString(),
				eventId: options.event.id,
				runId: options.runtime?.runId,
				flowName: options.flow.manifest.name,
				stepName: options.step.name,
				runner: options.step.runner,
				text,
				});
		}),
		exitCodeFor(subprocess),
	]).finally(() => clearTimeout(timer));
	if (exitCode !== 0) {
		throw new Error(`Node flow step ${options.flow.manifest.name}/${options.step.name} failed:\n${stderr || stdout}`);
	}
	return parseFlowResult(stdout);
}

async function collectText(
	stream: NodeJS.ReadableStream | null,
	onText?: (text: string) => void,
): Promise<string> {
	let output = "";
	if (!stream) {
		return output;
	}
	for await (const chunk of stream) {
		const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		output += text;
		onText?.(text);
	}
	return output;
}

async function nodeCommandPath(scriptPath: string): Promise<string[]> {
	const tsxLoader = import.meta.resolve("tsx");
	if (await isModuleStyleScript(scriptPath)) {
		return [process.execPath, "--import", tsxLoader, siblingRuntimePath("node-module-runner"), scriptPath];
	}
	return [process.execPath, "--import", tsxLoader, scriptPath];
}

async function isModuleStyleScript(scriptPath: string): Promise<boolean> {
	const source = await readFile(scriptPath, "utf8");
	return /\bexport\s+default\b/.test(source) ||
		/\bas\s+default\b/.test(source) ||
		/\bdefineNodeFlow\s*\(/.test(source);
}

function siblingRuntimePath(basename: string): string {
	const currentPath = fileURLToPath(import.meta.url);
	const extension = path.extname(currentPath) || ".ts";
	return path.join(path.dirname(currentPath), `${basename}${extension}`);
}

function runContext(options: RunNodeStepOptions): FlowRunContext {
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

function exitCodeFor(subprocess: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		subprocess.once("error", reject);
		subprocess.once("exit", (code) => resolve(code));
	});
}
