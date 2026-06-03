import path from "node:path";
import type { v2 } from "@codex-toys/bridge/generated";
import type { ToyboxMethodMetadata } from "@codex-toys/toybox";
import type { ToyboxMethodHandler } from "@codex-toys/toybox";
import { readJsonFile } from "@codex-toys/bridge/json";
import {
	createWorkflowHost,
	listWorkflows,
	resolveWorkflowTarget,
	runWorkflowScript,
	type LoadedWorkflow,
	type WorkflowBackendRequest,
	type WorkflowRun,
	type WorkflowStartedTurn,
} from "./workflow.ts";

export const REMOTE_WORKFLOW_LIST_METHOD = "workflow.list";
export const REMOTE_WORKFLOW_RUN_METHOD = "workflow.run";

export const remoteWorkflowMethodMetadata: ToyboxMethodMetadata[] = [
	{
		name: REMOTE_WORKFLOW_LIST_METHOD,
		description: "List workflows available in the selected workbench root.",
		sideEffects: "read-only",
		category: "workflow",
	},
	{
		name: REMOTE_WORKFLOW_RUN_METHOD,
		description: "Run a workflow through the current toybox.",
		sideEffects: "external-write",
		category: "workflow",
	},
];

export type RemoteWorkflowListParams = {
	workbenchRoot?: string;
	cwd?: string;
};

export type RemoteWorkflowListResponse = {
	workflows: LoadedWorkflow[];
};

export type RemoteWorkflowRunParams = {
	target?: string;
	scriptPath?: string;
	script?: string;
	event?: unknown;
	eventPath?: string;
	prompt?: string;
	workbenchRoot?: string;
	cwd?: string;
	via?: "workbench" | "app";
	timeoutMs?: number;
	sandbox?: v2.SandboxMode;
	approvalPolicy?: v2.AskForApproval;
	permissions?: string;
	model?: string;
};

export type CreateRemoteWorkflowMethodsOptions = {
	cwd?: string;
	timeoutMs: number;
	appRequest: WorkflowBackendRequest;
	workbenchRequest?: WorkflowBackendRequest;
};

export function createRemoteWorkflowMethods(
	options: CreateRemoteWorkflowMethodsOptions,
): Record<string, ToyboxMethodHandler> {
	return {
		[REMOTE_WORKFLOW_LIST_METHOD]: async (params) => ({
			workflows: await listWorkflows({
				cwd: workflowWorkbenchRoot(params, options.cwd),
			}),
		} satisfies RemoteWorkflowListResponse),
		[REMOTE_WORKFLOW_RUN_METHOD]: async (params) =>
			await runRemoteWorkflow(params, options),
	};
}

async function runRemoteWorkflow(
	params: unknown,
	options: CreateRemoteWorkflowMethodsOptions,
): Promise<WorkflowRun> {
	const input = record(params);
	const workbenchRoot = workflowWorkbenchRoot(input, options.cwd);
	const target = await remoteWorkflowTarget(input, workbenchRoot);
	const prompt = optionalString(input.prompt) ?? target.prompt;
	const cwd = optionalString(input.cwd) ?? target.cwd ?? options.cwd;
	const via = remoteWorkflowVia(input.via);
	const host = createWorkflowHost({
		via,
		appRequest: options.appRequest,
		workbenchRequest: via === "workbench" ? options.workbenchRequest : undefined,
		defaults: {
			prompt,
			cwd,
			skills: target.skills,
			sandbox: sandboxModeValue(input.sandbox),
			approvalPolicy: approvalPolicyValue(input.approvalPolicy),
			permissions: optionalString(input.permissions),
			model: optionalString(input.model),
		},
	});
	return await runWorkflowScript({
		scriptPath: target.scriptPath,
		script: target.script,
		workflow: target.workflow,
		event: await remoteWorkflowEvent(input, workbenchRoot),
		prompt,
		cwd,
		timeoutMs: optionalPositiveNumber(input.timeoutMs) ?? options.timeoutMs,
		host,
	});
}

async function remoteWorkflowTarget(
	input: Record<string, unknown>,
	workbenchRoot: string,
): Promise<{
	scriptPath?: string;
	script?: string;
	workflow?: Awaited<ReturnType<typeof resolveWorkflowTarget>>["workflow"];
	prompt?: string;
	cwd?: string;
	skills?: string[];
	timeoutMs?: number;
}> {
	const target = optionalString(input.target);
	const scriptPath = optionalString(input.scriptPath);
	const script = optionalString(input.script);
	const sources = [
		target ? "target" : undefined,
		scriptPath ? "scriptPath" : undefined,
		script !== undefined ? "script" : undefined,
	].filter(Boolean);
	if (sources.length !== 1) {
		throw new Error("workflow.run requires exactly one of target, scriptPath, or script");
	}
	if (target) {
		return await resolveWorkflowTarget(target, { cwd: workbenchRoot });
	}
	if (scriptPath) {
		return { scriptPath: resolveRemotePath(workbenchRoot, scriptPath) };
	}
	return { script };
}

async function remoteWorkflowEvent(
	input: Record<string, unknown>,
	workbenchRoot: string,
): Promise<unknown> {
	if (Object.prototype.hasOwnProperty.call(input, "event")) {
		return input.event;
	}
	const eventPath = optionalString(input.eventPath);
	if (!eventPath) {
		return undefined;
	}
	return await readJsonFile(resolveRemotePath(workbenchRoot, eventPath), eventPath);
}

function workflowWorkbenchRoot(params: unknown, fallback: string | undefined): string {
	const input = record(params);
	return path.resolve(
		optionalString(input.workbenchRoot) ??
			optionalString(input.cwd) ??
			fallback ??
			process.cwd(),
	);
}

function resolveRemotePath(base: string, value: string): string {
	return path.isAbsolute(value) ? value : path.resolve(base, value);
}

function remoteWorkflowVia(value: unknown): WorkflowStartedTurn["via"] {
	if (value === undefined || value === "workbench") {
		return "workbench";
	}
	if (value === "app") {
		return "app-server";
	}
	throw new Error("workflow.run via must be workbench or app");
}

function sandboxModeValue(value: unknown): v2.SandboxMode | undefined {
	if (
		value === "danger-full-access" ||
		value === "read-only" ||
		value === "workspace-write"
	) {
		return value;
	}
	if (value !== undefined) {
		throw new Error("workflow.run sandbox must be danger-full-access, workspace-write, or read-only");
	}
	return undefined;
}

function approvalPolicyValue(value: unknown): v2.AskForApproval | undefined {
	if (
		value === "never" ||
		value === "on-failure" ||
		value === "on-request" ||
		value === "untrusted"
	) {
		return value;
	}
	if (value !== undefined) {
		throw new Error("workflow.run approvalPolicy must be never, on-failure, on-request, or untrusted");
	}
	return undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error("workflow.run timeoutMs must be a positive number");
	}
	return value;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value === "string" && value.length > 0) {
		return value;
	}
	throw new Error(`${label} is required`);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}
