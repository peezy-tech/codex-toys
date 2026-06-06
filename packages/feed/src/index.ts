import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ToyboxMethodHandler, ToyboxMethodMetadata } from "@codex-toys/toybox";

export type FeedModeInput = "auto" | "local" | "actions";
export type FeedMode = "local" | "actions";
export type FeedItemStatus = "new";
export type FeedSourceKind = "rss" | "atom";
export type FeedItemSourceKind = FeedSourceKind | "manual";

export type FeedContext = {
	mode: FeedMode;
	requestedMode: FeedModeInput;
	root: string;
	codexHome: string;
	configPath: string;
	stateRoot: string;
	localStateRoot: string;
	actionsStateRoot: string;
};

export type FeedSource = {
	id: string;
	kind: FeedSourceKind;
	url: string;
	enabled: boolean;
	title?: string;
	maxContentBytes: number;
	storeRaw: boolean;
	maxItems?: number;
	latestOnly: boolean;
};

export type FeedConfig = {
	name: string;
	path: string;
	sources: FeedSource[];
};

export type FeedCheckpoint = {
	sourceId: string;
	updatedAt: string;
	lastPolledAt?: string;
	lastStatus?: number;
	etag?: string;
	lastModified?: string;
	lastItemIds?: string[];
	error?: string;
};

export type FeedItem = {
	id: string;
	sourceId: string;
	sourceKind: FeedItemSourceKind;
	status: FeedItemStatus;
	externalId: string;
	title: string;
	url?: string;
	publishedAt?: string;
	updatedAt?: string;
	summary?: string;
	contentText?: string;
	observedAt: string;
	raw?: Record<string, unknown>;
};

export type FeedAppendItemOptions = {
	sourceId: string;
	externalId?: string;
	title?: string;
	url?: string;
	publishedAt?: string;
	updatedAt?: string;
	summary?: string;
	contentText?: string;
	observedAt?: string;
	raw?: Record<string, unknown>;
	payload?: Record<string, unknown>;
	now?: Date;
};

export type FeedAppendItemResult = {
	mode: FeedMode;
	appended: boolean;
	duplicate: boolean;
	appendedAt: string;
	item: FeedItem;
};

export type FeedPollRun = {
	id: string;
	sourceId: string;
	status: "completed" | "failed" | "not-modified" | "skipped";
	startedAt: string;
	finishedAt: string;
	url: string;
	httpStatus?: number;
	parsedItemCount: number;
	newItemCount: number;
	duplicateItemCount: number;
	itemIds: string[];
	checkpoint?: FeedCheckpoint;
	error?: string;
};

export type FeedPollResult = {
	mode: FeedMode;
	startedAt: string;
	finishedAt: string;
	runs: FeedPollRun[];
};

export type FeedCollectCursor = {
	cursor: string;
	updatedAt: string;
	lastObservedAt?: string;
	lastItemId?: string;
};

export type FeedCollectResult = {
	mode: FeedMode;
	cursor: string;
	collectedAt: string;
	advanced: boolean;
	previousCursor?: FeedCollectCursor;
	cursorState?: FeedCollectCursor;
	pendingCursorState?: FeedCollectCursor;
	items: FeedItem[];
};

export type FeedAdvanceCursorOptions = {
	cursor?: string;
	itemId: string;
	now?: Date;
};

export type FeedAdvanceCursorResult = {
	mode: FeedMode;
	cursor: string;
	advancedAt: string;
	previousCursor?: FeedCollectCursor;
	cursorState: FeedCollectCursor;
	item: FeedItem;
};

export type FeedDispatchTargetHandler = (
	target: string,
	event: ReturnType<typeof toFeedEvent>,
	item: FeedItem,
	context: FeedContext,
) => Promise<unknown>;

export type FeedDispatchOptions = {
	sourceId: string;
	cursor?: string;
	limit?: number;
	poll?: boolean;
	target: string;
	runTarget: FeedDispatchTargetHandler;
};

export type FeedDispatchExecution = {
	itemId: string;
	sourceId: string;
	status: "completed" | "failed";
	event: ReturnType<typeof toFeedEvent>;
	result?: unknown;
	cursor?: FeedCollectCursor;
	error?: string;
};

export type FeedDispatchResult = {
	mode: FeedMode;
	sourceId: string;
	cursor: string;
	target: string;
	status: "completed" | "failed";
	poll?: FeedPollResult;
	collect: FeedCollectResult;
	executions: FeedDispatchExecution[];
};

export type FeedDoctorInfo = {
	mode: FeedMode;
	requestedMode: FeedModeInput;
	root: string;
	configPath: string;
	configExists: boolean;
	stateRoot: string;
	localStateRoot: string;
	actionsStateRoot: string;
	sourceCount: number;
	enabledSourceCount: number;
	itemCount: number;
	latestRun?: FeedPollRun;
	errors: string[];
};

export type FeedPruneResult = {
	mode: FeedMode;
	cutoff: string;
	dryRun: boolean;
	inspected: number;
	pruned: number;
	items: Array<{
		id: string;
		sourceId: string;
		observedAt: string;
	}>;
};

export type FeedFetchResponse = {
	ok: boolean;
	status: number;
	headers: {
		get(name: string): string | null;
	};
	text(): Promise<string>;
};

export type FeedFetch = (
	url: string,
	init?: {
		headers?: Record<string, string>;
	},
) => Promise<FeedFetchResponse>;

export type FeedPollOptions = {
	sourceId?: string;
	sourceIds?: string[];
	fetch?: FeedFetch;
	now?: Date;
};

export type FeedListItemOptions = {
	sourceId?: string;
	status?: FeedItemStatus;
	limit?: number;
};

export type FeedCollectOptions = FeedListItemOptions & {
	cursor?: string;
	advance?: boolean;
};

export type FeedPruneOptions = {
	olderThanDays: number;
	dryRun?: boolean;
	now?: Date;
};

export const FEED_DOCTOR_METHOD = "feed.doctor";
export const FEED_SOURCE_LIST_METHOD = "feed.source.list";
export const FEED_POLL_METHOD = "feed.poll";
export const FEED_ITEM_APPEND_METHOD = "feed.item.append";
export const FEED_ITEM_LIST_METHOD = "feed.item.list";
export const FEED_ITEM_READ_METHOD = "feed.item.read";
export const FEED_COLLECT_METHOD = "feed.collect";
export const FEED_CURSOR_ADVANCE_METHOD = "feed.cursor.advance";
export const FEED_DISPATCH_METHOD = "feed.dispatch";
export const FEED_PRUNE_METHOD = "feed.prune";

