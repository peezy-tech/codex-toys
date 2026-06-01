import {
	APP_CALL_METHOD,
	type ToyboxMethodMetadata,
	type ToyboxMethodHandler,
} from "@codex-toys/toybox";
import {
	cancelDeferredRunIntent,
	collectLocalHandoffRuns,
	collectPromptQueueRuns,
	collectDeferredRuns,
	createDeferredRunIntent,
	createWorkbenchContext,
	drainLocalHandoffQueue,
	enqueueLocalHandoffIntent,
	enqueuePromptQueueIntent,
	listLocalHandoffIntents,
	listPromptQueueIntents,
	listDeferredRunIntents,
	parseMode,
	pruneDeferredRunHistory,
	readDeferredRun,
	retryDeferredRunIntent,
	runDuePromptQueueIntents,
	runDueDeferredRuns,
	type WorkbenchModeInput,
} from "./workbench-runtime.ts";

export const WORKBENCH_DEFERRED_CREATE_METHOD = "deferred.create";
export const WORKBENCH_DEFERRED_LIST_METHOD = "deferred.list";
export const WORKBENCH_DEFERRED_READ_METHOD = "deferred.read";
export const WORKBENCH_DEFERRED_COLLECT_METHOD = "deferred.collect";
export const WORKBENCH_DEFERRED_CANCEL_METHOD = "deferred.cancel";
export const WORKBENCH_DEFERRED_RETRY_METHOD = "deferred.retry";
export const WORKBENCH_DEFERRED_RUN_DUE_METHOD = "deferred.runDue";
export const WORKBENCH_DEFERRED_PRUNE_METHOD = "deferred.prune";
export const WORKBENCH_PROMPT_QUEUE_ENQUEUE_METHOD = "promptQueue.enqueue";
export const WORKBENCH_PROMPT_QUEUE_LIST_METHOD = "promptQueue.list";
export const WORKBENCH_PROMPT_QUEUE_READ_METHOD = "promptQueue.read";
export const WORKBENCH_PROMPT_QUEUE_COLLECT_METHOD = "promptQueue.collect";
export const WORKBENCH_PROMPT_QUEUE_CANCEL_METHOD = "promptQueue.cancel";
export const WORKBENCH_PROMPT_QUEUE_RETRY_METHOD = "promptQueue.retry";
export const WORKBENCH_PROMPT_QUEUE_RUN_DUE_METHOD = "promptQueue.runDue";
export const WORKBENCH_LOCAL_HANDOFF_ENQUEUE_METHOD = "localHandoff.enqueue";
export const WORKBENCH_LOCAL_HANDOFF_LIST_METHOD = "localHandoff.list";
export const WORKBENCH_LOCAL_HANDOFF_READ_METHOD = "localHandoff.read";
export const WORKBENCH_LOCAL_HANDOFF_COLLECT_METHOD = "localHandoff.collect";
export const WORKBENCH_LOCAL_HANDOFF_CANCEL_METHOD = "localHandoff.cancel";
export const WORKBENCH_LOCAL_HANDOFF_RETRY_METHOD = "localHandoff.retry";
export const WORKBENCH_LOCAL_HANDOFF_DRAIN_METHOD = "localHandoff.drain";

