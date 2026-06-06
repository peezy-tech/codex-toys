import { describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import {
	advanceFeedCursor,
	appendFeedItem,
	collectFeedItems,
	collectFeedDoctorInfo,
	createFeedContext,
	createFeedMethods,
	FEED_ITEM_APPEND_METHOD,
	dispatchFeedItems,
	FEED_CURSOR_ADVANCE_METHOD,
	FEED_DISPATCH_METHOD,
	FEED_POLL_METHOD,
	listFeedItems,
	loadFeedConfig,
	pollFeedSources,
	pruneFeedItems,
	readFeedItem,
	resolveFeedMode,
	type FeedFetch,
	type FeedFetchResponse,
} from "@codex-toys/feed";

describe("feed primitive", () => {
	test("resolves mode and loads .codex/feed.toml sources", async () => {
		expect(resolveFeedMode("auto", { GITHUB_ACTIONS: "true" })).toEqual({
			requestedMode: "auto",
			mode: "actions",
		});
		expect(resolveFeedMode("auto", {})).toEqual({
			requestedMode: "auto",
			mode: "local",
		});

		const root = await tempFeedRoot();
		const context = await createFeedContext({ root, mode: "local", env: {} });
		const config = await loadFeedConfig(context);
		expect(config.path).toBe(path.join(root, ".codex", "feed.toml"));
		expect(config.sources).toEqual([
			expect.objectContaining({
				id: "example",
				kind: "rss",
				enabled: true,
				maxContentBytes: 64,
				storeRaw: false,
				latestOnly: false,
			}),
		]);
		expect(context.stateRoot).toBe(path.join(root, ".codex", "feed", "local"));
	});

	test("polls RSS, stores new items, checkpoints HTTP state, and dedupes repeats", async () => {
		const root = await tempFeedRoot();
		const context = await createFeedContext({ root, mode: "local", env: {} });
		const config = await loadFeedConfig(context);
		const fetches: Array<{ url: string; headers?: Record<string, string> }> = [];
		const fetch: FeedFetch = async (url, init) => {
			fetches.push({ url, headers: init?.headers });
			return response({
				status: 200,
				headers: {
					etag: "etag-1",
					"last-modified": "Mon, 01 Jun 2026 12:00:00 GMT",
				},
				body: rss([
					{
						guid: "release-1",
						title: "Release 1",
						link: "https://example.test/release-1",
						pubDate: "Mon, 01 Jun 2026 12:00:00 GMT",
						description: "First &amp; useful",
					},
				]),
			});
		};

		const first = await pollFeedSources(context, config, {
			fetch,
			now: new Date("2026-06-01T12:30:00.000Z"),
		});
		expect(first.runs).toHaveLength(1);
		expect(first.runs[0]).toMatchObject({
			sourceId: "example",
			status: "completed",
			parsedItemCount: 1,
			newItemCount: 1,
			duplicateItemCount: 0,
			httpStatus: 200,
		});
		const items = await listFeedItems(context);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			sourceId: "example",
			title: "Release 1",
			url: "https://example.test/release-1",
			publishedAt: "2026-06-01T12:00:00.000Z",
			summary: "First & useful",
			observedAt: "2026-06-01T12:30:00.000Z",
		});

		const second = await pollFeedSources(context, config, {
			fetch,
			now: new Date("2026-06-01T12:40:00.000Z"),
		});
		expect(second.runs[0]).toMatchObject({
			newItemCount: 0,
			duplicateItemCount: 1,
		});
		expect(fetches[1]?.headers).toMatchObject({
			"If-None-Match": "etag-1",
			"If-Modified-Since": "Mon, 01 Jun 2026 12:00:00 GMT",
		});
		const checkpoint = JSON.parse(
			await readFile(path.join(context.stateRoot, "sources", "example.json"), "utf8"),
		) as Record<string, unknown>;
		expect(checkpoint.etag).toBe("etag-1");
		expect(checkpoint.lastItemIds).toContain(items[0]?.id);
	});

	test("collects with named cursors and prunes old items", async () => {
		const root = await tempFeedRoot();
		const context = await createFeedContext({ root, mode: "local", env: {} });
		const config = await loadFeedConfig(context);
		const fetch: FeedFetch = async () => response({
			status: 200,
			body: rss([
				{
					guid: "old",
					title: "Old",
					pubDate: "Sun, 31 May 2026 12:00:00 GMT",
				},
				{
					guid: "new",
					title: "New",
					pubDate: "Mon, 01 Jun 2026 12:00:00 GMT",
				},
			]),
		});
		await pollFeedSources(context, config, {
			fetch,
			now: new Date("2026-06-01T12:00:00.000Z"),
		});

		const first = await collectFeedItems(context, { cursor: "radar", limit: 1 });
		expect(first.advanced).toBe(true);
		expect(first.items.map((item) => item.title)).toEqual(["Old"]);
		const second = await collectFeedItems(context, { cursor: "radar" });
		expect(second.items.map((item) => item.title)).toEqual(["New"]);
		const third = await collectFeedItems(context, { cursor: "radar" });
		expect(third.items).toEqual([]);

		const dryRun = await pruneFeedItems(context, {
			olderThanDays: 1,
			dryRun: true,
			now: new Date("2026-06-03T12:00:00.000Z"),
		});
		expect(dryRun.pruned).toBe(2);
		expect(await listFeedItems(context)).toHaveLength(2);

		const pruned = await pruneFeedItems(context, {
			olderThanDays: 1,
			now: new Date("2026-06-03T12:00:00.000Z"),
		});
		expect(pruned.pruned).toBe(2);
		expect(await listFeedItems(context)).toHaveLength(0);
	});

	test("appends manual feed items and dedupes by external id", async () => {
		const root = await tempFeedRoot();
		const context = await createFeedContext({ root, mode: "local", env: {} });
		const first = await appendFeedItem(context, {
			sourceId: "hq-dispatch-results",
			externalId: "dispatch-1",
			title: "Dispatch result",
			summary: "Workbench task completed",
			raw: { status: "completed", runId: "run-1" },
			now: new Date("2026-06-05T12:00:00.000Z"),
		});
		expect(first).toMatchObject({
			appended: true,
			duplicate: false,
			item: {
				sourceId: "hq-dispatch-results",
				sourceKind: "manual",
				externalId: "dispatch-1",
				title: "Dispatch result",
				observedAt: "2026-06-05T12:00:00.000Z",
				raw: { status: "completed", runId: "run-1" },
			},
		});
		const duplicate = await appendFeedItem(context, {
			sourceId: "hq-dispatch-results",
			externalId: "dispatch-1",
			title: "Dispatch result replay",
		});
		expect(duplicate).toMatchObject({
			appended: false,
			duplicate: true,
			item: {
				id: first.item.id,
				title: "Dispatch result",
			},
		});
		expect((await collectFeedItems(context, {
			cursor: "manual",
			sourceId: "hq-dispatch-results",
			advance: false,
		})).items.map((item) => item.id)).toEqual([first.item.id]);
	});

	test("limits RSS intake to latest_only or max_items", async () => {
		const latestRoot = await tempFeedRoot({
			extraSourceConfig: "latest_only = true",
		});
		const latestContext = await createFeedContext({ root: latestRoot, mode: "local", env: {} });
		const latestConfig = await loadFeedConfig(latestContext);
		await pollFeedSources(latestContext, latestConfig, {
			fetch: async () => response({
				status: 200,
				body: rss([
					{ guid: "v1", title: "cli-utility v0.1.0", pubDate: "Mon, 01 Jun 2026 21:33:10 +0000" },
					{ guid: "v2", title: "cli-utility v0.1.1", pubDate: "Mon, 01 Jun 2026 21:37:57 +0000" },
					{ guid: "v3", title: "cli-utility v0.1.2", pubDate: "Mon, 01 Jun 2026 22:39:32 +0000" },
				]),
			}),
		});
		expect((await listFeedItems(latestContext)).map((item) => item.title))
			.toEqual(["cli-utility v0.1.2"]);

		const maxRoot = await tempFeedRoot({
			extraSourceConfig: "max_items = 2",
		});
		const maxContext = await createFeedContext({ root: maxRoot, mode: "local", env: {} });
		await pollFeedSources(maxContext, await loadFeedConfig(maxContext), {
			fetch: async () => response({
				status: 200,
				body: rss([
					{ guid: "v1", title: "cli-utility v0.1.0", pubDate: "Mon, 01 Jun 2026 21:33:10 +0000" },
					{ guid: "v2", title: "cli-utility v0.1.1", pubDate: "Mon, 01 Jun 2026 21:37:57 +0000" },
					{ guid: "v3", title: "cli-utility v0.1.2", pubDate: "Mon, 01 Jun 2026 22:39:32 +0000" },
				]),
			}),
		});
		expect((await listFeedItems(maxContext)).map((item) => item.title).sort())
			.toEqual(["cli-utility v0.1.1", "cli-utility v0.1.2"]);
	});

	test("polls GitHub-like Atom latest release and dedupes repeats", async () => {
		const root = await tempFeedRoot({
			kind: "atom",
			url: "https://github.com/peezy-tech/cli-utility/releases.atom",
			extraSourceConfig: "latest_only = true\nstore_raw = true",
		});
		const context = await createFeedContext({ root, mode: "local", env: {} });
		const config = await loadFeedConfig(context);
		const fetch: FeedFetch = async () => response({
			status: 200,
			body: atomReleaseFeed([
				{
					id: "tag:github.com,2008:Repository/123/v0.1.2",
					title: "v0.1.2",
					url: "https://github.com/peezy-tech/cli-utility/releases/tag/v0.1.2",
					published: "2026-06-01T22:39:32Z",
					updated: "2026-06-01T22:39:32Z",
					content: "<p>Older release.</p>",
				},
				{
					id: "tag:github.com,2008:Repository/123/v0.1.3",
					title: "v0.1.3",
					url: "https://github.com/peezy-tech/cli-utility/releases/tag/v0.1.3",
					published: "2026-06-02T01:16:43Z",
					updated: "2026-06-02T01:18:00Z",
					content: "<p>Adds generated bindings.</p>",
				},
			]),
		});

		const first = await pollFeedSources(context, config, {
			fetch,
			now: new Date("2026-06-02T01:20:00.000Z"),
		});
		expect(first.runs[0]).toMatchObject({
			sourceId: "example",
			status: "completed",
			parsedItemCount: 1,
			newItemCount: 1,
			duplicateItemCount: 0,
		});
		const items = await listFeedItems(context);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			sourceId: "example",
			sourceKind: "atom",
			externalId: "tag:github.com,2008:Repository/123/v0.1.3",
			title: "v0.1.3",
			url: "https://github.com/peezy-tech/cli-utility/releases/tag/v0.1.3",
			publishedAt: "2026-06-02T01:16:43.000Z",
			updatedAt: "2026-06-02T01:18:00.000Z",
			contentText: "Adds generated bindings.",
			observedAt: "2026-06-02T01:20:00.000Z",
			raw: {
				id: "tag:github.com,2008:Repository/123/v0.1.3",
				published: "2026-06-02T01:16:43Z",
				updated: "2026-06-02T01:18:00Z",
				links: [
					{
						rel: "alternate",
						type: "text/html",
						href: "https://github.com/peezy-tech/cli-utility/releases/tag/v0.1.3",
					},
				],
			},
		});

		const second = await pollFeedSources(context, config, {
			fetch,
			now: new Date("2026-06-02T01:25:00.000Z"),
		});
		expect(second.runs[0]).toMatchObject({
			parsedItemCount: 1,
			newItemCount: 0,
			duplicateItemCount: 1,
		});
		expect(await listFeedItems(context)).toHaveLength(1);
	});

	test("dispatching an Atom release advances the cursor and prevents replay", async () => {
		const root = await tempFeedRoot({
			kind: "atom",
			url: "https://github.com/peezy-tech/cli-utility/releases.atom",
			extraSourceConfig: "latest_only = true",
		});
		const context = await createFeedContext({ root, mode: "local", env: {} });
		const config = await loadFeedConfig(context);
		await pollFeedSources(context, config, {
			fetch: async () => response({
				status: 200,
				body: atomReleaseFeed([
					{
						id: "tag:github.com,2008:Repository/123/v0.1.3",
						title: "v0.1.3",
						url: "https://github.com/peezy-tech/cli-utility/releases/tag/v0.1.3",
						published: "2026-06-02T01:16:43Z",
						updated: "2026-06-02T01:18:00Z",
						content: "<p>Adds generated bindings.</p>",
					},
				]),
			}),
			now: new Date("2026-06-02T01:20:00.000Z"),
		});
		const events: Array<{
			type: string;
			sourceKind: string;
			url?: string;
		}> = [];

		const dispatched = await dispatchFeedItems(context, config, {
			sourceId: "example",
			cursor: "cli-toys-bindings-refresh",
			poll: false,
			target: "workbench-task:cli-toys-bindings-refresh",
			runTarget: async (_target, event) => {
				events.push({
					type: event.type,
					sourceKind: event.payload.sourceKind,
					url: event.payload.url,
				});
				return { ok: true };
			},
		});
		expect(dispatched.status).toBe("completed");
		expect(dispatched.executions).toHaveLength(1);
		expect(events).toEqual([
			{
				type: "feed.item",
				sourceKind: "atom",
				url: "https://github.com/peezy-tech/cli-utility/releases/tag/v0.1.3",
			},
		]);

		const replay = await collectFeedItems(context, {
			cursor: "cli-toys-bindings-refresh",
			advance: false,
		});
		expect(replay.items).toEqual([]);
		const secondDispatch = await dispatchFeedItems(context, config, {
			sourceId: "example",
			cursor: "cli-toys-bindings-refresh",
			poll: false,
			target: "workbench-task:cli-toys-bindings-refresh",
			runTarget: async () => ({ ok: true }),
		});
		expect(secondDispatch.executions).toEqual([]);
	});

	test("rejects invalid latest_only and max_items combinations", async () => {
		const root = await tempFeedRoot({
			extraSourceConfig: "latest_only = true\nmax_items = 2",
		});
		const info = await collectFeedDoctorInfo(await createFeedContext({ root, env: {} }));
		expect(info.errors.join("\n")).toContain("latest_only");
	});

	test("collect can avoid advancing and cursor advance can acknowledge an item", async () => {
		const root = await tempFeedRoot();
		const context = await createFeedContext({ root, mode: "local", env: {} });
		await pollFeedSources(context, await loadFeedConfig(context), {
			fetch: async () => response({
				status: 200,
				body: rss([
					{ guid: "first", title: "First" },
					{ guid: "second", title: "Second" },
				]),
			}),
		});
		const first = await collectFeedItems(context, {
			cursor: "radar",
			limit: 1,
			advance: false,
		});
		expect(first.advanced).toBe(false);
		expect(first.cursorState).toBeUndefined();
		expect(first.pendingCursorState?.lastItemId).toBe(first.items[0]?.id);
		const replay = await collectFeedItems(context, {
			cursor: "radar",
			limit: 1,
			advance: false,
		});
		expect(replay.items[0]?.id).toBe(first.items[0]?.id);
		const advanced = await advanceFeedCursor(context, {
			cursor: "radar",
			itemId: first.items[0]?.id ?? "",
		});
		expect(advanced.cursorState.lastItemId).toBe(first.items[0]?.id);
		const next = await collectFeedItems(context, { cursor: "radar", advance: false });
		expect(next.items.map((item) => item.title)).toEqual(["Second"]);
	});

	test("dispatch advances after success and preserves cursor on failure", async () => {
		const root = await tempFeedRoot();
		const context = await createFeedContext({ root, mode: "local", env: {} });
		const config = await loadFeedConfig(context);
		await pollFeedSources(context, config, {
			fetch: async () => response({
				status: 200,
				body: rss([
					{ guid: "first", title: "First" },
					{ guid: "second", title: "Second" },
				]),
			}),
		});
		const events: string[] = [];
		const first = await dispatchFeedItems(context, config, {
			sourceId: "example",
			cursor: "radar",
			limit: 1,
			poll: false,
			target: "workbench-task:test",
			runTarget: async (_target, event) => {
				events.push(event.id);
				return { ok: true };
			},
		});
		expect(first.status).toBe("completed");
		expect(first.executions).toHaveLength(1);
		expect(first.executions[0]?.status).toBe("completed");
		expect(events[0]).toMatch(/^feed:/);
		const failed = await dispatchFeedItems(context, config, {
			sourceId: "example",
			cursor: "radar",
			poll: false,
			target: "workbench-task:test",
			runTarget: async () => {
				throw new Error("target failed");
			},
		});
		expect(failed.status).toBe("failed");
		expect(failed.executions[0]).toMatchObject({
			status: "failed",
			error: "target failed",
		});
		const replay = await collectFeedItems(context, {
			cursor: "radar",
			advance: false,
		});
		expect(replay.items.map((item) => item.title)).toEqual(["Second"]);
	});

	test("exposes feed toybox methods without requiring workbench state", async () => {
		const root = await tempFeedRoot();
		const methods = createFeedMethods({
			root,
			env: {},
			fetch: async () => response({
				status: 200,
				body: rss([{ guid: "toybox", title: "Toybox" }]),
			}),
			dispatchTarget: async () => ({ ok: true }),
		});
		const poll = await methods[FEED_POLL_METHOD]?.({}, {
			jsonrpc: "2.0",
			id: "feed",
			method: FEED_POLL_METHOD,
			params: {},
		});
		expect(poll).toMatchObject({
			mode: "local",
			runs: [expect.objectContaining({ sourceId: "example", newItemCount: 1 })],
		});
		const context = await createFeedContext({ root, mode: "local", env: {} });
		const item = (await listFeedItems(context))[0];
		expect(item ? await readFeedItem(context, item.id) : undefined)
			.toMatchObject({ title: "Toybox" });
		const append = await methods[FEED_ITEM_APPEND_METHOD]?.({
			sourceId: "manual-source",
			externalId: "manual-1",
			title: "Manual item",
			payload: { ok: true },
		}, {
			jsonrpc: "2.0",
			id: "feed",
			method: FEED_ITEM_APPEND_METHOD,
			params: {},
		});
		expect(append).toMatchObject({
			appended: true,
			item: expect.objectContaining({
				sourceKind: "manual",
				raw: { ok: true },
			}),
		});
		const advance = await methods[FEED_CURSOR_ADVANCE_METHOD]?.({
			itemId: item?.id,
		}, {
			jsonrpc: "2.0",
			id: "feed",
			method: FEED_CURSOR_ADVANCE_METHOD,
			params: {},
		});
		expect(advance).toMatchObject({ item: expect.objectContaining({ title: "Toybox" }) });
		const dispatch = await methods[FEED_DISPATCH_METHOD]?.({
			sourceId: "example",
			target: "workbench-task:test",
			poll: false,
		}, {
			jsonrpc: "2.0",
			id: "feed",
			method: FEED_DISPATCH_METHOD,
			params: {},
		});
		expect(dispatch).toMatchObject({ status: "completed" });
	});

	test("parses feed CLI commands", () => {
		expect(parseArgs(["feed", "doctor", "--mode", "actions", "--json"], {}))
			.toMatchObject({ type: "feed-doctor", mode: "actions", json: true });
		expect(parseArgs(["feed", "source", "list"], {}))
			.toMatchObject({ type: "feed-source-list" });
		expect(parseArgs(["feed", "poll", "--source", "example", "--feed-root", "/repo"], {}))
			.toMatchObject({ type: "feed-poll", sourceId: "example", feedRoot: "/repo" });
		expect(parseArgs(["feed", "item", "list", "--status", "new", "--limit", "2"], {}))
			.toMatchObject({ type: "feed-item-list", status: "new", limit: 2 });
		expect(parseArgs(["feed", "item", "read", "item-1"], {}))
			.toMatchObject({ type: "feed-item-read", itemId: "item-1" });
		expect(parseArgs(["feed", "item", "append", "--source", "hq-dispatch-results", "--params-json", "{\"title\":\"Result\"}"], {}))
			.toMatchObject({ type: "feed-item-append", sourceId: "hq-dispatch-results", paramsText: "{\"title\":\"Result\"}" });
		expect(parseArgs(["feed", "collect", "--cursor", "radar"], {}))
			.toMatchObject({ type: "feed-collect", cursor: "radar", advance: true });
		expect(parseArgs(["feed", "collect", "--cursor", "radar", "--no-advance"], {}))
			.toMatchObject({ type: "feed-collect", cursor: "radar", advance: false });
		expect(parseArgs(["feed", "cursor", "advance", "--cursor", "radar", "--item", "item-1"], {}))
			.toMatchObject({ type: "feed-cursor-advance", cursor: "radar", itemId: "item-1" });
		expect(parseArgs(["feed", "dispatch", "--source", "example", "--cursor", "radar", "--target", "workbench-task:test", "--no-poll"], {}))
			.toMatchObject({ type: "feed-dispatch", sourceId: "example", cursor: "radar", target: "workbench-task:test", poll: false });
		expect(parseArgs(["feed", "prune", "--older-than-days", "30", "--dry-run"], {}))
			.toMatchObject({ type: "feed-prune", olderThanDays: 30, dryRun: true });
	});

	test("doctor reports config errors without throwing", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codex-feed-bad-"));
		await mkdir(path.join(root, ".codex"), { recursive: true });
		await writeFile(path.join(root, ".codex", "feed.toml"), "[feed\n");
		const info = await collectFeedDoctorInfo(await createFeedContext({ root, env: {} }));
		expect(info.configExists).toBe(true);
		expect(info.errors.length).toBeGreaterThan(0);
	});
});