export const feedMethodMetadata: ToyboxMethodMetadata[] = [
	{
		name: FEED_DOCTOR_METHOD,
		description: "Inspect feed config, state roots, sources, and latest poll state.",
		sideEffects: "read-only",
		category: "feed",
	},
	{
		name: FEED_SOURCE_LIST_METHOD,
		description: "List configured feed sources.",
		sideEffects: "read-only",
		category: "feed",
	},
	{
		name: FEED_POLL_METHOD,
		description: "Poll RSS/Atom feed sources and store newly observed items.",
		sideEffects: "writes-local",
		category: "feed",
	},
	{
		name: FEED_ITEM_APPEND_METHOD,
		description: "Append a local/manual feed item without polling an external source.",
		sideEffects: "writes-local",
		category: "feed",
	},
	{
		name: FEED_ITEM_LIST_METHOD,
		description: "List durable feed items.",
		sideEffects: "read-only",
		category: "feed",
	},
	{
		name: FEED_ITEM_READ_METHOD,
		description: "Read one durable feed item.",
		sideEffects: "read-only",
		category: "feed",
	},
	{
		name: FEED_COLLECT_METHOD,
		description: "Collect feed items after a named cursor.",
		sideEffects: "writes-local",
		category: "feed",
	},
	{
		name: FEED_CURSOR_ADVANCE_METHOD,
		description: "Advance a feed collection cursor to a specific item.",
		sideEffects: "writes-local",
		category: "feed",
	},
	{
		name: FEED_DISPATCH_METHOD,
		description: "Dispatch collected feed items to a target and advance the cursor after successful delivery.",
		sideEffects: "writes-local",
		category: "feed",
	},
	{
		name: FEED_PRUNE_METHOD,
		description: "Prune feed items older than a retention window.",
		sideEffects: "writes-local",
		category: "feed",
	},
];

export type CreateFeedMethodsOptions = {
	root?: string;
	env?: Record<string, string | undefined>;
	fetch?: FeedFetch;
	dispatchTarget?: FeedDispatchTargetHandler;
};

export function createFeedMethods(
	options: CreateFeedMethodsOptions = {},
): Record<string, ToyboxMethodHandler> {
	return {
		[FEED_DOCTOR_METHOD]: async (params) =>
			await collectFeedDoctorInfo(await contextFromParams(params, options)),
		[FEED_SOURCE_LIST_METHOD]: async (params) => ({
			sources: (await loadFeedConfig(await contextFromParams(params, options))).sources,
		}),
		[FEED_POLL_METHOD]: async (params) => {
			const input = record(params);
			return await pollFeedSources(
				await contextFromParams(input, options),
				await loadFeedConfig(await contextFromParams(input, options)),
				{
					sourceId: optionalString(input.sourceId) ?? optionalString(input.source),
					sourceIds: stringArrayValue(input.sourceIds),
					fetch: options.fetch,
				},
			);
		},
		[FEED_ITEM_APPEND_METHOD]: async (params) => {
			const input = record(params);
			return await appendFeedItem(
				await contextFromParams(input, options),
				feedAppendItemOptionsFromParams(input),
			);
		},
		[FEED_ITEM_LIST_METHOD]: async (params) => {
			const input = record(params);
			return {
				items: await listFeedItems(await contextFromParams(input, options), {
						sourceId: optionalString(input.sourceId) ?? optionalString(input.source),
					status: feedItemStatusValue(input.status),
					limit: optionalPositiveInteger(input.limit, "feed.item.list limit"),
				}),
			};
		},
		[FEED_ITEM_READ_METHOD]: async (params) => {
			const input = record(params);
			return {
				item: await readFeedItem(
					await contextFromParams(input, options),
					requiredString(input.id, "feed.item.read id"),
				),
			};
		},
		[FEED_COLLECT_METHOD]: async (params) => {
			const input = record(params);
			return await collectFeedItems(await contextFromParams(input, options), {
				cursor: optionalString(input.cursor),
				sourceId: optionalString(input.sourceId) ?? optionalString(input.source),
				status: feedItemStatusValue(input.status),
				limit: optionalPositiveInteger(input.limit, "feed.collect limit"),
				advance: input.advance === undefined ? undefined : input.advance !== false,
			});
		},
		[FEED_CURSOR_ADVANCE_METHOD]: async (params) => {
			const input = record(params);
			return await advanceFeedCursor(await contextFromParams(input, options), {
				cursor: optionalString(input.cursor),
				itemId: requiredString(input.itemId ?? input.item, "feed.cursor.advance itemId"),
			});
		},
		[FEED_DISPATCH_METHOD]: async (params) => {
			if (!options.dispatchTarget) {
				throw new Error("feed.dispatch requires a dispatch target handler");
			}
			const input = record(params);
			const sourceId = requiredString(input.sourceId ?? input.source, "feed.dispatch sourceId");
			return await dispatchFeedItems(
				await contextFromParams(input, options),
				await loadFeedConfig(await contextFromParams(input, options)),
				{
					sourceId,
					cursor: optionalString(input.cursor),
					limit: optionalPositiveInteger(input.limit, "feed.dispatch limit"),
					poll: input.poll === undefined ? undefined : input.poll !== false,
					target: requiredString(input.target, "feed.dispatch target"),
					runTarget: options.dispatchTarget,
				},
			);
		},
		[FEED_PRUNE_METHOD]: async (params) => {
			const input = record(params);
			return await pruneFeedItems(await contextFromParams(input, options), {
				olderThanDays: requiredPositiveInteger(input.olderThanDays, "feed.prune olderThanDays"),
				dryRun: input.dryRun === true,
			});
		},
	};
}

export async function discoverFeedRoot(start = process.cwd()): Promise<string> {
	let current = path.resolve(start);
	let firstDotCodexRoot: string | undefined;
	while (true) {
		try {
			if ((await stat(path.join(current, ".codex", "feed.toml"))).isFile()) {
				return current;
			}
		} catch {}
		if (!firstDotCodexRoot) {
			try {
				if ((await stat(path.join(current, ".codex"))).isDirectory()) {
					firstDotCodexRoot = current;
				}
			} catch {}
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return firstDotCodexRoot ?? path.resolve(start);
		}
		current = parent;
	}
}

export function resolveFeedMode(
	input: FeedModeInput | undefined,
	env: Record<string, string | undefined> = process.env,
): { requestedMode: FeedModeInput; mode: FeedMode } {
	const requestedMode = input ?? parseFeedMode(env.CODEX_FEED_MODE) ?? "auto";
	if (requestedMode === "actions") {
		return { requestedMode, mode: "actions" };
	}
	if (requestedMode === "local") {
		return { requestedMode, mode: "local" };
	}
	return { requestedMode, mode: env.GITHUB_ACTIONS === "true" ? "actions" : "local" };
}

