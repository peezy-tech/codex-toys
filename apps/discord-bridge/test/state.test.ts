import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { JsonFileStateStore } from "../src/state.ts";

describe("JsonFileStateStore", () => {
	test("loads per-thread grant metadata and older sessions without grants", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "discord-bridge-state-"));
		try {
			const statePath = path.join(dir, "state.json");
			await writeFile(
				statePath,
				`${JSON.stringify({
					version: 1,
					gateway: {
						homeChannelId: "home-channel",
						mainThreadId: "codex-gateway-thread",
						statusMessageId: "message-gateway-status",
						createdAt: "2026-05-11T00:00:00.000Z",
						toolsVersion: 1,
						delegations: [
							{
								id: "delegation-1",
								codexThreadId: "codex-delegated-thread",
								title: "Patchbay webhook work",
								status: "active",
								cwd: "/workspace/patchbay",
								discordDetailThreadId: "discord-detail-thread",
								parentDiscordMessageId: "message-parent",
								createdAt: "2026-05-11T00:00:01.000Z",
								updatedAt: "2026-05-11T00:00:02.000Z",
							},
						],
					},
					sessions: [
						{
							discordThreadId: "discord-thread-1",
							parentChannelId: "parent-channel",
							sourceMessageId: "message-start-1",
							codexThreadId: "codex-thread-1",
							title: "Granted thread",
							createdAt: "2026-05-11T00:00:00.000Z",
							ownerUserId: "user-1",
							participantUserIds: ["user-2", "", "user-2", "user-3"],
							cwd: "/workspace/project",
							mode: "gateway",
							statusMessageId: "message-status-1",
						},
						{
							discordThreadId: "discord-thread-2",
							parentChannelId: "parent-channel",
							codexThreadId: "codex-thread-2",
							title: "Older thread",
							createdAt: "2026-05-11T00:00:00.000Z",
						},
					],
					queue: [],
					activeTurns: [
						{
							turnId: "turn-active-1",
							discordThreadId: "discord-thread-1",
							codexThreadId: "codex-thread-1",
							origin: "external",
							startedAt: "2026-05-11T00:00:01.000Z",
							observedAt: "2026-05-11T00:00:02.000Z",
						},
						{
							turnId: "turn-active-2",
							discordThreadId: "discord-thread-2",
							codexThreadId: "codex-thread-2",
							origin: "unknown",
							queueItemId: "queue-1",
							observedAt: "2026-05-11T00:00:03.000Z",
						},
					],
					processedMessageIds: [],
					deliveries: [],
				})}\n`,
			);

			const state = await new JsonFileStateStore(statePath).load();

			expect(state.gateway).toEqual({
				homeChannelId: "home-channel",
				mainThreadId: "codex-gateway-thread",
				statusMessageId: "message-gateway-status",
				createdAt: "2026-05-11T00:00:00.000Z",
				toolsVersion: 1,
				delegations: [
					{
						id: "delegation-1",
						codexThreadId: "codex-delegated-thread",
						title: "Patchbay webhook work",
						status: "active",
						cwd: "/workspace/patchbay",
						discordDetailThreadId: "discord-detail-thread",
						parentDiscordMessageId: "message-parent",
						createdAt: "2026-05-11T00:00:01.000Z",
						updatedAt: "2026-05-11T00:00:02.000Z",
					},
				],
			});
			expect(state.sessions).toHaveLength(2);
			expect(state.sessions[0]?.ownerUserId).toBe("user-1");
			expect(state.sessions[0]?.sourceMessageId).toBe("message-start-1");
			expect(state.sessions[0]?.participantUserIds).toEqual([
				"user-2",
				"user-3",
			]);
			expect(state.sessions[0]?.cwd).toBe("/workspace/project");
			expect(state.sessions[0]?.mode).toBe("gateway");
			expect(state.sessions[0]?.statusMessageId).toBe("message-status-1");
			expect(state.sessions[1]?.ownerUserId).toBeUndefined();
			expect(state.sessions[1]?.sourceMessageId).toBeUndefined();
			expect(state.sessions[1]?.participantUserIds).toBeUndefined();
			expect(state.sessions[1]?.cwd).toBeUndefined();
			expect(state.sessions[1]?.mode).toBeUndefined();
			expect(state.sessions[1]?.statusMessageId).toBeUndefined();
			expect(state.activeTurns).toEqual([
				{
					turnId: "turn-active-1",
					discordThreadId: "discord-thread-1",
					codexThreadId: "codex-thread-1",
					origin: "external",
					startedAt: "2026-05-11T00:00:01.000Z",
					observedAt: "2026-05-11T00:00:02.000Z",
				},
				{
					turnId: "turn-active-2",
					discordThreadId: "discord-thread-2",
					codexThreadId: "codex-thread-2",
					origin: "external",
					queueItemId: "queue-1",
					observedAt: "2026-05-11T00:00:03.000Z",
				},
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
