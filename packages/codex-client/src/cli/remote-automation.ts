import path from "node:path";
import type { v2 } from "../app-server/generated/index.ts";
import type { ToyboxMethodMetadata } from "../toybox/protocol.ts";
import type { ToyboxMethodHandler } from "../toybox/server.ts";
import { readJsonFile } from "./json.ts";
import {
	createTurnAutomationHost,
	listTurnAutomations,
	resolveTurnAutomationTarget,
	runTurnAutomationScript,
	type LoadedTurnAutomation,
	type TurnAutomationBackendRequest,
	type TurnAutomationRun,
	type TurnAutomationStartedTurn,
} from "./turn-automation.ts";

export const REMOTE_AUTOMATION_LIST_METHOD = "automation.list";
export const REMOTE_AUTOMATION_RUN_METHOD = "automation.run";

export const remoteAutomationMethodMetadata: ToyboxMethodMetadata[] = [
	{
		name: REMOTE_AUTOMATION_LIST_METHOD,
		description: "List turn automations available in the selected workspace root.",
		sideEffects: "read-only",
		category: "automation",
	},
	{
		name: REMOTE_AUTOMATION_RUN_METHOD,
		description: "Run a turn automation through the current toybox.",
		sideEffects: "external-write",
		category: "automation",
	},
];

export type RemoteAutomationListParams = {
	workspaceRoot?: string;
	cwd?: string;
};

export type RemoteAutomationListResponse = {
	automations: LoadedTurnAutomation[];
};

export type RemoteAutomationRunParams = {
	target: string;
	event?: unknown;
	eventPath?: string;
	prompt?: string;
	workspaceRoot?: string;
	cwd?: string;
	via?: "workspace" | "app";
	timeoutMs?: number;
	sandbox?: v2.SandboxMode;
	approvalPolicy?: v2.AskForApproval;
	permissions?: string;
	model?: string;
};

export type CreateRemoteAutomationMethodsOptions = {
	cwd?: string;
	timeoutMs: number;
	appRequest: TurnAutomationBackendRequest;
	workspaceRequest?: TurnAutomationBackendRequest;
};

export function createRemoteAutomationMethods(
	options: CreateRemoteAutomationMethodsOptions,
): Record<string, ToyboxMethodHandler> {
	return {
		[REMOTE_AUTOMATION_LIST_METHOD]: async (params) => ({
			automations: await listTurnAutomations({
				cwd: automationWorkspaceRoot(params, options.cwd),
			}),
		} satisfies RemoteAutomationListResponse),
		[REMOTE_AUTOMATION_RUN_METHOD]: async (params) =>
			await runRemoteAutomation(params, options),
	};
}

async function runRemoteAutomation(
	params: unknown,
	options: CreateRemoteAutomationMethodsOptions,
): Promise<TurnAutomationRun> {
	const input = record(params);
	const workspaceRoot = automationWorkspaceRoot(input, options.cwd);
	const target = await resolveTurnAutomationTarget(
		requiredString(input.target, "automation.run target"),
		{ cwd: workspaceRoot },
	);
	const prompt = optionalString(input.prompt) ?? target.prompt;
	const cwd = optionalString(input.cwd) ?? target.cwd ?? options.cwd;
	const via = remoteAutomationVia(input.via);
	const host = createTurnAutomationHost({
		via,
		appRequest: options.appRequest,
		workspaceRequest: via === "workspace" ? options.workspaceRequest : undefined,
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
	return await runTurnAutomationScript({
		scriptPath: target.scriptPath,
		automation: target.automation,
		event: await remoteAutomationEvent(input, workspaceRoot),
		prompt,
		cwd,
		timeoutMs: optionalPositiveNumber(input.timeoutMs) ?? options.timeoutMs,
		host,
	});
}

async function remoteAutomationEvent(
	input: Record<string, unknown>,
	workspaceRoot: string,
): Promise<unknown> {
	if (Object.prototype.hasOwnProperty.call(input, "event")) {
		return input.event;
	}
	const eventPath = optionalString(input.eventPath);
	if (!eventPath) {
		return undefined;
	}
	return await readJsonFile(resolveRemotePath(workspaceRoot, eventPath), eventPath);
}

function automationWorkspaceRoot(params: unknown, fallback: string | undefined): string {
	const input = record(params);
	return path.resolve(
		optionalString(input.workspaceRoot) ??
			optionalString(input.cwd) ??
			fallback ??
			process.cwd(),
	);
}

function resolveRemotePath(base: string, value: string): string {
	return path.isAbsolute(value) ? value : path.resolve(base, value);
}

function remoteAutomationVia(value: unknown): TurnAutomationStartedTurn["via"] {
	if (value === undefined || value === "workspace") {
		return "workspace";
	}
	if (value === "app") {
		return "app-server";
	}
	throw new Error("automation.run via must be workspace or app");
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
		throw new Error("automation.run sandbox must be danger-full-access, workspace-write, or read-only");
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
		throw new Error("automation.run approvalPolicy must be never, on-failure, on-request, or untrusted");
	}
	return undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error("automation.run timeoutMs must be a positive number");
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