export function parseFeedMode(value: string | undefined): FeedModeInput | undefined {
	if (value === undefined || value === "") {
		return undefined;
	}
	if (value === "auto" || value === "local" || value === "actions") {
		return value;
	}
	throw new Error(`Invalid feed mode: ${value}`);
}

export async function createFeedContext(options: {
	root?: string;
	mode?: FeedModeInput;
	env?: Record<string, string | undefined>;
} = {}): Promise<FeedContext> {
	const env = options.env ?? process.env;
	const root = path.resolve(options.root ?? await discoverFeedRoot());
	const resolved = resolveFeedMode(options.mode, env);
	const codexHome = path.join(root, ".codex");
	return {
		mode: resolved.mode,
		requestedMode: resolved.requestedMode,
		root,
		codexHome,
		configPath: path.join(codexHome, "feed.toml"),
		stateRoot: path.join(codexHome, "feed", resolved.mode),
		localStateRoot: path.join(codexHome, "feed", "local"),
		actionsStateRoot: path.join(codexHome, "feed", "actions"),
	};
}

export async function loadFeedConfig(context: FeedContext): Promise<FeedConfig> {
	const text = await readFile(context.configPath, "utf8");
	const parsed = parseToml(text) as unknown;
	const input = record(parsed);
	const feed = record(input.feed);
	const sourceInputs = Array.isArray(feed.sources) ? feed.sources : [];
	const sources = sourceInputs.map(parseFeedSource);
	const ids = new Set<string>();
	for (const source of sources) {
		if (ids.has(source.id)) {
			throw new Error(`Duplicate feed source id: ${source.id}`);
		}
		ids.add(source.id);
	}
	return {
		name: optionalString(feed.name) ?? path.basename(context.root),
		path: context.configPath,
		sources,
	};
}

export async function collectFeedDoctorInfo(context: FeedContext): Promise<FeedDoctorInfo> {
	let config: FeedConfig | undefined;
	let configExists = true;
	const errors: string[] = [];
	try {
		config = await loadFeedConfig(context);
	} catch (error) {
		try {
			await stat(context.configPath);
		} catch {
			configExists = false;
		}
		if (configExists) {
			errors.push(errorMessage(error));
		}
	}
	const items = await listFeedItems(context);
	const latestRun = (await readFeedRuns(context))
		.sort((left, right) => right.finishedAt.localeCompare(left.finishedAt))[0];
	return {
		mode: context.mode,
		requestedMode: context.requestedMode,
		root: context.root,
		configPath: context.configPath,
		configExists,
		stateRoot: context.stateRoot,
		localStateRoot: context.localStateRoot,
		actionsStateRoot: context.actionsStateRoot,
		sourceCount: config?.sources.length ?? 0,
		enabledSourceCount: config?.sources.filter((source) => source.enabled).length ?? 0,
		itemCount: items.length,
		latestRun,
		errors,
	};
}

export function formatFeedDoctorInfo(info: FeedDoctorInfo): string {
	const rows: Array<[string, string]> = [
		["mode", info.requestedMode === info.mode ? info.mode : `${info.mode} (${info.requestedMode})`],
		["root", info.root],
		["config", `${info.configPath}${info.configExists ? "" : " (missing)"}`],
		["state root", info.stateRoot],
		["local state", info.localStateRoot],
		["actions state", info.actionsStateRoot],
		["sources", `${info.sourceCount} configured, ${info.enabledSourceCount} enabled`],
		["items", `${info.itemCount}`],
		[
			"latest poll",
			info.latestRun
				? `${info.latestRun.status} ${info.latestRun.sourceId} ${info.latestRun.finishedAt}`
				: "none",
		],
	];
	for (const error of info.errors) {
		rows.push(["error", error]);
	}
	return `${rows.map(([label, value]) => `${label.padEnd(15)} ${value}`).join("\n")}\n`;
}

export async function pollFeedSources(
	context: FeedContext,
	config: FeedConfig,
	options: FeedPollOptions = {},
): Promise<FeedPollResult> {
	await ensureFeedStateDirs(context);
	const startedAt = (options.now ?? new Date()).toISOString();
	const selectedIds = new Set([
		...(options.sourceId ? [options.sourceId] : []),
		...(options.sourceIds ?? []),
	]);
	const sources = config.sources.filter((source) =>
		selectedIds.size > 0 ? selectedIds.has(source.id) : source.enabled
	);
	if (sources.length === 0 && selectedIds.size > 0) {
		throw new Error(`Unknown feed source: ${[...selectedIds].join(", ")}`);
	}
	const runs: FeedPollRun[] = [];
	const now = options.now ?? new Date();
	for (const source of sources) {
		runs.push(await pollFeedSource(context, source, {
			fetch: options.fetch,
			now,
		}));
	}
	return {
		mode: context.mode,
		startedAt,
		finishedAt: new Date().toISOString(),
		runs,
	};
}

export function feedAppendItemOptionsFromParams(params: unknown): FeedAppendItemOptions {
	const input = record(params);
	return compactUndefined({
		sourceId: requiredString(input.sourceId ?? input.source, "feed.item.append sourceId"),
		externalId: optionalString(input.externalId) ?? optionalString(input.external_id),
		title: optionalString(input.title),
		url: optionalString(input.url),
		publishedAt: optionalString(input.publishedAt) ?? optionalString(input.published_at),
		updatedAt: optionalString(input.updatedAt) ?? optionalString(input.updated_at),
		summary: optionalString(input.summary),
		contentText: optionalString(input.contentText) ?? optionalString(input.content_text),
		observedAt: optionalString(input.observedAt) ?? optionalString(input.observed_at),
		raw: feedAppendRawPayload(input),
	});
}

