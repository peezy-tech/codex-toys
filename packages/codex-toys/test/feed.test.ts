import { describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import {
	advanceFeedCursor,
	collectFeedItems,
	collectFeedDoctorInfo,
	createFeedContext,
	createFeedMethods,
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
} = {}): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "codex-feed-"));
	await mkdir(path.join(root, ".codex"), { recursive: true });
	await writeFile(path.join(root, ".codex", "feed.toml"), `
[feed]
name = "test-feed"

[[feed.sources]]
id = "example"
kind = "rss"
url = "https://example.test/rss.xml"
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