async function tempFeedRoot(options: {
	extraSourceConfig?: string;
	kind?: "rss" | "atom";
	url?: string;
} = {}): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "codex-feed-"));
	await mkdir(path.join(root, ".codex"), { recursive: true });
	await writeFile(path.join(root, ".codex", "feed.toml"), `
[feed]
name = "test-feed"

[[feed.sources]]
id = "example"
kind = "${options.kind ?? "rss"}"
url = "${options.url ?? "https://example.test/rss.xml"}"
max_content_bytes = 64
${options.extraSourceConfig ?? ""}
`);
	return root;
}

function response(options: {
	status: number;
	headers?: Record<string, string>;
	body?: string;
}): FeedFetchResponse {
	const headers = new Map(Object.entries(options.headers ?? {}));
	return {
		ok: options.status >= 200 && options.status < 300,
		status: options.status,
		headers: {
			get(name: string) {
				return headers.get(name) ?? headers.get(name.toLowerCase()) ?? null;
			},
		},
		async text() {
			return options.body ?? "";
		},
	};
}

function rss(items: Array<{
	guid: string;
	title: string;
	link?: string;
	pubDate?: string;
	description?: string;
}>): string {
	return `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Example</title>
    ${items.map((item) => `
    <item>
      <guid>${item.guid}</guid>
      <title>${item.title}</title>
      ${item.link ? `<link>${item.link}</link>` : ""}
      ${item.pubDate ? `<pubDate>${item.pubDate}</pubDate>` : ""}
      ${item.description ? `<description><![CDATA[${item.description}]]></description>` : ""}
    </item>
    `).join("")}
  </channel>
</rss>`;
}

function atomReleaseFeed(entries: Array<{
	id?: string;
	title: string;
	url?: string;
	published?: string;
	updated?: string;
	summary?: string;
	content?: string;
}>): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:github.com,2008:https://github.com/peezy-tech/cli-utility/releases</id>
  <link rel="alternate" type="text/html" href="https://github.com/peezy-tech/cli-utility/releases"/>
  <title>Release notes from cli-utility</title>
  ${entries.map((entry) => `
  <entry>
    ${entry.id ? `<id>${entry.id}</id>` : ""}
    <title>${entry.title}</title>
    ${entry.url ? `<link rel="alternate" type="text/html" href="${entry.url}"/>` : ""}
    ${entry.published ? `<published>${entry.published}</published>` : ""}
    ${entry.updated ? `<updated>${entry.updated}</updated>` : ""}
    ${entry.summary ? `<summary type="html"><![CDATA[${entry.summary}]]></summary>` : ""}
    ${entry.content ? `<content type="html"><![CDATA[${entry.content}]]></content>` : ""}
  </entry>
  `).join("")}
</feed>`;
}