export async function appendFeedItem(
	context: FeedContext,
	options: FeedAppendItemOptions,
): Promise<FeedAppendItemResult> {
	await ensureFeedStateDirs(context);
	validateSlug(options.sourceId, "feed append source id");
	const appendedAt = (options.now ?? new Date()).toISOString();
	const externalId = options.externalId ?? `manual:${randomUUID()}`;
	const observedAt = normalizeOptionalDateString(options.observedAt, "feed append observedAt") ?? appendedAt;
	const item: FeedItem = compactUndefined({
		id: feedItemId(options.sourceId, externalId),
		sourceId: options.sourceId,
		sourceKind: "manual",
		status: "new",
		externalId,
		title: options.title ?? options.summary ?? options.sourceId,
		url: options.url,
		publishedAt: normalizeOptionalDateString(options.publishedAt, "feed append publishedAt"),
		updatedAt: normalizeOptionalDateString(options.updatedAt, "feed append updatedAt"),
		summary: options.summary,
		contentText: options.contentText,
		observedAt,
		raw: options.raw ?? options.payload,
	});
	try {
		await writeNewJsonFile(feedItemPath(context, item.id), item);
		return {
			mode: context.mode,
			appended: true,
			duplicate: false,
			appendedAt,
			item,
		};
	} catch (error) {
		if (!isFileExists(error)) {
			throw error;
		}
		return {
			mode: context.mode,
			appended: false,
			duplicate: true,
			appendedAt,
			item: await readFeedItem(context, item.id),
		};
	}
}

export async function listFeedItems(
	context: FeedContext,
	options: FeedListItemOptions = {},
): Promise<FeedItem[]> {
	const items: FeedItem[] = [];
	try {
		for (const file of await readdir(feedItemDir(context))) {
			if (!file.endsWith(".json")) {
				continue;
			}
			const item = normalizeFeedItem(await readJsonFile(path.join(feedItemDir(context), file)));
			if (options.sourceId && item.sourceId !== options.sourceId) {
				continue;
			}
			if (options.status && item.status !== options.status) {
				continue;
			}
			items.push(item);
		}
	} catch (error) {
		if (!isNotFound(error)) {
			throw error;
		}
	}
	const sorted = items.sort(compareFeedItems);
	return options.limit ? sorted.slice(0, options.limit) : sorted;
}

export async function readFeedItem(context: FeedContext, itemId: string): Promise<FeedItem> {
	try {
		return normalizeFeedItem(await readJsonFile(feedItemPath(context, itemId)));
	} catch (error) {
		if (isNotFound(error)) {
			throw new Error(`Unknown feed item: ${itemId}`);
		}
		throw error;
	}
}

export async function collectFeedItems(
	context: FeedContext,
	options: FeedCollectOptions = {},
): Promise<FeedCollectResult> {
	await ensureFeedStateDirs(context);
	const cursor = feedCursorName(options.cursor);
	const advance = options.advance !== false;
	const previousCursor = await readFeedCollectCursor(context, cursor);
	const candidates = await listFeedItems(context, {
		sourceId: options.sourceId,
		status: options.status,
	});
	const unseen = candidates.filter((item) => isAfterCursor(item, previousCursor));
	const items = options.limit ? unseen.slice(0, options.limit) : unseen;
	const pendingCursorState = feedCursorStateForItems(cursor, items, previousCursor);
	if (advance) {
		await writeJsonFileAtomic(feedCollectCursorPath(context, cursor), pendingCursorState);
	}
	return compactUndefined({
		mode: context.mode,
		cursor,
		collectedAt: pendingCursorState.updatedAt,
		advanced: advance,
		previousCursor,
		cursorState: advance ? pendingCursorState : previousCursor,
		pendingCursorState,
		items,
	});
}

export async function advanceFeedCursor(
	context: FeedContext,
	options: FeedAdvanceCursorOptions,
): Promise<FeedAdvanceCursorResult> {
	await ensureFeedStateDirs(context);
	const cursor = feedCursorName(options.cursor);
	const item = await readFeedItem(context, options.itemId);
	const previousCursor = await readFeedCollectCursor(context, cursor);
	const advancedAt = (options.now ?? new Date()).toISOString();
	const cursorState: FeedCollectCursor = {
		cursor,
		updatedAt: advancedAt,
		lastObservedAt: item.observedAt,
		lastItemId: item.id,
	};
	await writeJsonFileAtomic(feedCollectCursorPath(context, cursor), cursorState);
	return compactUndefined({
		mode: context.mode,
		cursor,
		advancedAt,
		previousCursor,
		cursorState,
		item,
	});
}

export async function dispatchFeedItems(
	context: FeedContext,
	config: FeedConfig,
	options: FeedDispatchOptions,
): Promise<FeedDispatchResult> {
	const sourceId = options.sourceId;
	const cursor = feedCursorName(options.cursor);
	const poll = options.poll === false
		? undefined
		: await pollFeedSources(context, config, { sourceId });
	const collect = await collectFeedItems(context, {
		cursor,
		sourceId,
		limit: options.limit,
		advance: false,
	});
	const executions: FeedDispatchExecution[] = [];
	for (const item of collect.items) {
		const event = toFeedEvent(item);
		try {
			const result = await options.runTarget(options.target, event, item, context);
			const advanced = await advanceFeedCursor(context, {
				cursor,
				itemId: item.id,
			});
			executions.push({
				itemId: item.id,
				sourceId: item.sourceId,
				status: "completed",
				event,
				result,
				cursor: advanced.cursorState,
			});
		} catch (error) {
			executions.push({
				itemId: item.id,
				sourceId: item.sourceId,
				status: "failed",
				event,
				error: errorMessage(error),
			});
			return {
				mode: context.mode,
				sourceId,
				cursor,
				target: options.target,
				status: "failed",
				poll,
				collect,
				executions,
			};
		}
	}
	return {
		mode: context.mode,
		sourceId,
		cursor,
		target: options.target,
		status: "completed",
		poll,
		collect,
		executions,
	};
}

export async function pruneFeedItems(
	context: FeedContext,
	options: FeedPruneOptions,
): Promise<FeedPruneResult> {
	if (!Number.isFinite(options.olderThanDays) || options.olderThanDays <= 0) {
		throw new Error("feed prune olderThanDays must be a positive number");
	}
	const cutoffDate = new Date((options.now ?? new Date()).getTime() - options.olderThanDays * 24 * 60 * 60 * 1000);
	const cutoff = cutoffDate.toISOString();
	const items = await listFeedItems(context);
	const pruned = items.filter((item) => item.observedAt < cutoff);
	if (!options.dryRun) {
		for (const item of pruned) {
			await rm(feedItemPath(context, item.id), { force: true });
		}
	}
	return {
		mode: context.mode,
		cutoff,
		dryRun: options.dryRun === true,
		inspected: items.length,
		pruned: pruned.length,
		items: pruned.map((item) => ({
			id: item.id,
			sourceId: item.sourceId,
			observedAt: item.observedAt,
		})),
	};
}

export function toFeedEvent(item: FeedItem): {
	id: string;
	type: "feed.item";
	source: string;
	occurredAt: string;
	receivedAt: string;
	payload: FeedItem;
} {
	return {
		id: `feed:${item.id}`,
		type: "feed.item",
		source: item.sourceId,
		occurredAt: item.publishedAt ?? item.updatedAt ?? item.observedAt,
		receivedAt: item.observedAt,
		payload: item,
	};
}

