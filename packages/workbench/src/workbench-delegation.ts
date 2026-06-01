import { setTimeout as delay } from "node:timers/promises";
import type {
	WorkbenchDelegation,
	WorkbenchDelegationReturnMode,
	WorkbenchDelegationStatus,
} from "./delegation.ts";
import type { WorkbenchDelegationTarget } from "./delegation-methods.ts";

export type WorkbenchDelegationRequest = <T = unknown>(
	method: string,
	params?: unknown,
) => Promise<T>;

export type WorkbenchDelegationStartResult = {
	delegation: WorkbenchDelegation;
	turnId?: string;
	wait?: WorkbenchDelegationWaitResult;
};

export type WorkbenchDelegationWaitResult = {
	status: WorkbenchDelegationStatus;
	latestStatus?: string;
	latestTurnId?: string;
	lastFinal?: {
		turnId: string;
		text: string;
	};
};

export type WorkbenchDelegationListResult = {
	delegations: WorkbenchDelegation[];
	targets?: WorkbenchDelegationTarget[];
};

export type WorkbenchDelegationStartCliOptions = {
	cwd: string;
	prompt?: string;
	title?: string;
	groupId?: string;
	returnMode?: WorkbenchDelegationReturnMode;
	wait?: boolean;
	timeoutMs: number;
	allowAbsoluteCwd?: boolean;
	model?: string;
	sandbox?: string;
	approvalPolicy?: string;
	permissions?: string;
};

export async function startWorkbenchDelegationWithRequest(
	request: WorkbenchDelegationRequest,
	options: WorkbenchDelegationStartCliOptions,
): Promise<WorkbenchDelegationStartResult> {
	const response = await request<WorkbenchDelegationStartResult>(
		"delegation.start",
		compactUndefined({
			cwd: options.cwd,
			prompt: options.prompt,
			title: options.title,
			groupId: options.groupId,
			returnMode: options.returnMode,
			allowAbsoluteCwd: options.allowAbsoluteCwd,
			model: options.model,
			sandbox: options.sandbox,
			approvalPolicy: options.approvalPolicy,
			permissions: options.permissions,
		}),
	);
	if (!options.wait || !response.turnId) {
		return response;
	}
	return {
		...response,
		wait: await waitForWorkbenchDelegationWithRequest(request, {
			delegationId: response.delegation.id,
			timeoutMs: options.timeoutMs,
		}),
	};
}

export async function waitForWorkbenchDelegationWithRequest(
	request: WorkbenchDelegationRequest,
	options: {
		delegationId?: string;
		threadId?: string;
		timeoutMs: number;
		pollIntervalMs?: number;
	},
): Promise<WorkbenchDelegationWaitResult> {
	const startedAt = Date.now();
	const pollIntervalMs = options.pollIntervalMs ?? 1000;
	let latest: WorkbenchDelegationWaitResult | undefined;
	while (Date.now() - startedAt <= options.timeoutMs) {
		const response = await request<{
			delegation: WorkbenchDelegation;
			latestTurnId?: string;
			latestStatus?: string;
			lastFinal?: WorkbenchDelegationWaitResult["lastFinal"];
		}>("delegation.read", compactUndefined({
			delegationId: options.delegationId,
			threadId: options.threadId,
		}));
		latest = {
			status: response.delegation.status,
			latestStatus: response.latestStatus,
			latestTurnId: response.latestTurnId,
			lastFinal: response.lastFinal,
		};
		if (isTerminalDelegationStatus(response.delegation.status)) {
			return latest;
		}
		await delay(Math.min(pollIntervalMs, Math.max(1, options.timeoutMs - (Date.now() - startedAt))));
	}
	throw new Error(`Timed out waiting for delegation ${options.delegationId ?? options.threadId ?? "unknown"}`);
}

export function formatWorkbenchDelegationStartResult(
	result: WorkbenchDelegationStartResult,
): string {
	const lines = [
		"delegation          started",
		`delegation id       ${result.delegation.id}`,
		`thread id           ${result.delegation.codexThreadId}`,
		result.turnId ? `turn id             ${result.turnId}` : undefined,
		`cwd                 ${result.delegation.cwd ?? "unknown"}`,
		`status              ${result.wait?.status ?? result.delegation.status}`,
		result.delegation.returnMode
			? `return mode         ${result.delegation.returnMode}`
			: undefined,
	];
	const finalText = result.wait?.lastFinal?.text?.trim();
	if (finalText) {
		lines.push("", finalText);
	}
	return `${lines.filter(Boolean).join("\n")}\n`;
}

export function formatWorkbenchDelegationListResult(
	result: WorkbenchDelegationListResult,
): string {
	const lines: string[] = [];
	if ((result.targets ?? []).length > 0) {
		lines.push("targets");
		for (const target of result.targets ?? []) {
			lines.push(`  ${target.id.padEnd(28)} ${target.kind} ${target.exists ? target.cwd : `${target.cwd} (missing)`}`);
		}
	}
	if (result.delegations.length > 0) {
		if (lines.length > 0) {
			lines.push("");
		}
		lines.push("delegations");
		for (const delegation of result.delegations) {
			lines.push(`  ${delegation.id.padEnd(20)} ${delegation.status.padEnd(8)} ${delegation.cwd ?? "unknown"} ${delegation.title}`);
		}
	}
	if (lines.length === 0) {
		return "No workbench delegations found.\n";
	}
	return `${lines.join("\n")}\n`;
}

function isTerminalDelegationStatus(status: WorkbenchDelegationStatus): boolean {
	return status === "complete" || status === "failed" || status === "reported";
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