export const workbenchDeferredRunMethodMetadata: ToyboxMethodMetadata[] = [
	{
		name: WORKBENCH_DEFERRED_CREATE_METHOD,
		description: "Create a durable deferred workbench run intent.",
		sideEffects: "writes-local",
		category: "deferred",
	},
	{
		name: WORKBENCH_DEFERRED_LIST_METHOD,
		description: "List deferred workbench run intents.",
		sideEffects: "read-only",
		category: "deferred",
	},
	{
		name: WORKBENCH_DEFERRED_READ_METHOD,
		description: "Read one deferred run intent and its attempts.",
		sideEffects: "read-only",
		category: "deferred",
	},
	{
		name: WORKBENCH_DEFERRED_COLLECT_METHOD,
		description: "Collect terminal deferred run results after a named cursor.",
		sideEffects: "writes-local",
		category: "deferred",
	},
	{
		name: WORKBENCH_DEFERRED_CANCEL_METHOD,
		description: "Cancel a pending deferred run intent.",
		sideEffects: "writes-local",
		category: "deferred",
	},
	{
		name: WORKBENCH_DEFERRED_RETRY_METHOD,
		description: "Create a new pending deferred run from a terminal intent.",
		sideEffects: "writes-local",
		category: "deferred",
	},
	{
		name: WORKBENCH_DEFERRED_RUN_DUE_METHOD,
		description: "Claim and run due deferred workbench run intents.",
		sideEffects: "external-write",
		category: "deferred",
	},
	{
		name: WORKBENCH_DEFERRED_PRUNE_METHOD,
		description: "Prune terminal deferred run history older than a retention window.",
		sideEffects: "writes-local",
		category: "deferred",
	},
	{
		name: WORKBENCH_PROMPT_QUEUE_ENQUEUE_METHOD,
		description: "Enqueue a one-off prompt as a durable workbench deferred turn.",
		sideEffects: "writes-local",
		category: "prompt-queue",
	},
	{
		name: WORKBENCH_PROMPT_QUEUE_LIST_METHOD,
		description: "List durable prompt queue intents.",
		sideEffects: "read-only",
		category: "prompt-queue",
	},
	{
		name: WORKBENCH_PROMPT_QUEUE_READ_METHOD,
		description: "Read one prompt queue intent and its attempts.",
		sideEffects: "read-only",
		category: "prompt-queue",
	},
	{
		name: WORKBENCH_PROMPT_QUEUE_COLLECT_METHOD,
		description: "Collect terminal prompt queue results after a named cursor.",
		sideEffects: "writes-local",
		category: "prompt-queue",
	},
	{
		name: WORKBENCH_PROMPT_QUEUE_CANCEL_METHOD,
		description: "Cancel a pending prompt queue intent.",
		sideEffects: "writes-local",
		category: "prompt-queue",
	},
	{
		name: WORKBENCH_PROMPT_QUEUE_RETRY_METHOD,
		description: "Create a new pending prompt queue intent from terminal history.",
		sideEffects: "writes-local",
		category: "prompt-queue",
	},
	{
		name: WORKBENCH_PROMPT_QUEUE_RUN_DUE_METHOD,
		description: "Claim and run due prompt queue intents.",
		sideEffects: "external-write",
		category: "prompt-queue",
	},
	{
		name: WORKBENCH_LOCAL_HANDOFF_ENQUEUE_METHOD,
		description: "Enqueue a durable task that requires a local controller or host capability.",
		sideEffects: "writes-local",
		category: "local-handoff",
	},
	{
		name: WORKBENCH_LOCAL_HANDOFF_LIST_METHOD,
		description: "List durable local handoff intents.",
		sideEffects: "read-only",
		category: "local-handoff",
	},
	{
		name: WORKBENCH_LOCAL_HANDOFF_READ_METHOD,
		description: "Read one local handoff intent and its attempts.",
		sideEffects: "read-only",
		category: "local-handoff",
	},
	{
		name: WORKBENCH_LOCAL_HANDOFF_COLLECT_METHOD,
		description: "Collect terminal local handoff results after a named cursor.",
		sideEffects: "writes-local",
		category: "local-handoff",
	},
	{
		name: WORKBENCH_LOCAL_HANDOFF_CANCEL_METHOD,
		description: "Cancel a pending local handoff intent.",
		sideEffects: "writes-local",
		category: "local-handoff",
	},
	{
		name: WORKBENCH_LOCAL_HANDOFF_RETRY_METHOD,
		description: "Create a new pending local handoff intent from terminal history.",
		sideEffects: "writes-local",
		category: "local-handoff",
	},
	{
		name: WORKBENCH_LOCAL_HANDOFF_DRAIN_METHOD,
		description: "Claim due local handoffs and run or materialize them.",
		sideEffects: "external-write",
		category: "local-handoff",
	},
];

export type WorkbenchDeferredRunRuntimeOptions = {
	appRequest(method: string, params: unknown): Promise<unknown>;
	workbenchRequest(method: string, params: unknown): Promise<unknown>;
	workbenchRoot?: string;
	env?: Record<string, string | undefined>;
};