async function pollFeedSource(
	context: FeedContext,
	source: FeedSource,
	options: {
		fetch?: FeedFetch;
		now: Date;
	},
): Promise<FeedPollRun> {
	const startedAt = options.now.toISOString();
	const runId = feedRunId(source.id, startedAt);
	if (!source.enabled) {
		const run: FeedPollRun = {
			id: runId,
			sourceId: source.id,
			status: "skipped",
			startedAt,
			finishedAt: new Date().toISOString(),
			url: source.url,
			parsedItemCount: 0,
			newItemCount: 0,
			duplicateItemCount: 0,
			itemIds: [],
		};
		await writeJsonFileAtomic(feedRunPath(context, run.id), run);
		return run;
	}
	const fetchImpl = options.fetch ?? defaultFeedFetch;
	const checkpoint = await readFeedCheckpoint(context, source.id);
	const headers: Record<string, string> = {};
	if (checkpoint?.etag) {
		headers["If-None-Match"] = checkpoint.etag;
	}
	if (checkpoint?.lastModified) {
		headers["If-Modified-Since"] = checkpoint.lastModified;
	}
	try {
		const response = await fetchImpl(source.url, { headers });
		const nextCheckpointBase = checkpointForResponse(source.id, response, startedAt);
		if (response.status === 304) {
			const nextCheckpoint: FeedCheckpoint = compactUndefined({
				...checkpoint,
				...nextCheckpointBase,
				lastItemIds: checkpoint?.lastItemIds,
			});
			await writeJsonFileAtomic(feedCheckpointPath(context, source.id), nextCheckpoint);
			const run: FeedPollRun = {
				id: runId,
				sourceId: source.id,
				status: "not-modified",
				startedAt,
				finishedAt: new Date().toISOString(),
				url: source.url,
				httpStatus: response.status,
				parsedItemCount: 0,
				newItemCount: 0,
				duplicateItemCount: 0,
				itemIds: [],
				checkpoint: nextCheckpoint,
			};
			await writeJsonFileAtomic(feedRunPath(context, run.id), run);
			return run;
		}
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const text = await response.text();
		const parsed = limitFeedItems(parseFeedText(text, source, startedAt), source);
		const itemIds: string[] = [];
		let duplicateItemCount = 0;
		for (const item of parsed) {
			try {
				await writeNewJsonFile(feedItemPath(context, item.id), item);
				itemIds.push(item.id);
			} catch (error) {
				if (isFileExists(error)) {
					duplicateItemCount += 1;
					continue;
				}
				throw error;
			}
		}
		const nextCheckpoint: FeedCheckpoint = compactUndefined({
			...checkpoint,
			...nextCheckpointBase,
			lastItemIds: parsed.map((item) => item.id).slice(0, 50),
			error: undefined,
		});
		await writeJsonFileAtomic(feedCheckpointPath(context, source.id), nextCheckpoint);
		const run: FeedPollRun = {
			id: runId,
			sourceId: source.id,
			status: "completed",
			startedAt,
			finishedAt: new Date().toISOString(),
			url: source.url,
			httpStatus: response.status,
			parsedItemCount: parsed.length,
			newItemCount: itemIds.length,
			duplicateItemCount,
			itemIds,
			checkpoint: nextCheckpoint,
		};
		await writeJsonFileAtomic(feedRunPath(context, run.id), run);
		return run;
	} catch (error) {
		const nextCheckpoint: FeedCheckpoint = compactUndefined({
			...checkpoint,
			sourceId: source.id,
			updatedAt: new Date().toISOString(),
			lastPolledAt: startedAt,
			error: errorMessage(error),
		});
		await writeJsonFileAtomic(feedCheckpointPath(context, source.id), nextCheckpoint);
		const run: FeedPollRun = {
			id: runId,
			sourceId: source.id,
			status: "failed",
			startedAt,
			finishedAt: new Date().toISOString(),
			url: source.url,
			parsedItemCount: 0,
			newItemCount: 0,
			duplicateItemCount: 0,
			itemIds: [],
			checkpoint: nextCheckpoint,
			error: errorMessage(error),
		};
		await writeJsonFileAtomic(feedRunPath(context, run.id), run);
		return run;
	}
}

function parseFeedSource(value: unknown): FeedSource {
	const input = record(value);
	const id = requiredString(input.id, "feed source id");
	validateSlug(id, "feed source id");
	const kind = requiredString(input.kind, `feed source ${id} kind`);
	if (kind !== "rss" && kind !== "atom") {
		throw new Error(`Unsupported feed source kind for ${id}: ${kind}`);
	}
	const maxItems = optionalPositiveInteger(input.max_items, `feed source ${id} max_items`) ??
		optionalPositiveInteger(input.maxItems, `feed source ${id} maxItems`);
	const latestOnly = input.latest_only === true || input.latestOnly === true;
	if (latestOnly && maxItems !== undefined && maxItems !== 1) {
		throw new Error(`feed source ${id} latest_only cannot be combined with max_items other than 1`);
	}
	return {
		id,
		kind,
		url: requiredString(input.url, `feed source ${id} url`),
		enabled: input.enabled !== false,
		title: optionalString(input.title),
		maxContentBytes: optionalPositiveInteger(input.max_content_bytes, `feed source ${id} max_content_bytes`) ??
			optionalPositiveInteger(input.maxContentBytes, `feed source ${id} maxContentBytes`) ??
			20_000,
		storeRaw: input.store_raw === true || input.storeRaw === true,
		maxItems: latestOnly ? 1 : maxItems,
		latestOnly,
	};
}

function parseFeedText(text: string, source: FeedSource, observedAt: string): FeedItem[] {
	if (source.kind === "rss") {
		return parseRssFeed(text, source, observedAt);
	}
	if (source.kind === "atom") {
		return parseAtomFeed(text, source, observedAt);
	}
	throw new Error(`Unsupported feed source kind for ${source.id}: ${source.kind}`);
}

function parseRssFeed(xml: string, source: FeedSource, observedAt: string): FeedItem[] {
	const root = parseXmlDocument(xml);
	const channel = findDescendant(root, "channel") ?? root;
	const items = channel.children.filter((child) => child.name === "item");
	if (items.length === 0) {
		throw new Error(`RSS feed ${source.id} did not contain channel item entries`);
	}
	return items.map((node) => rssItemToFeedItem(node, source, observedAt));
}

