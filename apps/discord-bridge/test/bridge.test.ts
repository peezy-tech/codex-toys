import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { JsonRpcNotification, JsonRpcRequest } from "@peezy.tech/codex-flows/rpc";
import type { v2 } from "@peezy.tech/codex-flows/generated";

import { DiscordCodexBridge, parseThreadStartIntent } from "../src/bridge.ts";
import type {
	DiscordConsoleMessage,
	DiscordConsoleOutput,
} from "../src/console-output.ts";
import { MemoryStateStore, emptyState } from "../src/state.ts";
import type {
	CodexBridgeClient,
	DiscordBridgeConfig,
	DiscordBridgeTransport,
	DiscordBridgeTransportHandlers,
	DiscordInbound,
} from "../src/types.ts";

describe("DiscordCodexBridge", () => {
	test("parses mention control text for resume and per-thread directories", () => {
		expect(parseThreadStartIntent("resume codex-thread-123 --dir ~/project")).toEqual({
			kind: "resume",
			codexThreadId: "codex-thread-123",
			cwd: path.join(os.homedir(), "project"),
		});
		expect(parseThreadStartIntent("--dir projects/demo inspect this")).toEqual({
			kind: "new",
			prompt: "inspect this",
			cwd: path.join(os.homedir(), "projects/demo"),
		});
		expect(parseThreadStartIntent("resume")).toEqual({
			kind: "invalid",
			message: "Usage: @codex resume <codex-thread-id> [--dir path]",
		});
	});

	test("starts a gateway main thread and routes home channel messages to it", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				gateway: { homeChannelId: "home-channel" },
				allowedChannelIds: new Set(["parent-channel"]),
			}),
		});

		await bridge.start();
		await waitFor(() => bridge.stateForTest().sessions.length === 1);
		expect(client.startThreadCalls).toHaveLength(1);
		expect(client.startThreadCalls[0]?.dynamicTools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					namespace: "codex_gateway",
					name: "start_delegation",
				}),
				expect.objectContaining({
					namespace: "codex_gateway",
					name: "list_flow_runs",
				}),
			]),
		);
		expect(client.setThreadNameCalls[0]).toEqual({
			threadId: "codex-thread-1",
			name: "[discord-gateway] Codex Gateway",
		});
		expect(bridge.stateForTest().gateway).toEqual(
			expect.objectContaining({
				homeChannelId: "home-channel",
				mainThreadId: "codex-thread-1",
				toolsVersion: 1,
			}),
		);
		expect(bridge.stateForTest().sessions[0]).toEqual(
			expect.objectContaining({
				discordThreadId: "home-channel",
				parentChannelId: "home-channel",
				codexThreadId: "codex-thread-1",
				title: "Codex Gateway",
				cwd: "/workspace",
				mode: "gateway",
			}),
		);

		transport.emit({
			kind: "message",
			channelId: "home-channel",
			messageId: "home-message-1",
			author: { id: "user-1", name: "Peezy", isBot: false },
			content: "status across the workspaces",
			createdAt: "2026-05-14T00:00:00.000Z",
		});

		await waitFor(() => client.startTurnCalls.length === 1);
		expect(inputText(client.startTurnCalls[0]?.input[0])).toContain(
			"status across the workspaces",
		);
		expect(inputText(client.startTurnCalls[0]?.input[0])).toContain(
			"[discord-gateway]",
		);
		expect(inputText(client.startTurnCalls[0]?.input[0])).toContain(
			"main Codex operator thread",
		);
		expect(inputText(client.startTurnCalls[0]?.input[0])).toContain(
			"Home channel: home-channel",
		);
		await bridge.stop();
	});

	test("gateway tool starts and tracks delegated Codex sessions without privileged tools", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig({
				gateway: { homeChannelId: "home-channel" },
			}),
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		});

		await bridge.start();
		await waitFor(() => bridge.stateForTest().sessions.length === 1);
		client.emitRequest({
			id: "tool-1",
			method: "item/tool/call",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-main",
				callId: "call-1",
				namespace: "codex_gateway",
				tool: "start_delegation",
				arguments: {
					cwd: "/workspace/other",
					title: "Other workspace",
					prompt: "Inspect the remaining gateway work.",
					discordDetailThreadId: "detail-thread",
					parentDiscordMessageId: "home-message",
				},
			},
		});

		await waitFor(() => client.responses.length === 1);
		expect(client.responseErrors).toEqual([]);
		expect(client.startThreadCalls).toHaveLength(2);
		expect(client.startThreadCalls[1]).toEqual(
			expect.objectContaining({ cwd: "/workspace/other" }),
		);
		expect(client.startThreadCalls[1]?.dynamicTools).toBeUndefined();
		expect(client.setThreadNameCalls[1]).toEqual({
			threadId: "codex-thread-2",
			name: "[delegated] Other workspace",
		});
		expect(client.startTurnCalls[0]).toEqual(
			expect.objectContaining({
				threadId: "codex-thread-2",
				cwd: "/workspace/other",
			}),
		);
		expect(inputText(client.startTurnCalls[0]?.input[0])).toBe(
			"Inspect the remaining gateway work.",
		);
		expect(bridge.stateForTest().gateway?.delegations).toEqual([
			expect.objectContaining({
				codexThreadId: "codex-thread-2",
				title: "Other workspace",
				status: "active",
				cwd: "/workspace/other",
				discordDetailThreadId: "detail-thread",
				parentDiscordMessageId: "home-message",
			}),
		]);
		expect(gatewayToolResult(client.responses[0]?.result)).toEqual(
			expect.objectContaining({
				turnId: "turn-1",
				delegation: expect.objectContaining({
					codexThreadId: "codex-thread-2",
				}),
			}),
		);
		await bridge.stop();
	});

	test("gateway rejects dynamic tool calls outside the main operator thread", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				gateway: { homeChannelId: "home-channel" },
			}),
		});

		await bridge.start();
		await waitFor(() => bridge.stateForTest().sessions.length === 1);
		client.emitRequest({
			id: "tool-1",
			method: "item/tool/call",
			params: {
				threadId: "codex-thread-elsewhere",
				namespace: "codex_gateway",
				tool: "list_delegations",
				arguments: {},
			},
		});

		await waitFor(() => client.responseErrors.length === 1);
		expect(client.responseErrors[0]).toEqual(
			expect.objectContaining({
				id: "tool-1",
				code: -32601,
				message: "Unknown dynamic tool request",
			}),
		);
		expect(client.responses).toEqual([]);
		await bridge.stop();
	});

	test("answers gateway status in the home channel without starting a turn", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				gateway: { homeChannelId: "home-channel" },
			}),
		});

		await bridge.start();
		await waitFor(() => bridge.stateForTest().sessions.length === 1);
		transport.emit({
			kind: "message",
			channelId: "home-channel",
			messageId: "status-message-1",
			author: { id: "user-1", name: "Peezy", isBot: false },
			content: "status",
			createdAt: "2026-05-14T00:00:00.000Z",
		});

		await waitFor(() =>
			transport.messages.some((message) =>
				message.channelId === "home-channel" &&
				message.text.includes("**Codex Gateway**")
			)
		);
		expect(client.startTurnCalls).toHaveLength(0);
		expect(bridge.stateForTest().processedMessageIds).toContain(
			"status-message-1",
		);
		await bridge.stop();
	});

	test("resumes a configured gateway main thread without creating Discord threads", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				gateway: {
					homeChannelId: "home-channel",
					mainThreadId: "codex-main-thread",
				},
			}),
		});

		await bridge.start();
		await waitFor(() => bridge.stateForTest().sessions.length === 1);

		expect(client.startThreadCalls).toHaveLength(0);
		expect(client.resumeThreadCalls[0]).toEqual(
			expect.objectContaining({ threadId: "codex-main-thread" }),
		);
		expect(transport.createdThreads).toEqual([]);
		expect(bridge.stateForTest().sessions[0]).toEqual(
			expect.objectContaining({
				discordThreadId: "home-channel",
				codexThreadId: "codex-main-thread",
				cwd: "/workspace",
				mode: "gateway",
			}),
		);
		await bridge.stop();
	});

	test("replaces stale persisted gateway sessions when no main thread is configured", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore({
			...emptyState(),
			gateway: {
				homeChannelId: "home-channel",
				mainThreadId: "old-codex-thread",
				createdAt: "2026-05-13T00:00:00.000Z",
				delegations: [],
			},
			sessions: [
				{
					discordThreadId: "home-channel",
					parentChannelId: "home-channel",
					codexThreadId: "old-codex-thread",
					title: "Codex Gateway",
					createdAt: "2026-05-13T00:00:00.000Z",
					cwd: "/workspace",
					mode: "gateway",
				},
			],
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig({
				gateway: { homeChannelId: "home-channel" },
			}),
		});

		await bridge.start();
		await waitFor(() => bridge.stateForTest().gateway?.mainThreadId === "codex-thread-1");

		expect(client.resumeThreadCalls).toEqual([]);
		expect(client.startThreadCalls).toHaveLength(1);
		expect(client.startThreadCalls[0]?.dynamicTools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ namespace: "codex_gateway" }),
			]),
		);
		expect(bridge.stateForTest().sessions.filter((session) =>
			session.mode === "gateway"
		)).toEqual([
			expect.objectContaining({
				codexThreadId: "codex-thread-1",
			}),
		]);
		expect(bridge.stateForTest().gateway).toEqual(
			expect.objectContaining({
				mainThreadId: "codex-thread-1",
				toolsVersion: 1,
			}),
		);
		await bridge.stop();
	});

	test("routes bot mentions in the home channel to the gateway instead of creating threads", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				gateway: { homeChannelId: "home-channel" },
			}),
		});

		await bridge.start();
		await waitFor(() => bridge.stateForTest().sessions.length === 1);
		transport.emit({
			kind: "threadStart",
			channelId: "home-channel",
			sourceMessageId: "mention-message-1",
			author: { id: "user-1", name: "Peezy", isBot: false },
			prompt: "<@bot-id> in load-game check active work",
			mentionedUserIds: ["bot-id"],
			createdAt: "2026-05-14T00:00:00.000Z",
		});

		await waitFor(() => client.startTurnCalls.length === 1);
		expect(transport.createdThreads).toEqual([]);
		expect(inputText(client.startTurnCalls[0]?.input[0])).toContain(
			"in load-game check active work",
		);
		await bridge.stop();
	});

	test("starts a Discord thread from a mention and sends summaries only after chunks complete", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "threadStart",
			sourceMessageId: "message-mention-1",
			channelId: "parent-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			title: "Investigate release",
			prompt: "What changed in this release?",
			createdAt: "2026-05-11T00:00:00.000Z",
		});

		await waitFor(() => client.startTurnCalls.length === 1);
		expect(transport.createdThreads).toEqual([
			{
				channelId: "parent-channel",
				name: "Investigate release",
				sourceMessageId: "message-mention-1",
			},
		]);
		expect(client.startThreadCalls).toHaveLength(1);
		expect(client.setThreadNameCalls[0]).toEqual({
			threadId: "codex-thread-1",
			name: "[discord] Investigate release",
		});
		expect(client.startTurnCalls[0]?.input[0]).toEqual(
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("What changed in this release?"),
			}),
		);

		const messageCountAfterStart = transport.messages.length;
		client.emitNotification({
			method: "item/reasoning/summaryPartAdded",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				itemId: "reasoning-1",
				summaryIndex: 0,
			},
		});
		client.emitNotification({
			method: "item/reasoning/summaryTextDelta",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				itemId: "reasoning-1",
				summaryIndex: 0,
				delta: "Checking changed files.",
			},
		});
		client.emitNotification({
			method: "item/reasoning/summaryTextDelta",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				itemId: "reasoning-1",
				summaryIndex: 0,
				delta: " Reading test coverage.",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(transport.messages).toHaveLength(messageCountAfterStart);
		expect(
			transport.updatedMessages.some((message) =>
				message.text.includes("Checking changed files")
			),
		).toBe(false);
		expect(
			transport.messages.filter((message) =>
				message.text.includes("Checking changed files")
			),
		).toHaveLength(0);
		client.emitNotification({
			method: "item/reasoning/summaryPartAdded",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				itemId: "reasoning-1",
				summaryIndex: 1,
			},
		});
		await waitFor(() =>
			transport.messages.some((message) =>
				message.text === "Checking changed files. Reading test coverage."
			)
		);
		client.emitNotification({
			method: "item/reasoning/summaryTextDelta",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				itemId: "reasoning-1",
				summaryIndex: 1,
				delta: "Inspecting implementation boundaries.",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(
			transport.messages.some((message) =>
				message.text === "Inspecting implementation boundaries."
			),
		).toBe(false);
		client.emitNotification({
			method: "item/completed",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				item: {
					id: "reasoning-1",
					type: "reasoning",
					summary: [
						"Checking changed files. Reading test coverage.",
						"Inspecting implementation boundaries.",
					],
				},
			},
		});
		await waitFor(() =>
			transport.messages.some((message) =>
				message.text === "Inspecting implementation boundaries."
			)
		);
		expect(
			transport.updatedMessages.some((message) =>
				message.text === "Inspecting implementation boundaries."
			),
		).toBe(false);
		await waitFor(() => transport.typingCount >= 2);
		client.emitNotification({
			method: "item/agentMessage/delta",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				itemId: "message-1",
				delta: "The release changed the Discord bridge.",
			},
		});
		client.emitNotification({
			method: "item/completed",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				item: {
					id: "message-1",
					type: "agentMessage",
					text: "The release changed the Discord bridge.",
					phase: "final_answer",
					memoryCitation: null,
				},
			},
		});
		client.emitNotification({
			method: "turn/completed",
			params: {
				threadId: "codex-thread-1",
				turn: { id: "turn-1" },
			},
		});

		await waitFor(() =>
			transport.messages.some((message) =>
				message.text === "The release changed the Discord bridge."
			)
		);
		expect(bridge.stateForTest().processedMessageIds).toContain(
			"message-mention-1",
		);
		expect(bridge.stateForTest().deliveries.map((delivery) => delivery.kind)).toEqual([
			"summary",
			"summary",
			"final",
		]);
		await waitFor(() => transport.deletedMessages.length === 2);
		expect(transport.deletedMessages.map((message) => message.text)).toEqual([
			"Checking changed files. Reading test coverage.",
			"Inspecting implementation boundaries.",
		]);
		expect(
			transport.messages
				.map((message) => message.text)
				.filter((text) =>
					[
						"Checking changed files. Reading test coverage.",
						"Inspecting implementation boundaries.",
						"The release changed the Discord bridge.",
					].includes(text)
				),
		).toEqual([
			"The release changed the Discord bridge.",
		]);
		const typingCountAfterFinal = transport.typingCount;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(transport.typingCount).toBe(typingCountAfterFinal);
		await bridge.stop();
	});

	test("starts a thread from a bot DM by a global user outside allowed guild channels", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({ allowedChannelIds: new Set(["guild-parent-channel"]) }),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "threadStart",
			sourceMessageId: "message-dm-1",
			channelId: "bot-dm-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			title: "DM request",
			prompt: "Handle this from DM.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});

		await waitFor(() => client.startTurnCalls.length === 1);
		expect(transport.createdThreads).toEqual([
			{
				channelId: "bot-dm-channel",
				name: "DM request",
				sourceMessageId: "message-dm-1",
			},
		]);
		expect(bridge.stateForTest().sessions[0]).toEqual(
			expect.objectContaining({
				discordThreadId: "discord-thread-1",
				parentChannelId: "bot-dm-channel",
				guildId: undefined,
			}),
		);
		await bridge.stop();
	});

	test("can use commentary messages as progress and keep final output phase-aware", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const consoleOutput = new FakeConsoleOutput();
		const store = new MemoryStateStore();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig({ progressMode: "commentary" }),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
			consoleOutput,
		});

		await bridge.start();
		transport.emit({
			kind: "threadStart",
			sourceMessageId: "message-mention-2",
			channelId: "parent-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			title: "Scan repo",
			prompt: "Scan this repo.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});

		await waitFor(() => client.startTurnCalls.length === 1);
		const messageCountAfterStart = transport.messages.length;
		client.emitNotification({
			method: "item/reasoning/summaryPartAdded",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				itemId: "reasoning-1",
				summaryIndex: 0,
			},
		});
		client.emitNotification({
			method: "item/reasoning/summaryTextDelta",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				itemId: "reasoning-1",
				summaryIndex: 0,
				delta: "Reasoning summary should not post.",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(transport.messages).toHaveLength(messageCountAfterStart);

		client.emitNotification({
			method: "item/agentMessage/delta",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				itemId: "commentary-1",
				delta: "I will scan the repo.",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(
			transport.messages.some((message) =>
				message.text === "I will scan the repo."
			),
		).toBe(false);
		client.emitNotification({
			method: "item/completed",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				item: {
					id: "commentary-1",
					type: "agentMessage",
					text: "I will scan the repo.",
					phase: "commentary",
					memoryCitation: null,
				},
			},
		});
		await waitFor(() =>
			transport.messages.some((message) =>
				message.text === "I will scan the repo."
			)
		);
		expect(consoleOutput.messages).toEqual([
			expect.objectContaining({
				kind: "commentary",
				text: "I will scan the repo.",
				discordThreadId: "discord-thread-1",
				codexThreadId: "codex-thread-1",
				turnId: "turn-1",
				title: "Scan repo",
			}),
		]);

		client.emitNotification({
			method: "item/agentMessage/delta",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				itemId: "final-1",
				delta: "Repo scan complete.",
			},
		});
		client.emitNotification({
			method: "item/completed",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				item: {
					id: "final-1",
					type: "agentMessage",
					text: "Repo scan complete.",
					phase: "final_answer",
					memoryCitation: null,
				},
			},
		});
		client.emitNotification({
			method: "turn/completed",
			params: {
				threadId: "codex-thread-1",
				turn: {
					id: "turn-1",
					items: [
						{
							id: "commentary-1",
							type: "agentMessage",
							text: "I will scan the repo.",
							phase: "commentary",
							memoryCitation: null,
						},
						{
							id: "final-1",
							type: "agentMessage",
							text: "Repo scan complete.",
							phase: "final_answer",
							memoryCitation: null,
						},
					],
				},
			},
		});

		await waitFor(() =>
			transport.messages.some((message) => message.text === "Repo scan complete.")
		);
		expect(consoleOutput.messages).toEqual([
			expect.objectContaining({
				kind: "commentary",
				text: "I will scan the repo.",
			}),
			expect.objectContaining({
				kind: "final",
				text: "Repo scan complete.",
				turnId: "turn-1",
				title: "Scan repo",
			}),
		]);
		await waitFor(() => transport.deletedMessages.length === 1);
		expect(transport.deletedMessages[0]?.text).toBe("I will scan the repo.");
		expect(bridge.stateForTest().deliveries.map((delivery) => delivery.kind)).toEqual([
			"commentary",
			"final",
		]);
		expect(
			transport.messages.some((message) =>
				message.text.includes("Reasoning summary should not post")
			),
		).toBe(false);
		expect(
			transport.messages.some((message) =>
				message.text === "I will scan the repo."
			),
		).toBe(false);
		expect(
			transport.messages.filter((message) =>
				message.text === "Repo scan complete."
			),
		).toHaveLength(1);
		await bridge.stop();
	});

	test("grants mentioned users access only to the created Discord thread", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig({ allowedUserIds: new Set(["user-1", "user-admin"]) }),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "threadStart",
			sourceMessageId: "message-grant-start",
			channelId: "parent-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			prompt: "<@user-2> <@!user-3> Please investigate this repo.",
			mentionedUserIds: ["user-2", "user-3", "user-1", "user-2"],
			createdAt: "2026-05-11T00:00:00.000Z",
		});

		await waitFor(() => client.startTurnCalls.length === 1);
		expect(transport.createdThreads).toEqual([
			{
				channelId: "parent-channel",
				name: "Please investigate this repo.",
				sourceMessageId: "message-grant-start",
			},
		]);
		expect(transport.addedThreadMembers).toEqual([
			{ channelId: "discord-thread-1", userIds: ["user-2", "user-3"] },
		]);
		const initialPrompt = inputText(client.startTurnCalls[0]?.input[0]);
		expect(initialPrompt).toContain("Please investigate this repo.");
		expect(initialPrompt).not.toContain("<@user-2>");
		expect(initialPrompt).not.toContain("<@!user-3>");
		expect(bridge.stateForTest().sessions[0]).toEqual(
			expect.objectContaining({
				ownerUserId: "user-1",
				participantUserIds: ["user-2", "user-3"],
			}),
		);

		transport.emit({
			kind: "message",
			channelId: "discord-thread-1",
			messageId: "message-from-grantee",
			author: { id: "user-2", name: "Grace", isBot: false },
			content: "Here is more context.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});
		await waitFor(() => client.steerTurnCalls.length === 1);
		expect(client.steerTurnCalls[0]?.input[0]).toEqual(
			expect.objectContaining({
				text: expect.stringContaining("Here is more context."),
			}),
		);

		transport.emit({
			kind: "message",
			channelId: "discord-thread-1",
			messageId: "message-from-rando",
			author: { id: "user-4", name: "Edsger", isBot: false },
			content: "I should not reach Codex.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(client.steerTurnCalls).toHaveLength(1);

		transport.emit({
			kind: "message",
			channelId: "discord-thread-1",
			messageId: "message-from-admin",
			author: { id: "user-admin", name: "Admin", isBot: false },
			content: "Admin context should reach Codex.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});
		await waitFor(() => client.steerTurnCalls.length === 2);
		expect(client.steerTurnCalls[1]?.input[0]).toEqual(
			expect.objectContaining({
				text: expect.stringContaining("Admin context should reach Codex."),
			}),
		);

		transport.emit({
			kind: "threadStart",
			sourceMessageId: "message-grantee-start-denied",
			channelId: "parent-channel",
			author: { id: "user-2", name: "Grace", isBot: false },
			prompt: "Start a second thread.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(transport.createdThreads).toHaveLength(1);
		expect(client.startThreadCalls).toHaveLength(1);
		await bridge.stop();
	});

	test("stores per-thread directories and pins a status message for new threads", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig({
				allowedUserIds: new Set(["user-1", "user-admin"]),
				approvalPolicy: "on-request",
				sandbox: "workspace-write",
			}),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "threadStart",
			sourceMessageId: "message-dir-start",
			channelId: "parent-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			prompt: "--dir ~/game-protocol-workspace Build the parser.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});

		await waitFor(() => client.startTurnCalls.length === 1);
		const expectedCwd = path.join(os.homedir(), "game-protocol-workspace");
		expect(client.startThreadCalls[0]?.cwd).toBe(expectedCwd);
		expect(client.startTurnCalls[0]?.cwd).toBe(expectedCwd);
		expect(inputText(client.startTurnCalls[0]?.input[0])).toContain(
			"Build the parser.",
		);
		expect(inputText(client.startTurnCalls[0]?.input[0])).not.toContain("--dir");
		expect(bridge.stateForTest().sessions[0]).toEqual(
			expect.objectContaining({
				cwd: expectedCwd,
				mode: "new",
				statusMessageId: "message-out-1",
			}),
		);
		expect(transport.pinnedMessages).toEqual([
			{ channelId: "discord-thread-1", messageId: "message-out-1" },
		]);
		const statusText = transport.messages.find((message) =>
			message.id === "message-out-1"
		)?.text ?? "";
		expect(statusText).toContain("**Codex Discord Bridge**");
		expect(statusText).toContain(`Dir: \`${expectedCwd}\``);
		expect(statusText).toContain("Global admins: <@user-1>, <@user-admin>");
		expect(statusText).toContain("Permissions: approval `on-request`");

		client.emitNotification({
			method: "item/completed",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				item: {
					id: "message-final",
					type: "agentMessage",
					text: "First turn done.",
					phase: "final_answer",
					memoryCitation: null,
				},
			},
		});
		client.emitNotification({
			method: "turn/completed",
			params: {
				threadId: "codex-thread-1",
				turn: { id: "turn-1" },
			},
		});
		await waitFor(() => bridge.stateForTest().queue.length === 0);
		transport.emit({
			kind: "message",
			channelId: "discord-thread-1",
			messageId: "message-follow-up",
			author: { id: "user-1", name: "Ada", isBot: false },
			content: "Continue in the same directory.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});
		await waitFor(() => client.startTurnCalls.length === 2);
		expect(client.startTurnCalls[1]?.cwd).toBe(expectedCwd);
		await bridge.stop();
	});

	test("resumes arbitrary Codex threads without prompting and replays the last final message", async () => {
		const client = new FakeCodexClient();
		const resumedThreadId = "019e1951-5355-78d2-8162-3b2b11dfc4a5";
		client.threadTurns.set(resumedThreadId, [
			{
				id: "turn-old-1",
				status: "completed",
				items: [
					{
						type: "agentMessage",
						id: "old-final",
						text: "Earlier answer.",
						phase: "final_answer",
						memoryCitation: null,
					},
				],
			} as unknown as v2.Turn,
			{
				id: "turn-old-2",
				status: "completed",
				items: [
					{
						type: "agentMessage",
						id: "latest-commentary",
						text: "This is commentary.",
						phase: "commentary",
						memoryCitation: null,
					},
					{
						type: "agentMessage",
						id: "latest-final",
						text: "Latest final answer.",
						phase: "final_answer",
						memoryCitation: null,
					},
				],
			} as unknown as v2.Turn,
		]);
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "threadStart",
			sourceMessageId: "message-resume-start",
			channelId: "parent-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			prompt: `resume ${resumedThreadId} --dir ~/game-protocol-workspace`,
			createdAt: "2026-05-11T00:00:00.000Z",
		});

		await waitFor(() =>
			transport.messages.some((message) => message.text === "Latest final answer.")
		);
		const expectedCwd = path.join(os.homedir(), "game-protocol-workspace");
		expect(client.resumeThreadCalls).toHaveLength(1);
		expect(client.resumeThreadCalls[0]).toEqual(
			expect.objectContaining({
				threadId: resumedThreadId,
				cwd: expectedCwd,
			}),
		);
		expect(client.startThreadCalls).toHaveLength(0);
		expect(client.startTurnCalls).toHaveLength(0);
		expect(client.setThreadNameCalls).toHaveLength(0);
		expect(bridge.stateForTest().sessions[0]).toEqual(
			expect.objectContaining({
				codexThreadId: resumedThreadId,
				cwd: expectedCwd,
				mode: "resumed",
				statusMessageId: "message-out-1",
			}),
		);
		expect(transport.pinnedMessages).toEqual([
			{ channelId: "discord-thread-1", messageId: "message-out-1" },
		]);
		expect(transport.messages[0]?.text).toContain("Mode: `resumed`");
		expect(transport.messages[0]?.text).toContain(`Dir: \`${expectedCwd}\``);
		expect(transport.messages.map((message) => message.text)).toContain(
			"Latest final answer.",
		);
		await bridge.stop();
	});

	test("ignores historical progress notifications after resume replay", async () => {
		const client = new FakeCodexClient();
		const resumedThreadId = "019e1951-5355-78d2-8162-3b2b11dfc4a5";
		const completedTurn = {
			id: "turn-history-1",
			status: "completed",
			items: [
				{
					id: "latest-final",
					type: "agentMessage",
					text: "Latest final answer.",
					phase: "final_answer",
					memoryCitation: null,
				},
			],
		} as unknown as v2.Turn;
		client.threadTurns.set(resumedThreadId, [completedTurn]);
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig({ progressMode: "commentary" }),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "threadStart",
			sourceMessageId: "message-resume-history",
			channelId: "parent-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			prompt: `resume ${resumedThreadId}`,
			createdAt: "2026-05-11T00:00:00.000Z",
		});

		await waitFor(() =>
			bridge.stateForTest().processedMessageIds.includes("message-resume-history")
		);
		const messagesAfterResume = transport.messages.map((message) => message.text);
		expect(
			messagesAfterResume.filter((message) => message === "Latest final answer."),
		).toHaveLength(1);

		client.emitNotification({
			method: "item/completed",
			params: {
				threadId: resumedThreadId,
				turnId: "turn-history-1",
				itemId: "historical-commentary",
				item: {
					id: "historical-commentary",
					type: "agentMessage",
					text: "Historical commentary.",
					phase: "commentary",
					memoryCitation: null,
				},
			},
		} as JsonRpcNotification);
		client.emitNotification({
			method: "turn/completed",
			params: {
				threadId: resumedThreadId,
				turnId: "turn-history-1",
				turn: completedTurn,
			},
		} as JsonRpcNotification);
		await sleep(50);

		expect(transport.messages.map((message) => message.text)).toEqual(
			messagesAfterResume,
		);
		expect(transport.deletedMessages).toEqual([]);
		expect(bridge.stateForTest().activeTurns).toEqual([]);
		await bridge.stop();
	});

	test("cleans stale historical progress after resume restart", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		transport.messages.push(
			{
				channelId: "discord-thread-1",
				id: "message-stale-commentary-1",
				text: "Stale commentary 1.",
			},
			{
				channelId: "discord-thread-1",
				id: "message-stale-commentary-2",
				text: "Stale commentary 2.",
			},
		);
		const store = new MemoryStateStore({
			...emptyState(),
			sessions: [
				{
					discordThreadId: "discord-thread-1",
					parentChannelId: "parent-channel",
					sourceMessageId: "message-resume-start",
					codexThreadId: "codex-thread-resumed",
					title: "Resumed thread",
					createdAt: "2026-05-11T00:00:00.000Z",
					mode: "resumed",
					statusMessageId: "message-status-1",
				},
			],
			activeTurns: [
				{
					turnId: "turn-history-1",
					discordThreadId: "discord-thread-1",
					codexThreadId: "codex-thread-resumed",
					origin: "external",
					observedAt: "2026-05-11T00:00:00.000Z",
				},
			],
			deliveries: [
				{
					discordMessageId: "resume:message-resume-start:turn-history-1",
					discordThreadId: "discord-thread-1",
					codexThreadId: "codex-thread-resumed",
					turnId: "turn-history-1",
					kind: "final",
					outboundMessageIds: ["message-final-1"],
					deliveredAt: "2026-05-11T00:00:00.000Z",
				},
				{
					discordMessageId: "external:turn-history-1",
					discordThreadId: "discord-thread-1",
					codexThreadId: "codex-thread-resumed",
					turnId: "turn-history-1",
					kind: "commentary",
					outboundMessageIds: [
						"message-stale-commentary-1",
						"message-stale-commentary-2",
					],
					deliveredAt: "2026-05-11T00:00:00.000Z",
				},
			],
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		await waitFor(() => transport.deletedMessages.length === 2);

		expect(transport.deletedMessages.map((message) => message.messageId)).toEqual([
			"message-stale-commentary-1",
			"message-stale-commentary-2",
		]);
		expect(bridge.stateForTest().activeTurns).toEqual([]);
		expect(
			bridge.stateForTest().deliveries.find(
				(delivery) => delivery.kind === "commentary",
			)?.outboundMessageIds,
		).toEqual([]);
		await bridge.stop();
	});

	test("resume without dir uses the resumed Codex thread cwd", async () => {
		const client = new FakeCodexClient();
		const resumedThreadId = "019e1951-5355-78d2-8162-3b2b11dfc4a5";
		const threadCwd = "/home/peezy/original-thread-workspace";
		client.threadCwds.set(resumedThreadId, threadCwd);
		client.threadTurns.set(resumedThreadId, [
			{
				id: "turn-old-1",
				status: "completed",
				items: [
					{
						type: "agentMessage",
						id: "latest-final",
						text: "Original cwd answer.",
						phase: "final_answer",
						memoryCitation: null,
					},
				],
			} as unknown as v2.Turn,
		]);
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig({ cwd: "/home/peezy/game-protocol-workspace" }),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "threadStart",
			sourceMessageId: "message-resume-no-dir",
			channelId: "parent-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			prompt: `resume ${resumedThreadId}`,
			createdAt: "2026-05-11T00:00:00.000Z",
		});

		await waitFor(() =>
			transport.messages.some((message) => message.text === "Original cwd answer.")
		);
		expect(client.resumeThreadCalls[0]).toEqual(
			expect.objectContaining({
				threadId: resumedThreadId,
				cwd: null,
			}),
		);
		expect(bridge.stateForTest().sessions[0]).toEqual(
			expect.objectContaining({
				codexThreadId: resumedThreadId,
				cwd: threadCwd,
				mode: "resumed",
			}),
		);
		expect(transport.messages[0]?.text).toContain(`Dir: \`${threadCwd}\``);
		await bridge.stop();
	});

	test("updates pinned status with goal, plan, and running command metadata", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore();
		let now = new Date("2026-05-11T00:00:00.000Z");
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig(),
			now: () => now,
		});

		await bridge.start();
		transport.emit({
			kind: "threadStart",
			sourceMessageId: "message-status-start",
			channelId: "parent-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			prompt: "Inspect status updates.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});

		await waitFor(() => client.startTurnCalls.length === 1);
		client.emitNotification({
			method: "thread/goal/updated",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				goal: {
					threadId: "codex-thread-1",
					objective: "Ship the Discord bridge status surface",
					status: "active",
					tokenBudget: null,
					tokensUsed: 10,
					timeUsedSeconds: 2,
					createdAt: 0,
					updatedAt: 0,
				},
			},
		});
		client.emitNotification({
			method: "turn/plan/updated",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				explanation: null,
				plan: [
					{ step: "Inspect current bridge", status: "completed" },
					{ step: "Implement pinned status", status: "inProgress" },
				],
			},
		});
		client.emitNotification({
			method: "item/started",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				item: {
					type: "commandExecution",
					id: "command-1",
					command: "bun test test/*.test.ts",
					cwd: "/workspace",
					processId: "process-1",
					source: "agent",
					status: "inProgress",
					commandActions: [],
					aggregatedOutput: null,
					exitCode: null,
					durationMs: null,
				},
			},
		});

		await waitFor(() => {
			const text = statusMessageText(transport);
			return text.includes("Ship the Discord bridge status surface") &&
				text.includes("Implement pinned status");
		});
		let statusText = statusMessageText(transport);
		expect(statusText).toContain("Goal: `active` Ship the Discord bridge status surface");
		expect(statusText).toContain("- `completed` Inspect current bridge");
		expect(statusText).toContain("- `inProgress` Implement pinned status");
		expect(statusText).toContain("**Running Commands**\nnone");
		expect(statusText).not.toContain("bun test test/*.test.ts");

		now = new Date("2026-05-11T00:00:05.000Z");
		client.emitNotification({
			method: "item/commandExecution/outputDelta",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				itemId: "command-1",
				delta: "test output",
			},
		});
		await waitFor(() =>
			statusMessageText(transport).includes("bun test test/*.test.ts")
		);
		statusText = statusMessageText(transport);
		expect(statusText).toContain("- `bun test test/*.test.ts`");

		client.emitNotification({
			method: "item/completed",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				item: {
					type: "commandExecution",
					id: "command-1",
					command: "bun test test/*.test.ts",
					cwd: "/workspace",
					processId: "process-1",
					source: "agent",
					status: "completed",
					commandActions: [],
					aggregatedOutput: "",
					exitCode: 0,
					durationMs: 10,
				},
			},
		});
		await waitFor(() => !statusMessageText(transport).includes("bun test"));
		statusText = statusMessageText(transport);
		expect(statusText).toContain("**Running Commands**\nnone");

		const messageCountBeforeActivity = transport.messages.length;
		client.emitNotification({
			method: "item/started",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				item: {
					type: "fileChange",
					id: "patch-1",
					changes: [
						{ type: "add", path: "/workspace/src/worker.ts", content: "test" },
						{ type: "update", path: "/workspace/package.json", content: "test" },
					],
					status: "inProgress",
				},
			},
		});
		await waitFor(() =>
			statusMessageText(transport).includes("files: 2 file changes")
		);
		statusText = statusMessageText(transport);
		expect(statusText).toContain("**Activity**");
		expect(statusText).toContain("- `inProgress` files: 2 file changes");
		expect(transport.messages).toHaveLength(messageCountBeforeActivity);

		client.emitNotification({
			method: "item/completed",
			params: {
				threadId: "codex-thread-1",
				turnId: "turn-1",
				item: {
					type: "mcpToolCall",
					id: "mcp-1",
					server: "github",
					tool: "search",
					status: "completed",
					arguments: {},
					result: null,
					error: null,
					durationMs: 42,
				},
			},
		});
		await waitFor(() =>
			statusMessageText(transport).includes("mcp: github.search")
		);
		statusText = statusMessageText(transport);
		expect(statusText).toContain("- `completed` mcp: github.search");
		expect(transport.messages).toHaveLength(messageCountBeforeActivity);
		await bridge.stop();
	});

	test("mirrors external turns on managed threads into Discord", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "threadStart",
			sourceMessageId: "message-watch-start",
			channelId: "parent-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			title: "Watch external work",
			prompt: "",
			createdAt: "2026-05-11T00:00:00.000Z",
		});
		await waitFor(() => bridge.stateForTest().sessions.length === 1);
		expect(client.startTurnCalls).toHaveLength(0);

		client.emitNotification({
			method: "turn/started",
			params: {
				threadId: "codex-thread-1",
				turn: {
					id: "external-turn-1",
					status: "inProgress",
					items: [],
					startedAt: 1778457600,
				},
			},
		});
		await waitFor(() =>
			statusMessageText(transport).includes("origin `external`")
		);
		expect(bridge.stateForTest().activeTurns[0]).toEqual(
			expect.objectContaining({
				turnId: "external-turn-1",
				origin: "external",
			}),
		);
		expect(transport.typingCount).toBeGreaterThan(0);

		client.emitNotification({
			method: "item/reasoning/summaryPartAdded",
			params: {
				threadId: "codex-thread-1",
				turnId: "external-turn-1",
				itemId: "reasoning-1",
				summaryIndex: 0,
			},
		});
		client.emitNotification({
			method: "item/reasoning/summaryTextDelta",
			params: {
				threadId: "codex-thread-1",
				turnId: "external-turn-1",
				itemId: "reasoning-1",
				summaryIndex: 0,
				delta: "External source is working.",
			},
		});
		client.emitNotification({
			method: "item/reasoning/summaryPartAdded",
			params: {
				threadId: "codex-thread-1",
				turnId: "external-turn-1",
				itemId: "reasoning-1",
				summaryIndex: 1,
			},
		});
		await waitFor(() =>
			transport.messages.some((message) =>
				message.text === "External source is working."
			)
		);

		client.emitNotification({
			method: "item/completed",
			params: {
				threadId: "codex-thread-1",
				turnId: "external-turn-1",
				item: {
					id: "message-final",
					type: "agentMessage",
					text: "External final answer.",
					phase: "final_answer",
					memoryCitation: null,
				},
			},
		});
		client.emitNotification({
			method: "turn/completed",
			params: {
				threadId: "codex-thread-1",
				turn: {
					id: "external-turn-1",
					status: "completed",
					items: [],
				},
			},
		});

		await waitFor(() =>
			transport.messages.some((message) => message.text === "External final answer.")
		);
		await waitFor(() => transport.deletedMessages.length === 1);
		expect(transport.deletedMessages[0]?.text).toBe("External source is working.");
		expect(bridge.stateForTest().activeTurns).toEqual([]);
		expect(bridge.stateForTest().deliveries.map((delivery) => delivery.kind)).toEqual([
			"summary",
			"final",
		]);
		await bridge.stop();
	});

	test("steers Discord messages into externally started active turns", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "threadStart",
			sourceMessageId: "message-cross-source-start",
			channelId: "parent-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			title: "Cross source steering",
			prompt: "",
			createdAt: "2026-05-11T00:00:00.000Z",
		});
		await waitFor(() => bridge.stateForTest().sessions.length === 1);
		client.emitNotification({
			method: "turn/started",
			params: {
				threadId: "codex-thread-1",
				turn: {
					id: "external-turn-1",
					status: "inProgress",
					items: [],
				},
			},
		});
		await waitFor(() => bridge.stateForTest().activeTurns.length === 1);

		transport.emit({
			kind: "message",
			channelId: "discord-thread-1",
			messageId: "message-steer-external",
			author: { id: "user-1", name: "Ada", isBot: false },
			content: "Please include the Discord context.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});
		await waitFor(() => client.steerTurnCalls.length === 1);
		expect(client.startTurnCalls).toHaveLength(0);
		expect(client.steerTurnCalls[0]).toEqual(
			expect.objectContaining({
				threadId: "codex-thread-1",
				expectedTurnId: "external-turn-1",
			}),
		);
		expect(inputText(client.steerTurnCalls[0]?.input[0])).toContain(
			"Please include the Discord context.",
		);
		expect(bridge.stateForTest().processedMessageIds).toContain(
			"message-steer-external",
		);

		client.emitNotification({
			method: "turn/completed",
			params: {
				threadId: "codex-thread-1",
				turn: {
					id: "external-turn-1",
					status: "completed",
					items: [
						{
							id: "message-final",
							type: "agentMessage",
							text: "External turn completed.",
							phase: "final_answer",
							memoryCitation: null,
						},
					],
				},
			},
		});
		await waitFor(() => bridge.stateForTest().activeTurns.length === 0);

		transport.emit({
			kind: "message",
			channelId: "discord-thread-1",
			messageId: "message-new-turn",
			author: { id: "user-1", name: "Ada", isBot: false },
			content: "Start a new Discord turn now.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});
		await waitFor(() => client.startTurnCalls.length === 1);
		expect(client.steerTurnCalls).toHaveLength(1);
		await bridge.stop();
	});

	test("recovers persisted external active turns and edits the status message", async () => {
		const client = new FakeCodexClient();
		client.threadTurns.set("codex-thread-existing", [
			{
				id: "external-turn-recovered",
				status: "inProgress",
				items: [],
			} as unknown as v2.Turn,
		]);
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore({
			...emptyState(),
			sessions: [
				{
					discordThreadId: "discord-thread-1",
					parentChannelId: "parent-channel",
					codexThreadId: "codex-thread-existing",
					title: "Existing thread",
					createdAt: "2026-05-11T00:00:00.000Z",
					statusMessageId: "message-status-1",
				},
			],
			activeTurns: [
				{
					turnId: "external-turn-recovered",
					discordThreadId: "discord-thread-1",
					codexThreadId: "codex-thread-existing",
					origin: "external",
					observedAt: "2026-05-11T00:00:00.000Z",
				},
			],
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig({ reconcileIntervalMs: 10 }),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		await waitFor(() =>
			transport.updatedMessages.some((message) =>
				message.messageId === "message-status-1" &&
				message.text.includes("origin `external`")
			)
		);
		expect(transport.pinnedMessages).toContainEqual({
			channelId: "discord-thread-1",
			messageId: "message-status-1",
		});
		expect(transport.typingCount).toBeGreaterThan(0);

		client.threadTurns.set("codex-thread-existing", [
			{
				id: "external-turn-recovered",
				status: "completed",
				items: [
					{
						id: "message-final",
						type: "agentMessage",
						text: "Recovered external final.",
						phase: "final_answer",
						memoryCitation: null,
					},
				],
			} as unknown as v2.Turn,
		]);

		await waitFor(() =>
			transport.messages.some((message) => message.text === "Recovered external final.")
		);
		expect(bridge.stateForTest().activeTurns).toEqual([]);
		await bridge.stop();
	});

	test("clear deletes inactive managed threads and preserves running threads", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const replies: string[] = [];
		const store = new MemoryStateStore({
			...emptyState(),
			sessions: [
				{
					discordThreadId: "discord-thread-idle",
					parentChannelId: "parent-channel",
					sourceMessageId: "message-idle-start",
					codexThreadId: "codex-thread-idle",
					title: "Idle",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
				{
					discordThreadId: "discord-thread-active",
					parentChannelId: "parent-channel",
					codexThreadId: "codex-thread-active",
					title: "Active",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
				{
					discordThreadId: "discord-thread-pending",
					parentChannelId: "parent-channel",
					codexThreadId: "codex-thread-pending",
					title: "Pending",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
				{
					discordThreadId: "discord-thread-failed",
					parentChannelId: "parent-channel",
					sourceMessageId: "message-failed-start",
					codexThreadId: "codex-thread-failed",
					title: "Failed",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
			],
			activeTurns: [
				{
					turnId: "turn-active",
					discordThreadId: "discord-thread-active",
					codexThreadId: "codex-thread-active",
					origin: "external",
					observedAt: "2026-05-11T00:00:00.000Z",
				},
			],
			queue: [
				{
					id: "queue-pending",
					status: "pending",
					discordMessageId: "message-pending",
					discordThreadId: "discord-thread-pending",
					codexThreadId: "codex-thread-pending",
					authorId: "user-1",
					authorName: "Ada",
					content: "Pending work.",
					createdAt: "2026-05-11T00:00:00.000Z",
					receivedAt: "2026-05-11T00:00:00.000Z",
					attempts: 0,
				},
				{
					id: "queue-failed",
					status: "failed",
					discordMessageId: "message-failed",
					discordThreadId: "discord-thread-failed",
					codexThreadId: "codex-thread-failed",
					authorId: "user-1",
					authorName: "Ada",
					content: "Failed work.",
					createdAt: "2026-05-11T00:00:00.000Z",
					receivedAt: "2026-05-11T00:00:00.000Z",
					attempts: 3,
				},
			],
			deliveries: [
				{
					discordMessageId: "message-idle",
					discordThreadId: "discord-thread-idle",
					codexThreadId: "codex-thread-idle",
					kind: "final",
					outboundMessageIds: ["message-out-idle"],
					deliveredAt: "2026-05-11T00:00:00.000Z",
				},
			],
		});
		transport.messages.push(
			{
				channelId: "parent-channel",
				id: "message-idle-start",
				text: "<@bot> scan idle",
			},
			{
				channelId: "parent-channel",
				id: "message-failed-start",
				text: "<@bot> scan failed",
			},
		);
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "clear",
			channelId: "parent-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			createdAt: "2026-05-11T00:00:00.000Z",
			reply: async (text) => {
				replies.push(text);
			},
		});
		await waitFor(() => replies.length === 1);

		expect(transport.deletedThreads).toEqual([
			"discord-thread-idle",
			"discord-thread-failed",
		]);
		expect(
			transport.deletedMessages.map(({ channelId, messageId }) => ({
				channelId,
				messageId,
			})),
		).toEqual([
			{ channelId: "parent-channel", messageId: "message-idle-start" },
			{ channelId: "parent-channel", messageId: "message-failed-start" },
		]);
		expect(replies[0]).toBe(
			"Deleted 2 inactive Discord threads. Left 2 running threads alone.",
		);
		expect(bridge.stateForTest().sessions.map((session) => session.discordThreadId))
			.toEqual(["discord-thread-active", "discord-thread-pending"]);
		expect(bridge.stateForTest().queue.map((item) => item.discordThreadId))
			.toEqual(["discord-thread-pending"]);
		expect(bridge.stateForTest().deliveries).toEqual([]);
		await bridge.stop();
	});

	test("clear only deletes inactive managed threads in the command guild", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const replies: string[] = [];
		const store = new MemoryStateStore({
			...emptyState(),
			sessions: [
				{
					discordThreadId: "discord-thread-guild-a-idle",
					parentChannelId: "parent-channel-a",
					guildId: "guild-a",
					codexThreadId: "codex-thread-guild-a-idle",
					title: "Guild A idle",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
				{
					discordThreadId: "discord-thread-guild-a-active",
					parentChannelId: "parent-channel-a",
					guildId: "guild-a",
					codexThreadId: "codex-thread-guild-a-active",
					title: "Guild A active",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
				{
					discordThreadId: "discord-thread-guild-b-idle",
					parentChannelId: "parent-channel-b",
					guildId: "guild-b",
					codexThreadId: "codex-thread-guild-b-idle",
					title: "Guild B idle",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
			],
			activeTurns: [
				{
					turnId: "turn-guild-a-active",
					discordThreadId: "discord-thread-guild-a-active",
					codexThreadId: "codex-thread-guild-a-active",
					origin: "external",
					observedAt: "2026-05-11T00:00:00.000Z",
				},
			],
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "clear",
			channelId: "parent-channel-a",
			guildId: "guild-a",
			author: { id: "user-1", name: "Ada", isBot: false },
			createdAt: "2026-05-11T00:00:00.000Z",
			reply: async (text) => {
				replies.push(text);
			},
		});
		await waitFor(() => replies.length === 1);

		expect(transport.deletedThreads).toEqual(["discord-thread-guild-a-idle"]);
		expect(replies[0]).toBe(
			"Deleted 1 inactive Discord thread. Left 1 running thread alone.",
		);
		expect(bridge.stateForTest().sessions.map((session) => session.discordThreadId))
			.toEqual(["discord-thread-guild-a-active", "discord-thread-guild-b-idle"]);
		await bridge.stop();
	});

	test("clear from a bot DM by a global user deletes inactive threads across guilds", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const replies: string[] = [];
		const store = new MemoryStateStore({
			...emptyState(),
			sessions: [
				{
					discordThreadId: "discord-thread-guild-a-idle",
					parentChannelId: "parent-channel-a",
					guildId: "guild-a",
					codexThreadId: "codex-thread-guild-a-idle",
					title: "Guild A idle",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
				{
					discordThreadId: "discord-thread-guild-b-idle",
					parentChannelId: "parent-channel-b",
					guildId: "guild-b",
					codexThreadId: "codex-thread-guild-b-idle",
					title: "Guild B idle",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
				{
					discordThreadId: "discord-thread-guild-b-active",
					parentChannelId: "parent-channel-b",
					guildId: "guild-b",
					codexThreadId: "codex-thread-guild-b-active",
					title: "Guild B active",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
			],
			activeTurns: [
				{
					turnId: "turn-guild-b-active",
					discordThreadId: "discord-thread-guild-b-active",
					codexThreadId: "codex-thread-guild-b-active",
					origin: "external",
					observedAt: "2026-05-11T00:00:00.000Z",
				},
			],
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "clear",
			channelId: "bot-dm-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			createdAt: "2026-05-11T00:00:00.000Z",
			reply: async (text) => {
				replies.push(text);
			},
		});
		await waitFor(() => replies.length === 1);

		expect(transport.deletedThreads).toEqual([
			"discord-thread-guild-a-idle",
			"discord-thread-guild-b-idle",
		]);
		expect(replies[0]).toBe(
			"Deleted 2 inactive Discord threads. Left 1 running thread alone.",
		);
		expect(bridge.stateForTest().sessions.map((session) => session.discordThreadId))
			.toEqual(["discord-thread-guild-b-active"]);
		await bridge.stop();
	});

	test("clear is restricted to global allowed users", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const replies: string[] = [];
		const store = new MemoryStateStore({
			...emptyState(),
			sessions: [
				{
					discordThreadId: "discord-thread-idle",
					parentChannelId: "parent-channel",
					codexThreadId: "codex-thread-idle",
					title: "Idle",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
			],
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "clear",
			channelId: "parent-channel",
			author: { id: "user-2", name: "Grace", isBot: false },
			createdAt: "2026-05-11T00:00:00.000Z",
			reply: async (text) => {
				replies.push(text);
			},
		});
		await waitFor(() => replies.length === 1);

		expect(transport.deletedThreads).toEqual([]);
		expect(replies[0]).toBe(
			"Only globally allowed Discord users can clear bridge threads.",
		);
		expect(bridge.stateForTest().sessions).toHaveLength(1);
		await bridge.stop();
	});

	test("clear webhooks deletes webhook messages in the command channel", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const replies: string[] = [];
		transport.messages.push(
			{
				channelId: "parent-channel",
				id: "message-webhook-1",
				text: "bridged output",
				webhookId: "webhook-1",
			},
			{
				channelId: "parent-channel",
				id: "message-user-1",
				text: "human message",
			},
			{
				channelId: "other-channel",
				id: "message-webhook-2",
				text: "other output",
				webhookId: "webhook-1",
			},
		);
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(emptyState()),
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "clearWebhooks",
			channelId: "parent-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			createdAt: "2026-05-11T00:00:00.000Z",
			reply: async (text) => {
				replies.push(text);
			},
		});
		await waitFor(() => replies.length === 1);

		expect(transport.deletedMessages.map(({ channelId, messageId }) => ({
			channelId,
			messageId,
		}))).toEqual([{ channelId: "parent-channel", messageId: "message-webhook-1" }]);
		expect(transport.messages.map((message) => message.id)).toEqual([
			"message-user-1",
			"message-webhook-2",
		]);
		expect(replies[0]).toBe("Deleted 1 webhook message.");
		await bridge.stop();
	});

	test("clear webhooks can filter by webhook url", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const replies: string[] = [];
		transport.messages.push(
			{
				channelId: "parent-channel",
				id: "message-webhook-1",
				text: "first output",
				webhookId: "1234567890",
			},
			{
				channelId: "parent-channel",
				id: "message-webhook-2",
				text: "second output",
				webhookId: "9876543210",
			},
		);
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(emptyState()),
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "clearWebhooks",
			channelId: "parent-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			webhookUrl: "https://discord.com/api/webhooks/9876543210/token",
			createdAt: "2026-05-11T00:00:00.000Z",
			reply: async (text) => {
				replies.push(text);
			},
		});
		await waitFor(() => replies.length === 1);

		expect(transport.deletedMessages.map(({ messageId }) => messageId)).toEqual([
			"message-webhook-2",
		]);
		expect(transport.messages.map((message) => message.id)).toEqual([
			"message-webhook-1",
		]);
		expect(replies[0]).toBe("Deleted 1 webhook message.");
		await bridge.stop();
	});

	test("clear webhooks is restricted to global allowed users", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const replies: string[] = [];
		transport.messages.push({
			channelId: "parent-channel",
			id: "message-webhook-1",
			text: "bridged output",
			webhookId: "webhook-1",
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(emptyState()),
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "clearWebhooks",
			channelId: "parent-channel",
			author: { id: "user-2", name: "Grace", isBot: false },
			createdAt: "2026-05-11T00:00:00.000Z",
			reply: async (text) => {
				replies.push(text);
			},
		});
		await waitFor(() => replies.length === 1);

		expect(transport.deletedMessages).toEqual([]);
		expect(replies[0]).toBe(
			"Only globally allowed Discord users can clear webhook messages.",
		);
		await bridge.stop();
	});

	test("continues existing managed Discord threads and dedupes messages", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore({
			...emptyState(),
			sessions: [
				{
					discordThreadId: "discord-thread-1",
					parentChannelId: "parent-channel",
					codexThreadId: "codex-thread-existing",
					title: "Existing thread",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
			],
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "message",
			channelId: "discord-thread-1",
			messageId: "message-1",
			author: { id: "user-1", name: "Ada", isBot: false },
			content: "Continue here.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});

		await waitFor(() => client.startTurnCalls.length === 1);
		expect(client.startThreadCalls).toHaveLength(0);
		expect(client.startTurnCalls[0]?.threadId).toBe("codex-thread-existing");
		expect(client.startTurnCalls[0]?.input[0]).toEqual(
			expect.objectContaining({
				text: expect.stringContaining("Message: message-1"),
			}),
		);

		transport.emit({
			kind: "message",
			channelId: "discord-thread-1",
			messageId: "message-1",
			author: { id: "user-1", name: "Ada", isBot: false },
			content: "Continue here.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(client.startTurnCalls).toHaveLength(1);
		await bridge.stop();
	});

	test("dedupes replayed mention starts before creating another thread", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});
		const mentionStart: DiscordInbound = {
			kind: "threadStart",
			sourceMessageId: "mention-replay-1",
			channelId: "parent-channel",
			author: { id: "user-1", name: "Ada", isBot: false },
			prompt: "Please inspect this once.",
			createdAt: "2026-05-11T00:00:00.000Z",
		};

		await bridge.start();
		transport.emit(mentionStart);
		transport.emit(mentionStart);

		await waitFor(() => client.startTurnCalls.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(transport.createdThreads).toHaveLength(1);
		expect(client.startThreadCalls).toHaveLength(1);
		expect(client.startTurnCalls).toHaveLength(1);
		await bridge.stop();
	});

	test("steers an active turn in one Discord thread without blocking another thread", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore({
			...emptyState(),
			sessions: [
				{
					discordThreadId: "discord-thread-1",
					parentChannelId: "parent-channel",
					codexThreadId: "codex-thread-1",
					title: "Thread one",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
				{
					discordThreadId: "discord-thread-2",
					parentChannelId: "parent-channel",
					codexThreadId: "codex-thread-2",
					title: "Thread two",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
			],
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "message",
			channelId: "discord-thread-1",
			messageId: "message-a1",
			author: { id: "user-1", name: "Ada", isBot: false },
			content: "First same-thread message.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});
		await waitFor(() => client.startTurnCalls.length === 1);
		await waitFor(() =>
			bridge.stateForTest().queue.some((item) =>
				item.discordMessageId === "message-a1" &&
				item.status === "processing" &&
				item.turnId === "turn-1"
			)
		);

		transport.emit({
			kind: "message",
			channelId: "discord-thread-1",
			messageId: "message-a2",
			author: { id: "user-1", name: "Ada", isBot: false },
			content: "Second same-thread message.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(client.startTurnCalls).toHaveLength(1);
		expect(client.steerTurnCalls).toHaveLength(1);
		expect(client.steerTurnCalls[0]).toEqual(
			expect.objectContaining({
				threadId: "codex-thread-1",
				expectedTurnId: "turn-1",
			}),
		);
		expect(client.steerTurnCalls[0]?.input[0]).toEqual(
			expect.objectContaining({
				text: expect.stringContaining("Second same-thread message."),
			}),
		);
		expect(bridge.stateForTest().processedMessageIds).toContain("message-a2");

		transport.emit({
			kind: "message",
			channelId: "discord-thread-2",
			messageId: "message-b1",
			author: { id: "user-1", name: "Ada", isBot: false },
			content: "Other thread message.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});
		await waitFor(() => client.startTurnCalls.length === 2);
		expect(client.startTurnCalls.map((call) => call.threadId)).toEqual([
			"codex-thread-1",
			"codex-thread-2",
		]);

		await waitFor(() =>
			bridge.stateForTest().queue.filter((item) => item.status === "processing")
				.length === 2
		);
		expect(
			bridge.stateForTest().queue.filter((item) => item.status === "pending")
				.map((item) => item.discordMessageId),
		).toEqual([]);
		await bridge.stop();
	});

	test("reconciles a completed persisted turn on startup", async () => {
		const client = new FakeCodexClient();
		client.threadTurns.set("codex-thread-existing", [
			{
				id: "turn-recovered",
				status: "completed",
				items: [
					{
						type: "agentMessage",
						id: "message-final",
						text: "Recovered final answer.",
						phase: "final_answer",
						memoryCitation: null,
					},
				],
			} as unknown as v2.Turn,
		]);
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore({
			...emptyState(),
			sessions: [
				{
					discordThreadId: "discord-thread-1",
					parentChannelId: "parent-channel",
					codexThreadId: "codex-thread-existing",
					title: "Existing thread",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
			],
			queue: [
				{
					id: "queue-1",
					status: "processing",
					discordMessageId: "message-1",
					discordThreadId: "discord-thread-1",
					codexThreadId: "codex-thread-existing",
					authorId: "user-1",
					authorName: "Ada",
					content: "Recover this.",
					createdAt: "2026-05-11T00:00:00.000Z",
					receivedAt: "2026-05-11T00:00:00.000Z",
					attempts: 0,
					turnId: "turn-recovered",
				},
			],
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig(),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		await waitFor(() =>
			transport.messages.some((message) => message.text === "Recovered final answer.")
		);
		expect(bridge.stateForTest().queue).toEqual([]);
		expect(bridge.stateForTest().processedMessageIds).toContain("message-1");
		expect(bridge.stateForTest().deliveries.map((delivery) => delivery.kind)).toEqual([
			"final",
		]);
		await bridge.stop();
	});

	test("reconciles an active turn when the completion notification is missed", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore({
			...emptyState(),
			sessions: [
				{
					discordThreadId: "discord-thread-1",
					parentChannelId: "parent-channel",
					codexThreadId: "codex-thread-existing",
					title: "Existing thread",
					createdAt: "2026-05-11T00:00:00.000Z",
				},
			],
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig({ reconcileIntervalMs: 10 }),
			now: () => new Date("2026-05-11T00:00:00.000Z"),
		});

		await bridge.start();
		transport.emit({
			kind: "message",
			channelId: "discord-thread-1",
			messageId: "message-1",
			author: { id: "user-1", name: "Ada", isBot: false },
			content: "Complete without a notification.",
			createdAt: "2026-05-11T00:00:00.000Z",
		});
		await waitFor(() => client.startTurnCalls.length === 1);
		client.threadTurns.set("codex-thread-existing", [
			{
				id: "turn-1",
				status: "completed",
				items: [
					{
						type: "agentMessage",
						id: "message-final",
						text: "Recovered by polling.",
						phase: "final_answer",
						memoryCitation: null,
					},
				],
			} as unknown as v2.Turn,
		]);

		await waitFor(() =>
			transport.messages.some((message) => message.text === "Recovered by polling.")
		);
		expect(bridge.stateForTest().queue).toEqual([]);
		expect(bridge.stateForTest().processedMessageIds).toContain("message-1");
		await bridge.stop();
	});
});

function testConfig(
	overrides: Partial<DiscordBridgeConfig> = {},
): DiscordBridgeConfig {
	return {
		allowedUserIds: new Set(["user-1"]),
		allowedChannelIds: new Set(["parent-channel"]),
		statePath: "/tmp/codex-discord-bridge-test/state.json",
		cwd: "/workspace",
		summary: "auto",
		progressMode: "summary",
		typingIntervalMs: 10,
		...overrides,
	};
}

class FakeCodexClient implements CodexBridgeClient {
	startThreadCalls: v2.ThreadStartParams[] = [];
	resumeThreadCalls: v2.ThreadResumeParams[] = [];
	setThreadNameCalls: v2.ThreadSetNameParams[] = [];
	startTurnCalls: v2.TurnStartParams[] = [];
	steerTurnCalls: v2.TurnSteerParams[] = [];
	readThreadCalls: v2.ThreadReadParams[] = [];
	listThreadsCalls: v2.ThreadListParams[] = [];
	getThreadGoalCalls: v2.ThreadGoalGetParams[] = [];
	responses: Array<{ id: string | number; result: unknown }> = [];
	responseErrors: Array<{
		id: string | number;
		code: number;
		message: string;
		data?: unknown;
	}> = [];
	threadTurns = new Map<string, v2.Turn[]>();
	threadCwds = new Map<string, string>();
	threadGoals = new Map<string, v2.ThreadGoal | null>();
	blockStartTurn = false;
	#startTurnResolvers: Array<() => void> = [];
	#notificationListeners: Array<(message: JsonRpcNotification) => void> = [];
	#requestListeners: Array<(message: JsonRpcRequest) => void> = [];

	async connect(): Promise<void> {}

	close(): void {}

	on(
		event: "notification",
		listener: (message: JsonRpcNotification) => void,
	): unknown;
	on(
		event: "request",
		listener: (message: JsonRpcRequest) => void,
	): unknown;
	on(
		event: "notification" | "request",
		listener:
			| ((message: JsonRpcNotification) => void)
			| ((message: JsonRpcRequest) => void),
	): unknown {
		if (event === "notification") {
			this.#notificationListeners.push(
				listener as (message: JsonRpcNotification) => void,
			);
			return;
		}
		this.#requestListeners.push(listener as (message: JsonRpcRequest) => void);
	}

	async startThread(params: v2.ThreadStartParams): Promise<v2.ThreadStartResponse> {
		this.startThreadCalls.push(params);
		return {
			thread: { id: `codex-thread-${this.startThreadCalls.length}` },
		} as v2.ThreadStartResponse;
	}

	async resumeThread(params: v2.ThreadResumeParams): Promise<v2.ThreadResumeResponse> {
		this.resumeThreadCalls.push(params);
		const cwd = params.cwd ?? this.threadCwds.get(params.threadId) ?? "/workspace";
		return {
			cwd,
			thread: {
				id: params.threadId,
				cwd,
				turns: this.threadTurns.get(params.threadId) ?? [],
			},
		} as unknown as v2.ThreadResumeResponse;
	}

	async setThreadName(
		params: v2.ThreadSetNameParams,
	): Promise<v2.ThreadSetNameResponse> {
		this.setThreadNameCalls.push(params);
		return {};
	}

	async startTurn(params: v2.TurnStartParams): Promise<v2.TurnStartResponse> {
		this.startTurnCalls.push(params);
		const turnNumber = this.startTurnCalls.length;
		if (this.blockStartTurn) {
			await new Promise<void>((resolve) => {
				this.#startTurnResolvers.push(resolve);
			});
		}
		return {
			turn: { id: `turn-${turnNumber}` },
		} as v2.TurnStartResponse;
	}

	async steerTurn(params: v2.TurnSteerParams): Promise<v2.TurnSteerResponse> {
		this.steerTurnCalls.push(params);
		return { turnId: params.expectedTurnId };
	}

	async readThread(params: v2.ThreadReadParams): Promise<v2.ThreadReadResponse> {
		this.readThreadCalls.push(params);
		return {
			thread: { turns: this.threadTurns.get(params.threadId) ?? [] },
		} as unknown as v2.ThreadReadResponse;
	}

	async listThreads(params: v2.ThreadListParams): Promise<v2.ThreadListResponse> {
		this.listThreadsCalls.push(params);
		return {
			data: [],
			nextCursor: null,
			backwardsCursor: null,
		};
	}

	async getThreadGoal(
		params: v2.ThreadGoalGetParams,
	): Promise<v2.ThreadGoalGetResponse> {
		this.getThreadGoalCalls.push(params);
		return {
			goal: this.threadGoals.get(params.threadId) ?? null,
		};
	}

	respond(id: string | number, result: unknown): void {
		this.responses.push({ id, result });
	}

	respondError(
		id: string | number,
		code: number,
		message: string,
		data?: unknown,
	): void {
		this.responseErrors.push({ id, code, message, data });
	}

	resolveAllStartTurns(): void {
		for (const resolve of this.#startTurnResolvers.splice(0)) {
			resolve();
		}
	}

	emitNotification(message: JsonRpcNotification): void {
		for (const listener of this.#notificationListeners) {
			listener(message);
		}
	}

	emitRequest(message: JsonRpcRequest): void {
		for (const listener of this.#requestListeners) {
			listener(message);
		}
	}
}

class FakeDiscordTransport implements DiscordBridgeTransport {
	handlers: DiscordBridgeTransportHandlers | undefined;
	createdThreads: Array<{
		channelId: string;
		name: string;
		sourceMessageId?: string;
	}> = [];
	messages: Array<{
		channelId: string;
		id: string;
		text: string;
		webhookId?: string;
	}> = [];
	updatedMessages: Array<{
		channelId: string;
		messageId: string;
		text: string;
	}> = [];
	deletedMessages: Array<{
		channelId: string;
		messageId: string;
		text: string;
	}> = [];
	deletedThreads: string[] = [];
	addedThreadMembers: Array<{ channelId: string; userIds: string[] }> = [];
	pinnedMessages: Array<{ channelId: string; messageId: string }> = [];
	typingCount = 0;

	async start(handlers: DiscordBridgeTransportHandlers): Promise<void> {
		this.handlers = handlers;
	}

	async stop(): Promise<void> {}

	async registerCommands(): Promise<void> {}

	async createThread(
		channelId: string,
		name: string,
		sourceMessageId?: string,
	): Promise<string> {
		this.createdThreads.push({ channelId, name, sourceMessageId });
		return `discord-thread-${this.createdThreads.length}`;
	}

	async sendMessage(channelId: string, text: string): Promise<string[]> {
		const id = `message-out-${this.messages.length + 1}`;
		this.messages.push({ channelId, id, text });
		return [id];
	}

	async updateMessage(
		channelId: string,
		messageId: string,
		text: string,
	): Promise<void> {
		this.updatedMessages.push({ channelId, messageId, text });
		const message = this.messages.find((candidate) => candidate.id === messageId);
		if (message) {
			message.text = text;
		}
	}

	async deleteMessage(channelId: string, messageId: string): Promise<void> {
		const message = this.messages.find((candidate) => candidate.id === messageId);
		if (message) {
			this.deletedMessages.push({ channelId, messageId, text: message.text });
			this.messages = this.messages.filter(
				(candidate) => candidate.id !== messageId,
			);
		}
	}

	async deleteWebhookMessages(
		channelId: string,
		options: { webhookUrl?: string } = {},
	): Promise<{ deleted: number; failed: number }> {
		const webhookId = options.webhookUrl
			? options.webhookUrl.match(/\/webhooks\/([^/]+)/)?.[1]
			: undefined;
		let deleted = 0;
		for (const message of [...this.messages]) {
			if (message.channelId !== channelId || !message.webhookId) {
				continue;
			}
			if (webhookId && message.webhookId !== webhookId) {
				continue;
			}
			await this.deleteMessage(channelId, message.id);
			deleted += 1;
		}
		return { deleted, failed: 0 };
	}

	async deleteThread(channelId: string): Promise<void> {
		this.deletedThreads.push(channelId);
	}

	async addThreadMembers(channelId: string, userIds: string[]): Promise<void> {
		this.addedThreadMembers.push({ channelId, userIds });
	}

	async pinMessage(channelId: string, messageId: string): Promise<void> {
		this.pinnedMessages.push({ channelId, messageId });
	}

	async sendTyping(): Promise<void> {
		this.typingCount += 1;
	}

	emit(inbound: DiscordInbound): void {
		this.handlers?.onInbound(inbound);
	}
}

class FakeConsoleOutput implements DiscordConsoleOutput {
	messages: DiscordConsoleMessage[] = [];

	message(message: DiscordConsoleMessage): void {
		this.messages.push(message);
	}
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 1000,
): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (await predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for predicate");
}

async function sleep(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function inputText(value: unknown): string {
	if (typeof value !== "object" || value === null || !("text" in value)) {
		return "";
	}
	const text = (value as { text?: unknown }).text;
	return typeof text === "string" ? text : "";
}

function gatewayToolResult(value: unknown): unknown {
	if (typeof value !== "object" || value === null || !("contentItems" in value)) {
		return undefined;
	}
	const items = (value as { contentItems?: unknown }).contentItems;
	if (!Array.isArray(items)) {
		return undefined;
	}
	const text = inputText(items[0]);
	return text ? JSON.parse(text) : undefined;
}

function statusMessageText(transport: FakeDiscordTransport): string {
	return transport.messages.find((message) => message.id === "message-out-1")
		?.text ?? "";
}