export function createWorkbenchDeferredRunMethods(
	options: WorkbenchDeferredRunRuntimeOptions,
): Record<string, ToyboxMethodHandler> {
	return {
		[WORKBENCH_DEFERRED_CREATE_METHOD]: async (params) => {
			const context = await contextFromParams(params, options);
			return { intent: await createDeferredRunIntent(context, params) };
		},
		[WORKBENCH_DEFERRED_LIST_METHOD]: async (params) => {
			const context = await contextFromParams(params, options);
			const input = record(params);
			return {
				intents: await listDeferredRunIntents(context, {
					status: statusValue(input.status),
					limit: numberValue(input.limit),
				}),
			};
		},
		[WORKBENCH_DEFERRED_READ_METHOD]: async (params) => {
			const context = await contextFromParams(params, options);
			const input = record(params);
			return await readDeferredRun(context, requiredString(input.id, "deferred.read id"), {
				includeOutput: input.includeOutput === true,
			});
		},
		[WORKBENCH_DEFERRED_COLLECT_METHOD]: async (params) => {
			const context = await contextFromParams(params, options);
			const input = record(params);
			return await collectDeferredRuns(context, {
				cursor: stringValue(input.cursor),
			});
		},
		[WORKBENCH_DEFERRED_CANCEL_METHOD]: async (params) => {
			const context = await contextFromParams(params, options);
			return {
				intent: await cancelDeferredRunIntent(
					context,
					requiredString(record(params).id, "deferred.cancel id"),
				),
			};
		},
		[WORKBENCH_DEFERRED_RETRY_METHOD]: async (params) => {
			const context = await contextFromParams(params, options);
			const input = record(params);
			return await retryDeferredRunIntent(
				context,
				requiredString(input.id, "deferred.retry id"),
				{
					id: stringValue(input.newId),
					runAt: stringValue(input.runAt),
					createdBy: stringValue(input.createdBy),
					reason: stringValue(input.reason),
					source: recordOrUndefined(input.source),
				},
			);
		},
		[WORKBENCH_DEFERRED_RUN_DUE_METHOD]: async (params) => {
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
					return await options.workbenchRequest(method, value);
				},
			});
		},
			[WORKBENCH_DEFERRED_PRUNE_METHOD]: async (params) => {
				const context = await contextFromParams(params, options);
				const input = record(params);
				return await pruneDeferredRunHistory(context, {
					olderThanDays: requiredPositiveNumber(input.olderThanDays, "deferred.prune olderThanDays"),
					dryRun: input.dryRun === true,
				});
			},
			[WORKBENCH_PROMPT_QUEUE_ENQUEUE_METHOD]: async (params) => {
				const context = await contextFromParams(params, options);
				return { intent: await enqueuePromptQueueIntent(context, params) };
			},
			[WORKBENCH_PROMPT_QUEUE_LIST_METHOD]: async (params) => {
				const context = await contextFromParams(params, options);
				const input = record(params);
				return {
					intents: await listPromptQueueIntents(context, {
						status: statusValue(input.status),
						queue: stringValue(input.queue),
						limit: numberValue(input.limit),
					}),
				};
			},
			[WORKBENCH_PROMPT_QUEUE_READ_METHOD]: async (params) => {
				const context = await contextFromParams(params, options);
				const input = record(params);
				return await readDeferredRun(context, requiredString(input.id, "promptQueue.read id"), {
					includeOutput: input.includeOutput === true,
				});
			},
			[WORKBENCH_PROMPT_QUEUE_COLLECT_METHOD]: async (params) => {
				const context = await contextFromParams(params, options);
				const input = record(params);
				return await collectPromptQueueRuns(context, {
					cursor: stringValue(input.cursor),
					queue: stringValue(input.queue),
				});
			},
			[WORKBENCH_PROMPT_QUEUE_CANCEL_METHOD]: async (params) => {
				const context = await contextFromParams(params, options);
				return {
					intent: await cancelDeferredRunIntent(
						context,
						requiredString(record(params).id, "promptQueue.cancel id"),
					),
				};
			},
			[WORKBENCH_PROMPT_QUEUE_RETRY_METHOD]: async (params) => {
				const context = await contextFromParams(params, options);
				const input = record(params);
				return await retryDeferredRunIntent(
					context,
					requiredString(input.id, "promptQueue.retry id"),
					{
						id: stringValue(input.newId),
						runAt: stringValue(input.runAt),
						createdBy: stringValue(input.createdBy),
						reason: stringValue(input.reason),
						source: recordOrUndefined(input.source),
					},
				);
			},
			[WORKBENCH_PROMPT_QUEUE_RUN_DUE_METHOD]: async (params) => {
				const context = await contextFromParams(params, options);
				const input = record(params);
				return await runDuePromptQueueIntents(context, {
					limit: numberValue(input.limit),
					queue: stringValue(input.queue),
					callToybox: async (method, value) => {
						if (method === APP_CALL_METHOD) {
							const appCall = record(value);
							return await options.appRequest(
								requiredString(appCall.method, "app.call method"),
								appCall.params,
							);
						}
						return await options.workbenchRequest(method, value);
					},
				});
			},
			[WORKBENCH_LOCAL_HANDOFF_ENQUEUE_METHOD]: async (params) => {
				const context = await contextFromParams(params, options);
				return { intent: await enqueueLocalHandoffIntent(context, params) };
			},
			[WORKBENCH_LOCAL_HANDOFF_LIST_METHOD]: async (params) => {
				const context = await contextFromParams(params, options);
				const input = record(params);
				return {
					intents: await listLocalHandoffIntents(context, {
						status: statusValue(input.status),
						queue: stringValue(input.queue),
						targetHost: stringValue(input.targetHost),
						capabilities: stringArrayValue(input.capabilities),
						limit: numberValue(input.limit),
					}),
				};
			},
			[WORKBENCH_LOCAL_HANDOFF_READ_METHOD]: async (params) => {
				const context = await contextFromParams(params, options);
				const input = record(params);
				return await readDeferredRun(context, requiredString(input.id, "localHandoff.read id"), {
					includeOutput: input.includeOutput === true,
				});
			},
			[WORKBENCH_LOCAL_HANDOFF_COLLECT_METHOD]: async (params) => {
				const context = await contextFromParams(params, options);
				const input = record(params);
				return await collectLocalHandoffRuns(context, {
					cursor: stringValue(input.cursor),
					queue: stringValue(input.queue),
					targetHost: stringValue(input.targetHost),
					capabilities: stringArrayValue(input.capabilities),
				});
			},
			[WORKBENCH_LOCAL_HANDOFF_CANCEL_METHOD]: async (params) => {
				const context = await contextFromParams(params, options);
				return {
					intent: await cancelDeferredRunIntent(
						context,
						requiredString(record(params).id, "localHandoff.cancel id"),
					),
				};
			},
			[WORKBENCH_LOCAL_HANDOFF_RETRY_METHOD]: async (params) => {
				const context = await contextFromParams(params, options);
				const input = record(params);
				return await retryDeferredRunIntent(
					context,
					requiredString(input.id, "localHandoff.retry id"),
					{
						id: stringValue(input.newId),
						runAt: stringValue(input.runAt),
						createdBy: stringValue(input.createdBy),
						reason: stringValue(input.reason),
						source: recordOrUndefined(input.source),
					},
				);
			},
			[WORKBENCH_LOCAL_HANDOFF_DRAIN_METHOD]: async (params) => {
				const context = await contextFromParams(params, options);
				const input = record(params);
				return await drainLocalHandoffQueue(context, {
					queue: stringValue(input.queue),
					hostId: stringValue(input.hostId),
					capabilities: stringArrayValue(input.capabilities),
					limit: numberValue(input.limit),
					action: input.action === "materialize" ? "materialize" : "run",
					promptQueue: stringValue(input.promptQueue),
					callToybox: async (method, value) => {
						if (method === APP_CALL_METHOD) {
							const appCall = record(value);
							return await options.appRequest(
								requiredString(appCall.method, "app.call method"),
								appCall.params,
							);
						}
						return await options.workbenchRequest(method, value);
					},
				});
			},
		};
	}

async function contextFromParams(
	params: unknown,
	options: WorkbenchDeferredRunRuntimeOptions,
) {
	const input = record(params);
	return await createWorkbenchContext({
		workbenchRoot: stringValue(input.workbenchRoot) ?? options.workbenchRoot,
		mode: modeValue(input.mode),
		env: options.env,
	});
}

function modeValue(value: unknown): WorkbenchModeInput | undefined {
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

function stringArrayValue(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return strings.length > 0 ? strings : undefined;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}