function parseAtomFeed(xml: string, source: FeedSource, observedAt: string): FeedItem[] {
	const root = parseXmlDocument(xml);
	const feed = findDescendant(root, "feed") ?? root;
	const entries = feed.children.filter((child) => child.name === "entry");
	if (entries.length === 0) {
		throw new Error(`Atom feed ${source.id} did not contain feed entry items`);
	}
	return entries.map((node) => atomEntryToFeedItem(node, source, observedAt));
}

function limitFeedItems(items: FeedItem[], source: FeedSource): FeedItem[] {
	if (!source.maxItems || items.length <= source.maxItems) {
		return items;
	}
	return items
		.map((item, index) => ({ item, index }))
		.sort((left, right) => {
			const byTime = feedItemTime(right.item) - feedItemTime(left.item);
			return byTime === 0 ? left.index - right.index : byTime;
		})
		.slice(0, source.maxItems)
		.map((entry) => entry.item);
}

function feedItemTime(item: FeedItem): number {
	const value = item.publishedAt ?? item.updatedAt;
	if (!value) {
		return 0;
	}
	const time = Date.parse(value);
	return Number.isFinite(time) ? time : 0;
}

function atomEntryToFeedItem(node: XmlNode, source: FeedSource, observedAt: string): FeedItem {
	const title = normalizedText(childText(node, "title")) || "(untitled)";
	const links = atomLinks(node);
	const url = atomEntryUrl(links);
	const entryId = normalizedText(childText(node, "id"));
	const publishedAt = dateString(childText(node, "published"));
	const updatedAt = dateString(childText(node, "updated"));
	const summary = stripHtml(childText(node, "summary"));
	const contentText = stripHtml(childText(node, "content")) || summary;
	const externalId = entryId || url || stableHash(`${title}\0${publishedAt ?? updatedAt ?? ""}\0${contentText || summary}`).slice(0, 32);
	const id = feedItemId(source.id, externalId);
	return compactUndefined({
		id,
		sourceId: source.id,
		sourceKind: source.kind,
		status: "new" as const,
		externalId,
		title: truncateBytes(title, 2_000),
		url,
		publishedAt,
		updatedAt,
		summary: summary ? truncateBytes(summary, source.maxContentBytes) : undefined,
		contentText: contentText ? truncateBytes(contentText, source.maxContentBytes) : undefined,
		observedAt,
		raw: source.storeRaw
			? compactUndefined({
				id: entryId || undefined,
				published: normalizedText(childText(node, "published")) || undefined,
				updated: normalizedText(childText(node, "updated")) || undefined,
				links,
			})
			: undefined,
	});
}

function rssItemToFeedItem(node: XmlNode, source: FeedSource, observedAt: string): FeedItem {
	const title = normalizedText(childText(node, "title")) || "(untitled)";
	const link = normalizedText(childText(node, "link"));
	const guid = normalizedText(childText(node, "guid"));
	const pubDate = dateString(childText(node, "pubdate"));
	const updatedAt = dateString(childText(node, "updated"));
	const description = stripHtml(childText(node, "description"));
	const content = stripHtml(childText(node, "content:encoded"));
	const externalId = guid || link || stableHash(`${title}\0${pubDate ?? ""}\0${content}`).slice(0, 32);
	const id = feedItemId(source.id, externalId);
	return compactUndefined({
		id,
		sourceId: source.id,
		sourceKind: source.kind,
		status: "new" as const,
		externalId,
		title: truncateBytes(title, 2_000),
		url: link || undefined,
		publishedAt: pubDate,
		updatedAt,
		summary: description ? truncateBytes(description, source.maxContentBytes) : undefined,
		contentText: content ? truncateBytes(content, source.maxContentBytes) : undefined,
		observedAt,
		raw: source.storeRaw
			? compactUndefined({
				guid: guid || undefined,
				pubDate: normalizedText(childText(node, "pubdate")) || undefined,
			})
			: undefined,
	});
}

function atomEntryUrl(links: Array<{ rel?: string; href?: string }>): string | undefined {
	const alternate = links.find((link) => (link.rel ?? "alternate") === "alternate" && link.href);
	return alternate?.href ?? links.find((link) => link.href)?.href;
}

function atomLinks(node: XmlNode): Array<{ rel?: string; href?: string; type?: string; title?: string }> {
	return node.children
		.filter((child) => child.name === "link")
		.map((child) => compactUndefined({
			rel: optionalString(child.attributes.rel),
			href: optionalString(child.attributes.href),
			type: optionalString(child.attributes.type),
			title: optionalString(child.attributes.title),
		}));
}

type XmlNode = {
	name: string;
	attributes: Record<string, string>;
	text: string;
	children: XmlNode[];
};

function parseXmlDocument(xml: string): XmlNode {
	const root: XmlNode = { name: "#document", attributes: {}, text: "", children: [] };
	const stack = [root];
	let index = 0;
	while (index < xml.length) {
		const openIndex = xml.indexOf("<", index);
		if (openIndex === -1) {
			appendXmlText(stack, xml.slice(index));
			break;
		}
		appendXmlText(stack, xml.slice(index, openIndex));
		if (xml.startsWith("<!--", openIndex)) {
			const closeIndex = xml.indexOf("-->", openIndex + 4);
			index = closeIndex === -1 ? xml.length : closeIndex + 3;
			continue;
		}
		if (xml.startsWith("<![CDATA[", openIndex)) {
			const closeIndex = xml.indexOf("]]>", openIndex + 9);
			appendXmlText(stack, closeIndex === -1
				? xml.slice(openIndex + 9)
				: xml.slice(openIndex + 9, closeIndex));
			index = closeIndex === -1 ? xml.length : closeIndex + 3;
			continue;
		}
		if (xml.startsWith("<?", openIndex)) {
			const closeIndex = xml.indexOf("?>", openIndex + 2);
			index = closeIndex === -1 ? xml.length : closeIndex + 2;
			continue;
		}
		const closeIndex = xml.indexOf(">", openIndex + 1);
		if (closeIndex === -1) {
			break;
		}
		const body = xml.slice(openIndex + 1, closeIndex).trim();
		if (!body) {
			index = closeIndex + 1;
			continue;
		}
		if (body.startsWith("/")) {
			const name = body.slice(1).trim().split(/\s+/)[0]?.toLowerCase();
			while (stack.length > 1) {
				const current = stack.pop();
				if (current?.name === name) {
					break;
				}
			}
			index = closeIndex + 1;
			continue;
		}
		const selfClosing = body.endsWith("/");
		const tagText = body.replace(/\/$/, "").trim();
		const name = tagText.split(/\s+/)[0]?.toLowerCase();
		if (name) {
			const node: XmlNode = {
				name,
				attributes: parseXmlAttributes(tagText.slice(name.length)),
				text: "",
				children: [],
			};
			stack[stack.length - 1]?.children.push(node);
			if (!selfClosing) {
				stack.push(node);
			}
		}
		index = closeIndex + 1;
	}
	return root;
}

