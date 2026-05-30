import {
	APP_CALL_METHOD,
	type ToyboxMethodMetadata,
} from "./protocol.ts";
import type { ToyboxMethodHandler } from "./server.ts";
import {
	cancelDeferredRunIntent,
	createDeferredRunIntent,
	createWorkspaceContext,
	listDeferredRunIntents,
	parseMode,
	pruneDeferredRunHistory,
	readDeferredRun,
	runDueDeferredRuns,
	type WorkspaceModeInput,
} from "../cli/workspace-autonomy.ts";

export const WORKSPACE_DEFERRED_CREATE_METHOD = "deferred.create";
export const WORKSPACE_DEFERRED_LIST_METHOD = "deferred.list";
export const WORKSPACE_DEFERRED_READ_METHOD = "deferred.read";
export const WORKSPACE_DEFERRED_CANCEL_METHOD = "deferred.cancel";
export const WORKSPACE_DEFERRED_RUN_DUE_METHOD = "deferred.runDue";
export const WORKSPACE_DEFERRED_PRUNE_METHOD = "deferred.prune";

export const workspaceDeferredRunMethodMetadata: ToyboxMethodMetadata[] = [
	{
		name: WORKSPACE_DEFERRED_CREATE_METHOD,
		description: "Create a durable deferred workspace run intent.",
		sideEffects: "writes-local",
		category: "deferred",
	},
	{
		name: WORKSPACE_DEFERRED_LIST_METHOD,
		description: "List deferred workspace run intents.",
		sideEffects: "read-only",
		category: "deferred",
	},
	{
		name: WORKSPACE_DEFERRED_READ_METHOD,
		description: "Read one deferred run intent and its attempts.",
		sideEffects: "read-only",
		category: "deferred",
	},
	{
		name: WORKSPACE_DEFERRED_CANCEL_METHOD,
		description: "Cancel a pending deferred run intent.",
		sideEffects: "writes-local",
		category: "deferred",
	},
	{
		name: WORKSPACE_DEFERRED_RUN_DUE_METHOD,
		description: "Claim and run due deferred workspace run intents.",
		sideEffects: "external-write",
		category: "deferred",
	},
	{
		name: WORKSPACE_DEFERRED_PRUNE_METHOD,
		description: "Prune terminal deferred run history older than a retention window.",
		sideEffects: "writes-local",
		category: "deferred",
	},
];

export type WorkspaceDeferredRunRuntimeOptions = {
	appRequest(method: string, params: unknown): Promise<unknown>;
	workspaceRequest(method: string, params: unknown): Promise<unknown>;
	workspaceRoot?: string;
	env?: Record<string, string | undefined>;
};

export function createWorkspaceDeferredRunMethods(
	options: WorkspaceDeferredRunRuntimeOptions,
): Record<string, ToyboxMethodHandler> {
	return {
		[WORKSPACE_DEFERRED_CREATE_METHOD]: async (params) => {
			const context = await contextFromParams(params, options);
			return { intent: await createDeferredRunIntent(context, params) };
		},
		[WORKSPACE_DEFERRED_LIST_METHOD]: async (params) => {
			const context = await contextFromParams(params, options);
			const input = record(params);
			return {
				intents: await listDeferredRunIntents(context, {
					status: statusValue(input.status),
					limit: numberValue(input.limit),
				}),
			};
		},
		[WORKSPACE_DEFERRED_READ_METHOD]: async (params) => {
			const context = await contextFromParams(params, options);
			return await readDeferredRun(context, requiredString(record(params).id, "deferred.read id"));
		},
		[WORKSPACE_DEFERRED_CANCEL_METHOD]: async (params) => {
			const context = await contextFromParams(params, options);
			return {
				intent: await cancelDeferredRunIntent(
					context,
					requiredString(record(params).id, "deferred.cancel id"),
				),
			};
		},
		[WORKSPACE_DEFERRED_RUN_DUE_METHOD]: async (params) => {
			const context = await contextFromParams(params, options);
			const input = record(params);
			return await runDueDeferredRuns(context, {
				limit: numberValue(input.limit),
				callToybox: async (method, value) => {
					if (method === APP_CALL_METHOD) {
						const appCall = record(value);
						return await options.appRequest(
							requiredString(appCall.method, "app.call method"),
							appCall.params,
						);
					}
					return await options.workspaceRequest(method, value);
				},
			});
		},
		[WORKSPACE_DEFERRED_PRUNE_METHOD]: async (params) => {
			const context = await contextFromParams(params, options);
			const input = record(params);
			return await pruneDeferredRunHistory(context, {
				olderThanDays: requiredPositiveNumber(input.olderThanDays, "deferred.prune olderThanDays"),
				dryRun: input.dryRun === true,
			});
		},
	};
}

async function contextFromParams(
	params: unknown,
	options: WorkspaceDeferredRunRuntimeOptions,
) {
	const input = record(params);
	return await createWorkspaceContext({
		workspaceRoot: stringValue(input.workspaceRoot) ?? options.workspaceRoot,
		mode: modeValue(input.mode),
		env: options.env,
	});
}

function modeValue(value: unknown): WorkspaceModeInput | undefined {
	return typeof value === "string" && value.length > 0 ? parseMode(value) : undefined;
}

function statusValue(value: unknown) {
	if (
		value === "pending" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "canceled"
	) {
		return value;
	}
	if (value !== undefined) {
		throw new Error(`Invalid deferred run status: ${String(value)}`);
	}
	return undefined;
}

function numberValue(value: unknown): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error("limit must be a positive number");
	}
	return value;
}

function requiredPositiveNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${label} must be a positive number`);
	}
	return value;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value === "string" && value.length > 0) {
		return value;
	}
	throw new Error(`${label} is required`);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}