function parseXmlAttributes(text: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (const match of text.matchAll(/([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>/]+))/g)) {
		const name = match[1]?.toLowerCase();
		if (!name) {
			continue;
		}
		attributes[name] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? "");
	}
	return attributes;
}

function appendXmlText(stack: XmlNode[], text: string): void {
	if (!text) {
		return;
	}
	const current = stack[stack.length - 1];
	if (current) {
		current.text += decodeEntities(text);
	}
}

function findDescendant(node: XmlNode, name: string): XmlNode | undefined {
	for (const child of node.children) {
		if (child.name === name) {
			return child;
		}
		const nested = findDescendant(child, name);
		if (nested) {
			return nested;
		}
	}
	return undefined;
}

function childText(node: XmlNode, name: string): string {
	const child = node.children.find((item) => item.name === name);
	if (!child) {
		return "";
	}
	return textContent(child);
}

function textContent(node: XmlNode): string {
	return `${node.text}${node.children.map(textContent).join("")}`;
}

function stripHtml(value: string): string {
	return normalizedText(value.replace(/<[^>]*>/g, " "));
}

function normalizedText(value: string): string {
	return decodeEntities(value).replace(/\s+/g, " ").trim();
}

function decodeEntities(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
		const lower = entity.toLowerCase();
		if (lower === "amp") {
			return "&";
		}
		if (lower === "lt") {
			return "<";
		}
		if (lower === "gt") {
			return ">";
		}
		if (lower === "quot") {
			return "\"";
		}
		if (lower === "apos") {
			return "'";
		}
		if (lower.startsWith("#x")) {
			const code = Number.parseInt(lower.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		if (lower.startsWith("#")) {
			const code = Number.parseInt(lower.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return match;
	});
}

async function readFeedRuns(context: FeedContext): Promise<FeedPollRun[]> {
	const runs: FeedPollRun[] = [];
	try {
		for (const file of await readdir(feedRunDir(context))) {
			if (file.endsWith(".json")) {
				runs.push(normalizeFeedPollRun(await readJsonFile(path.join(feedRunDir(context), file))));
			}
		}
	} catch (error) {
		if (!isNotFound(error)) {
			throw error;
		}
	}
	return runs;
}

async function readFeedCheckpoint(context: FeedContext, sourceId: string): Promise<FeedCheckpoint | undefined> {
	try {
		return normalizeFeedCheckpoint(await readJsonFile(feedCheckpointPath(context, sourceId)));
	} catch (error) {
		if (isNotFound(error)) {
			return undefined;
		}
		throw error;
	}
}

async function readFeedCollectCursor(context: FeedContext, cursor: string): Promise<FeedCollectCursor | undefined> {
	try {
		return normalizeFeedCollectCursor(await readJsonFile(feedCollectCursorPath(context, cursor)));
	} catch (error) {
		if (isNotFound(error)) {
			return undefined;
		}
		throw error;
	}
}

function checkpointForResponse(sourceId: string, response: FeedFetchResponse, polledAt: string): FeedCheckpoint {
	return compactUndefined({
		sourceId,
		updatedAt: new Date().toISOString(),
		lastPolledAt: polledAt,
		lastStatus: response.status,
		etag: response.headers.get("etag") ?? response.headers.get("ETag") ?? undefined,
		lastModified: response.headers.get("last-modified") ?? response.headers.get("Last-Modified") ?? undefined,
	});
}

function isAfterCursor(item: FeedItem, cursor: FeedCollectCursor | undefined): boolean {
	if (!cursor?.lastObservedAt || !cursor.lastItemId) {
		return true;
	}
	if (item.observedAt > cursor.lastObservedAt) {
		return true;
	}
	return item.observedAt === cursor.lastObservedAt && item.id > cursor.lastItemId;
}

function feedCursorStateForItems(
	cursor: string,
	items: FeedItem[],
	previousCursor: FeedCollectCursor | undefined,
): FeedCollectCursor {
	const latest = items[items.length - 1];
	return compactUndefined({
		cursor,
		updatedAt: new Date().toISOString(),
		lastObservedAt: latest?.observedAt ?? previousCursor?.lastObservedAt,
		lastItemId: latest?.id ?? previousCursor?.lastItemId,
	});
}

function compareFeedItems(left: FeedItem, right: FeedItem): number {
	const byObserved = left.observedAt.localeCompare(right.observedAt);
	return byObserved === 0 ? left.id.localeCompare(right.id) : byObserved;
}

async function contextFromParams(
	params: unknown,
	options: CreateFeedMethodsOptions,
): Promise<FeedContext> {
	const input = record(params);
	return await createFeedContext({
		root: optionalString(input.root) ?? optionalString(input.feedRoot) ?? options.root,
		mode: parseFeedMode(optionalString(input.mode)),
		env: options.env,
	});
}

async function ensureFeedStateDirs(context: FeedContext): Promise<void> {
	for (const dir of [
		feedSourceDir(context),
		feedItemDir(context),
		feedRunDir(context),
		feedCollectCursorDir(context),
		path.join(context.stateRoot, "locks"),
	]) {
		await mkdir(dir, { recursive: true });
	}
}

function feedSourceDir(context: FeedContext): string {
	return path.join(context.stateRoot, "sources");
}

function feedItemDir(context: FeedContext): string {
	return path.join(context.stateRoot, "items");
}

function feedRunDir(context: FeedContext): string {
	return path.join(context.stateRoot, "runs");
}

function feedCollectCursorDir(context: FeedContext): string {
	return path.join(context.stateRoot, "collect-cursors");
}

function feedCheckpointPath(context: FeedContext, sourceId: string): string {
	return path.join(feedSourceDir(context), `${safeFileSegment(sourceId)}.json`);
}

function feedItemPath(context: FeedContext, itemId: string): string {
	return path.join(feedItemDir(context), `${safeFileSegment(itemId)}.json`);
}

function feedRunPath(context: FeedContext, runId: string): string {
	return path.join(feedRunDir(context), `${safeFileSegment(runId)}.json`);
}

function feedCollectCursorPath(context: FeedContext, cursor: string): string {
	return path.join(feedCollectCursorDir(context), `${safeFileSegment(cursor)}.json`);
}

function feedCursorName(value: string | undefined): string {
	const cursor = value ?? "default";
	validateSlug(cursor, "feed cursor");
	return cursor;
}

function feedItemId(sourceId: string, externalId: string): string {
	return `feed-${safeFileSegment(sourceId)}-${stableHash(`${sourceId}\0${externalId}`).slice(0, 20)}`;
}

function feedRunId(sourceId: string, startedAt: string): string {
	return `feed-run-${safeFileSegment(sourceId)}-${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function stableHash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function defaultFeedFetch(url: string, init?: { headers?: Record<string, string> }): Promise<FeedFetchResponse> {
	return await globalThis.fetch(url, init);
}

async function readJsonFile(file: string): Promise<unknown> {
	return JSON.parse(await readFile(file, "utf8")) as unknown;
}

async function writeNewJsonFile(file: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const handle = await open(file, "wx");
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
	} finally {
		await handle.close();
	}
}

async function writeJsonFileAtomic(file: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const tmpPath = `${file}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
	await rename(tmpPath, file);
}

function compactUndefined<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) {
		if (value[key] === undefined) {
			delete value[key];
		}
	}
	return value;
}

function truncateBytes(value: string, maxBytes: number): string {
	const buffer = Buffer.from(value, "utf8");
	if (buffer.byteLength <= maxBytes) {
		return value;
	}
	return buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
}

function dateString(value: string): string | undefined {
	const text = normalizedText(value);
	if (!text) {
		return undefined;
	}
	const date = new Date(text);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeOptionalDateString(value: string | undefined, label: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const parsed = dateString(value);
	if (!parsed) {
		throw new Error(`${label} must be a valid date string`);
	}
	return parsed;
}

function feedAppendRawPayload(input: Record<string, unknown>): Record<string, unknown> | undefined {
	if (isPlainRecord(input.raw)) {
		return input.raw;
	}
	if (input.raw !== undefined) {
		return { raw: input.raw };
	}
	if (isPlainRecord(input.payload)) {
		return input.payload;
	}
	if (input.payload !== undefined) {
		return { payload: input.payload };
	}
	return undefined;
}

function safeFileSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 160) || "feed";
}

function validateSlug(value: string, label: string): void {
	if (!/^[A-Za-z0-9._-]+$/.test(value)) {
		throw new Error(`${label} must contain only letters, numbers, dots, underscores, or hyphens: ${value}`);
	}
}

function feedItemStatusValue(value: unknown): FeedItemStatus | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "new") {
		return value;
	}
	throw new Error(`Invalid feed item status: ${String(value)}`);
}

function normalizeFeedItem(value: unknown): FeedItem {
	const input = record(value);
	const status = feedItemStatusValue(input.status);
	if (!status) {
		throw new Error("feed item status is required");
	}
	return compactUndefined({
		id: requiredString(input.id, "feed item id"),
		sourceId: requiredString(input.sourceId, "feed item sourceId"),
		sourceKind: feedItemSourceKindValue(input.sourceKind),
		status,
		externalId: requiredString(input.externalId, "feed item externalId"),
		title: requiredString(input.title, "feed item title"),
		url: optionalString(input.url),
		publishedAt: optionalString(input.publishedAt),
		updatedAt: optionalString(input.updatedAt),
		summary: optionalString(input.summary),
		contentText: optionalString(input.contentText),
		observedAt: requiredString(input.observedAt, "feed item observedAt"),
		raw: isPlainRecord(input.raw) ? input.raw : undefined,
	});
}

function normalizeFeedCheckpoint(value: unknown): FeedCheckpoint {
	const input = record(value);
	return compactUndefined({
		sourceId: requiredString(input.sourceId, "feed checkpoint sourceId"),
		updatedAt: requiredString(input.updatedAt, "feed checkpoint updatedAt"),
		lastPolledAt: optionalString(input.lastPolledAt),
		lastStatus: optionalNumber(input.lastStatus),
		etag: optionalString(input.etag),
		lastModified: optionalString(input.lastModified),
		lastItemIds: stringArrayValue(input.lastItemIds),
		error: optionalString(input.error),
	});
}

function normalizeFeedPollRun(value: unknown): FeedPollRun {
	const input = record(value);
	return compactUndefined({
		id: requiredString(input.id, "feed poll run id"),
		sourceId: requiredString(input.sourceId, "feed poll run sourceId"),
		status: feedPollRunStatusValue(input.status),
		startedAt: requiredString(input.startedAt, "feed poll run startedAt"),
		finishedAt: requiredString(input.finishedAt, "feed poll run finishedAt"),
		url: requiredString(input.url, "feed poll run url"),
		httpStatus: optionalNumber(input.httpStatus),
		parsedItemCount: numberValue(input.parsedItemCount, "feed poll run parsedItemCount"),
		newItemCount: numberValue(input.newItemCount, "feed poll run newItemCount"),
		duplicateItemCount: numberValue(input.duplicateItemCount, "feed poll run duplicateItemCount"),
		itemIds: stringArrayValue(input.itemIds) ?? [],
		checkpoint: input.checkpoint === undefined ? undefined : normalizeFeedCheckpoint(input.checkpoint),
		error: optionalString(input.error),
	});
}

function normalizeFeedCollectCursor(value: unknown): FeedCollectCursor {
	const input = record(value);
	return compactUndefined({
		cursor: requiredString(input.cursor, "feed collect cursor cursor"),
		updatedAt: requiredString(input.updatedAt, "feed collect cursor updatedAt"),
		lastObservedAt: optionalString(input.lastObservedAt),
		lastItemId: optionalString(input.lastItemId),
	});
}

function feedSourceKindValue(value: unknown): FeedSourceKind {
	if (value === "rss" || value === "atom") {
		return value;
	}
	throw new Error(`Invalid feed source kind: ${String(value)}`);
}

function feedItemSourceKindValue(value: unknown): FeedItemSourceKind {
	if (value === "manual") {
		return value;
	}
	return feedSourceKindValue(value);
}

function feedPollRunStatusValue(value: unknown): FeedPollRun["status"] {
	if (value === "completed" || value === "failed" || value === "not-modified" || value === "skipped") {
		return value;
	}
	throw new Error(`Invalid feed poll run status: ${String(value)}`);
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function stringArrayValue(value: unknown): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error("Expected a string array");
	}
	return value as string[];
}

function numberValue(value: unknown, label: string): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	throw new Error(`${label} must be a finite number`);
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	return requiredPositiveInteger(value, label);
}

function requiredPositiveInteger(value: unknown, label: string): number {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return value;
	}
	if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
		return Number(value);
	}
	throw new Error(`${label} must be a positive integer`);
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
