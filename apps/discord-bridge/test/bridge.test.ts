import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { JsonRpcNotification, JsonRpcRequest } from "@peezy.tech/codex-flows/rpc";
import type { v2 } from "@peezy.tech/codex-flows/generated";
import type { FlowBackendClient } from "@peezy.tech/codex-flows/flow-runtime/backend-client";

import {
	DiscordCodexBridge,
	LocalCodexWorkspaceBackend,
	parseThreadStartIntent,
} from "../src/bridge.ts";
import type {
	DiscordConsoleMessage,
	DiscordConsoleOutput,
} from "../src/console-output.ts";
import { MemoryStateStore, emptyState } from "../src/state.ts";
import { writeStopHookSpoolEvent } from "../src/stop-hook-spool.ts";
import type {
	CodexWorkspaceBackend,
	CodexWorkspacePresenter,
} from "../src/workspace-backend.ts";
import type {
	CodexBridgeClient,
	DiscordBridgeConfig,
	DiscordBridgeCommandRegistration,
	DiscordBridgeTransport,
	DiscordBridgeTransportHandlers,
	DiscordEphemeralPicker,
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

	test("can run Discord as a transport over a workspace backend", async () => {
		const transport = new FakeDiscordTransport();
		const calls: string[] = [];
		const inboundEvents: DiscordInbound[] = [];
		const backend: CodexWorkspaceBackend = {
			async start() {
				calls.push("backend.start");
			},
			async startTransportDependentWork() {
				calls.push("backend.transportWork");
			},
			async startBackgroundWork() {
				calls.push("backend.backgroundWork");
			},
			async stop() {
				calls.push("backend.stop");
			},
			async handleInbound(inbound) {
				inboundEvents.push(inbound);
			},
			commandRegistration() {
				return { channelIds: ["home-channel"] };
			},
			stateForTest() {
				return emptyState();
			},
		};
		const bridge = new DiscordCodexBridge({
			backend,
			transport,
		});

		await bridge.start();
		expect(calls).toEqual([
			"backend.start",
			"backend.transportWork",
			"backend.backgroundWork",
		]);
		expect(transport.registeredCommands).toEqual([
			{ channelIds: ["home-channel"] },
		]);

		transport.emit({
			kind: "message",
			channelId: "home-channel",
			messageId: "message-1",
			author: { id: "user-1", name: "Peezy", isBot: false },
			content: "status",
			createdAt: "2026-05-15T00:00:00.000Z",
		});
		await waitFor(() => inboundEvents.length === 1);
		expect(inboundEvents[0]?.kind).toBe("message");

		await bridge.stop();
		expect(calls).toContain("backend.stop");
	});

	test("local workspace backend runs against a presenter without Discord transport lifecycle", async () => {
		const client = new FakeCodexClient();
		const sentMessages: Array<{ locationId: string; text: string }> = [];
		const typingLocations: string[] = [];
		const presenter: CodexWorkspacePresenter = {
			async createThread(locationId, title, sourceMessageId) {
				expect(locationId).toBe("parent-channel");
				expect(title).toBe("Existing thread");
				expect(sourceMessageId).toBe("source-message-1");
				return "presenter-thread-1";
			},
			async sendMessage(locationId, text) {
				sentMessages.push({ locationId, text });
				return [`presenter-message-${sentMessages.length}`];
			},
			async deleteMessage() {},
			async sendTyping(locationId) {
				typingLocations.push(locationId);
			},
		};
		const backend = new LocalCodexWorkspaceBackend({
			client,
			presenter,
			store: new MemoryStateStore(),
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
				allowedChannelIds: new Set(["parent-channel"]),
			}),
		});

		await backend.start();
		expect(client.startThreadCalls).toHaveLength(1);
		expect(backend.commandRegistration()).toEqual({
			channelIds: ["parent-channel", "home-channel"],
		});

		await backend.startTransportDependentWork();
		await backend.startBackgroundWork();
		await backend.handleInbound({
			kind: "message",
			channelId: "home-channel",
			messageId: "home-message-1",
			author: { id: "user-1", name: "Peezy", isBot: false },
			content: "status across the workspaces",
			createdAt: "2026-05-15T00:00:00.000Z",
		});
		await waitFor(() => client.startTurnCalls.length === 1);
		expect(inputText(client.startTurnCalls[0]?.input[0])).toContain(
			"status across the workspaces",
		);
		expect(typingLocations).toContain("home-channel");

		await backend.stop();
	});

	test("starts a workspace main thread and routes home channel messages to it", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
				allowedChannelIds: new Set(["parent-channel"]),
			}),
		});

		await bridge.start();
		await waitFor(() => bridge.stateForTest().sessions.length === 1);
		expect(transport.registeredCommands).toEqual([
			{ channelIds: ["parent-channel", "home-channel"] },
		]);
		expect(client.startThreadCalls).toHaveLength(1);
		expect(client.startThreadCalls[0]?.dynamicTools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					namespace: "codex_workspace",
					name: "start_delegation",
				}),
				expect.objectContaining({
					namespace: "codex_workspace",
					name: "list_flow_runs",
				}),
			]),
		);
		expect(client.setThreadNameCalls[0]).toEqual({
			threadId: "codex-thread-1",
			name: "[discord-workspace] Codex Workspace",
		});
		expect(bridge.stateForTest().workspace).toEqual(
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
				title: "Codex Workspace",
				cwd: "/workspace",
				mode: "operator",
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
			"[discord-workspace]",
		);
		expect(inputText(client.startTurnCalls[0]?.input[0])).toContain(
			"main Codex operator thread",
		);
		expect(inputText(client.startTurnCalls[0]?.input[0])).toContain(
			"Home channel: home-channel",
		);
		await bridge.stop();
	});

	test("workspace tool starts and tracks delegated Codex sessions without privileged tools", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
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
				namespace: "codex_workspace",
				tool: "start_delegation",
				arguments: {
					cwd: "/workspace/other",
					title: "Other workspace",
					prompt: "Inspect the remaining workspace work.",
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
			"Inspect the remaining workspace work.",
		);
		expect(bridge.stateForTest().workspace?.delegations).toEqual([
			expect.objectContaining({
				codexThreadId: "codex-thread-2",
				title: "Other workspace",
				status: "active",
				cwd: "/workspace/other",
				discordDetailThreadId: "detail-thread",
				parentDiscordMessageId: "home-message",
			}),
		]);
		expect(workspaceToolResult(client.responses[0]?.result)).toEqual(
			expect.objectContaining({
				turnId: "turn-1",
				delegation: expect.objectContaining({
					codexThreadId: "codex-thread-2",
				}),
			}),
		);
		await bridge.stop();
	});

	test("workspace flow inspection uses backend client and preserves tool payload shape", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const flowBackendClient = new FakeFlowBackendClient();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
			}),
			flowBackendClient,
		});

		await bridge.start();
		await waitFor(() => bridge.stateForTest().sessions.length === 1);
		client.emitRequest({
			id: "tool-runs",
			method: "item/tool/call",
			params: {
				threadId: "codex-thread-1",
				namespace: "codex_workspace",
				tool: "list_flow_runs",
				arguments: {
					eventId: "event-1",
					status: "completed",
					limit: "5",
				},
			},
		});
		client.emitRequest({
			id: "tool-events",
			method: "item/tool/call",
			params: {
				threadId: "codex-thread-1",
				namespace: "codex_workspace",
				tool: "list_flow_events",
				arguments: {
					type: "upstream.release",
					limit: "3",
				},
			},
		});

		await waitFor(() => client.responses.length === 2);
		expect(flowBackendClient.listRunsCalls).toEqual([
			{ eventId: "event-1", status: "completed", limit: 5 },
		]);
		expect(flowBackendClient.listEventsCalls).toEqual([
			{ type: "upstream.release", limit: 3 },
		]);
		expect(workspaceToolResult(client.responses[0]?.result)).toEqual({
			eventId: "event-1",
			runs: [
				expect.objectContaining({
					id: "run-1",
					status: "blocked",
					effectiveStatus: "blocked",
					needsAttention: true,
				}),
			],
		});
		expect(workspaceToolResult(client.responses[1]?.result)).toEqual({
			events: [
				expect.objectContaining({
					id: "event-1",
					type: "upstream.release",
				}),
			],
		});
		await bridge.stop();
	});

	test("workspace workbench opens delegation task threads lazily from workspace posts", async () => {
		const hookSpoolDir = await testHookSpoolDir();
		const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "discord-workbench-root-"));
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				cwd: workspaceRoot,
				workspace: {
					homeChannelId: "home-channel",
					workspaceForumChannelId: "workspace-forum",
					taskThreadsChannelId: "task-channel",
				},
				allowedChannelIds: new Set(["home-channel"]),
				hookSpoolDir,
			}),
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		});

		try {
			await bridge.start();
			await waitFor(() => bridge.stateForTest().sessions.length === 1);
			client.emitRequest({
				id: "tool-1",
				method: "item/tool/call",
				params: {
					threadId: "codex-thread-1",
					namespace: "codex_workspace",
					tool: "start_delegation",
					arguments: {
						cwd: "/workspace/codex-flows",
						title: "Hook packaging",
						prompt: "Package the hook command.",
						returnMode: "record_only",
					},
				},
			});

			await waitFor(() => client.responses.length === 1);
			expect(transport.createdForumPosts).toEqual([
				expect.objectContaining({
					channelId: "workspace-forum",
					name: "codex-flows",
					threadId: "forum-post-1",
				}),
			]);
			expect(transport.createdThreads).toEqual([]);
			const state = bridge.stateForTest();
			expect(state.workspace?.workspaces).toEqual([
				expect.objectContaining({
					cwd: "/workspace/codex-flows",
					title: "codex-flows",
					discordThreadId: "forum-post-1",
					statusMessageId: "forum-post-1",
					delegationIds: [state.workspace?.delegations[0]?.id],
				}),
			]);
			expect(state.workspace?.delegations[0]).toEqual(
				expect.objectContaining({
					codexThreadId: "codex-thread-2",
					workspaceKey: state.workspace?.workspaces?.[0]?.key,
					discordWorkspaceThreadId: "forum-post-1",
				}),
			);
			expect(state.workspace?.delegations[0]?.discordTaskThreadId).toBeUndefined();
			const workspaceUpdate = transport.updatedMessages.find((message) =>
				message.channelId === "forum-post-1" &&
				message.messageId === "forum-post-1"
			);
			expect(workspaceUpdate?.text).toContain("**Visible Threads**");
			expect(workspaceUpdate?.text).toContain(
				"1. `not opened` Hook packaging (active)",
			);

			const replies: string[] = [];
			transport.emit({
				kind: "threads",
				channelId: "forum-post-1",
				author: { id: "user-1", name: "Peezy", isBot: false },
				createdAt: "2026-05-14T12:00:30.000Z",
				reply: async (text) => {
					replies.push(text);
				},
				replyPicker: transport.threadsReplyPicker(),
			});
			await waitFor(() => transport.ephemeralPickers.length === 1);
			expect(replies).toEqual([]);
			expect(transport.messages.some((message) =>
				message.channelId === "forum-post-1" &&
				message.text.includes("Hook packaging")
			)).toBe(true);
			const picker = transport.ephemeralPickers[0];
			expect(picker?.text).toContain("1️⃣ `not opened` Hook packaging");
			expect(picker?.text).toContain(
				"Choose a number to open or resume that thread in Discord.",
			);
			expect(picker?.options).toEqual([{ id: "0", label: "1" }]);

			transport.emitThreadPicker({
				pickerId: picker?.pickerId ?? "",
				optionId: "0",
			});
			await waitFor(() => transport.createdThreads.length === 1);
			expect(transport.ephemeralUpdates.some((update) =>
				update.pickerId === picker?.pickerId &&
				update.text === "Opened Hook packaging: <#discord-thread-1>"
			)).toBe(true);
			expect(transport.createdThreads).toEqual([
				{
					channelId: "task-channel",
					name: "codex-flows: Hook packaging",
					sourceMessageId: undefined,
				},
			]);
			expect(bridge.stateForTest().sessions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						discordThreadId: "discord-thread-1",
						parentChannelId: "task-channel",
						codexThreadId: "codex-thread-2",
						cwd: "/workspace/codex-flows",
						mode: "workspace",
					}),
				]),
			);

			await emitStopHook(hookSpoolDir, {
				sessionId: "codex-thread-2",
				turnId: "turn-1",
				lastAssistantMessage: "Workbench result.",
				cwd: "/workspace/codex-flows",
			});
			await waitFor(() => client.injectThreadItemsCalls.length === 1);
			expect(transport.messages.some((message) =>
				message.channelId === "discord-thread-1" &&
				message.text.includes("Workbench result.")
			)).toBe(true);
			const homeResult = transport.messages.find((message) =>
				message.channelId === "home-channel" &&
				message.text.includes("[discord-workspace delegation result]") &&
				message.text.includes("Hook packaging")
			)?.text ?? "";
			expect(homeResult).toContain("<#forum-post-1>");
			expect(homeResult).toContain("<#discord-thread-1>");
			expect(homeResult).not.toContain("Workbench result.");
			expect(transport.updatedMessages.some((message) =>
				message.channelId === "forum-post-1" &&
				message.text.includes("<#discord-thread-1> Hook packaging")
			)).toBe(true);

			transport.emit({
				kind: "message",
				channelId: "discord-thread-1",
				messageId: "task-follow-up",
				author: { id: "user-1", name: "Peezy", isBot: false },
				content: "Continue in this delegated thread.",
				createdAt: "2026-05-14T12:01:00.000Z",
			});
			await waitFor(() => client.startTurnCalls.length === 2);
			expect(client.startTurnCalls[1]).toEqual(
				expect.objectContaining({
					threadId: "codex-thread-2",
					cwd: "/workspace/codex-flows",
				}),
			);
			expect(inputText(client.startTurnCalls[1]?.input[0])).toContain(
				"Continue in this delegated thread.",
			);
			} finally {
				await bridge.stop();
				await rm(hookSpoolDir, { recursive: true, force: true });
				await rm(workspaceRoot, { recursive: true, force: true });
			}
		});

	test("workspace workbench reuses one workspace post per normalized cwd", async () => {
		const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "discord-workbench-root-"));
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				cwd: workspaceRoot,
				workspace: {
					homeChannelId: "home-channel",
					workspaceForumChannelId: "workspace-forum",
					taskThreadsChannelId: "task-channel",
				},
			}),
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		});

		try {
			await bridge.start();
			await waitFor(() => bridge.stateForTest().sessions.length === 1);
			for (const [index, title] of ["First task", "Second task"].entries()) {
				client.emitRequest({
					id: `tool-${index}`,
					method: "item/tool/call",
					params: {
						threadId: "codex-thread-1",
						namespace: "codex_workspace",
						tool: "start_delegation",
						arguments: {
							cwd: index === 0
								? "/workspace/codex-flows/."
								: "/workspace/codex-flows",
							title,
						},
					},
				});
				await waitFor(() => client.responses.length === index + 1);
			}

			expect(transport.createdForumPosts).toHaveLength(1);
			expect(transport.createdThreads).toHaveLength(0);
			const workspaces = bridge.stateForTest().workspace?.workspaces ?? [];
			const delegations = bridge.stateForTest().workspace?.delegations ?? [];
			expect(workspaces).toEqual([
				expect.objectContaining({
					cwd: "/workspace/codex-flows",
					delegationIds: delegations.map((delegation) => delegation.id),
				}),
			]);
			expect(new Set(delegations.map((delegation) => delegation.workspaceKey)).size)
				.toBe(1);
		} finally {
			await bridge.stop();
			await rm(workspaceRoot, { recursive: true, force: true });
		}
	});

	test("workspace workbench discovers top-level folders under the main workspace", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "discord-workspaces-"));
		await mkdir(path.join(root, "alpha", "nested"), { recursive: true });
		await mkdir(path.join(root, "beta"), { recursive: true });
		await mkdir(path.join(root, ".cache"), { recursive: true });
		const client = new FakeCodexClient();
		client.threads = [
			testThread({
				id: "codex-alpha-existing",
				cwd: path.join(root, "alpha", "nested"),
				name: "Alpha existing",
				updatedAt: 3,
			}),
			testThread({
				id: "codex-beta-existing",
				cwd: path.join(root, "beta"),
				name: "Beta existing",
				updatedAt: 2,
			}),
		];
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				cwd: root,
				workspace: {
					homeChannelId: "home-channel",
					workspaceForumChannelId: "workspace-forum",
					taskThreadsChannelId: "task-channel",
				},
			}),
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		});

		try {
			await bridge.start();
			expect(transport.createdForumPosts.map((post) => post.name)).toEqual([
				"alpha",
				"beta",
			]);
			expect(bridge.stateForTest().workspace?.workspaces?.map((workspace) =>
				workspace.cwd
			)).toEqual([
				path.join(root, "alpha"),
				path.join(root, "beta"),
			]);
			expect(transport.updatedMessages.some((message) =>
				message.channelId === "forum-post-1" &&
				message.text.includes("**Visible Threads**\nNone")
			)).toBe(true);
			expect(transport.updatedMessages.some((message) =>
				message.channelId === "forum-post-2" &&
				message.text.includes("**Visible Threads**\nNone")
			)).toBe(true);
			const replies: string[] = [];
			transport.emit({
				kind: "threads",
				channelId: "forum-post-1",
				author: { id: "user-1", name: "Peezy", isBot: false },
				createdAt: "2026-05-14T12:00:30.000Z",
				reply: async (text) => {
					replies.push(text);
				},
				replyPicker: transport.threadsReplyPicker(),
			});
			await waitFor(() => transport.ephemeralPickers.length === 1);
			expect(replies).toEqual([]);
			expect(transport.messages.some((message) =>
				message.channelId === "forum-post-1" &&
				message.text.includes("Alpha existing")
			)).toBe(false);
			const picker = transport.ephemeralPickers[0];
			expect(picker?.text).toContain("1️⃣ `not opened` Alpha existing");
			transport.emitThreadPicker({
				pickerId: picker?.pickerId ?? "",
				optionId: "0",
			});
			await waitFor(() => transport.createdThreads.length === 1);
			expect(client.resumeThreadCalls.some((call) =>
				call.threadId === "codex-alpha-existing"
			)).toBe(true);
			expect(transport.createdThreads[0]).toEqual({
				channelId: "task-channel",
				name: "alpha: Alpha existing",
				sourceMessageId: undefined,
			});

			client.emitRequest({
				id: "tool-nested",
				method: "item/tool/call",
				params: {
					threadId: "codex-thread-1",
					namespace: "codex_workspace",
					tool: "start_delegation",
					arguments: {
						cwd: path.join(root, "alpha", "nested", "project"),
						title: "Nested task",
					},
				},
			});
			await waitFor(() => client.responses.length === 1);
			expect(transport.createdForumPosts).toHaveLength(2);
			expect(transport.createdThreads).toHaveLength(1);
			const state = bridge.stateForTest();
			const alpha = state.workspace?.workspaces?.find((workspace) =>
				workspace.cwd === path.join(root, "alpha")
			);
			const delegation = state.workspace?.delegations[0];
			expect(delegation).toBeDefined();
			expect(alpha?.delegationIds).toEqual([delegation!.id]);
			expect(delegation).toEqual(
				expect.objectContaining({
					workspaceKey: alpha?.key,
					discordWorkspaceThreadId: alpha?.discordThreadId,
				}),
			);
		} finally {
			await bridge.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("workspace workbench surfaces hook-observed non-workspace threads", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "discord-observed-"));
		const hookSpoolDir = await testHookSpoolDir();
		await mkdir(path.join(root, "alpha", "project"), { recursive: true });
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				cwd: root,
				workspace: {
					homeChannelId: "home-channel",
					workspaceForumChannelId: "workspace-forum",
					taskThreadsChannelId: "task-channel",
				},
				hookSpoolDir,
			}),
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		});

		try {
			await bridge.start();
			expect(transport.createdForumPosts.map((post) => post.name)).toEqual([
				"alpha",
			]);
			await emitHookEvent(hookSpoolDir, {
				eventName: "UserPromptSubmit",
				sessionId: "codex-observed",
				turnId: "turn-observed",
				cwd: path.join(root, "alpha", "project"),
				prompt: "Inspect observed runtime activity.",
			});
			await waitFor(() =>
				bridge.stateForTest().workspace?.observedThreads?.[0]?.status === "active"
			);
			await emitHookEvent(hookSpoolDir, {
				eventName: "PermissionRequest",
				sessionId: "codex-observed",
				turnId: "turn-observed",
				cwd: path.join(root, "alpha", "project"),
				toolName: "Bash",
				toolInput: { description: "Needs network" },
			});
			await waitFor(() =>
				bridge.stateForTest().workspace?.observedThreads?.[0]?.status === "waiting"
			);
			expect(bridge.stateForTest().workspace?.observedThreads?.[0]).toEqual(
				expect.objectContaining({
					threadId: "codex-observed",
					title: "Inspect observed runtime activity.",
					cwd: path.join(root, "alpha", "project"),
					promptPreview: "Inspect observed runtime activity.",
					permissionDescription: "Needs network",
				}),
			);
			await waitFor(() => transport.updatedMessages.some((message) =>
				message.channelId === "forum-post-1" &&
				message.text.includes(
					"1. `not opened` Inspect observed runtime activity. (waiting: Needs network)",
				)
			));

			const replies: string[] = [];
			transport.emit({
				kind: "threads",
				channelId: "forum-post-1",
				author: { id: "user-1", name: "Peezy", isBot: false },
				createdAt: "2026-05-14T12:00:30.000Z",
				reply: async (text) => {
					replies.push(text);
				},
				replyPicker: transport.threadsReplyPicker(),
			});
			await waitFor(() => transport.ephemeralPickers.length === 1);
			expect(replies).toEqual([]);
			expect(transport.messages.some((message) =>
				message.channelId === "forum-post-1" &&
				message.text.includes("Inspect observed runtime activity")
			)).toBe(true);
			const picker = transport.ephemeralPickers[0];
			expect(picker?.text).toContain(
				"1️⃣ `not opened` Inspect observed runtime activity. (waiting: Needs network)",
			);

			transport.emitThreadPicker({
				pickerId: picker?.pickerId ?? "",
				optionId: "0",
			});
			await waitFor(() => transport.createdThreads.length === 1);
			expect(client.resumeThreadCalls.some((call) =>
				call.threadId === "codex-observed" &&
				call.cwd === path.join(root, "alpha", "project")
			)).toBe(true);
			expect(transport.createdThreads[0]).toEqual({
				channelId: "task-channel",
				name: "alpha: Inspect observed runtime activity.",
				sourceMessageId: undefined,
			});
		} finally {
			await bridge.stop();
			await rm(hookSpoolDir, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		}
	});

	test("workspace hook drain continues when workspace dashboard updates fail", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "discord-observed-fail-"));
		const hookSpoolDir = await testHookSpoolDir();
		await mkdir(path.join(root, "alpha", "project"), { recursive: true });
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				cwd: root,
				workspace: {
					homeChannelId: "home-channel",
					workspaceForumChannelId: "workspace-forum",
					taskThreadsChannelId: "task-channel",
				},
				hookSpoolDir,
			}),
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		});

		try {
			await bridge.start();
			transport.failUpdateMessages = true;
			await emitHookEvent(hookSpoolDir, {
				eventName: "UserPromptSubmit",
				sessionId: "codex-observed-fail",
				turnId: "turn-observed-fail",
				cwd: path.join(root, "alpha", "project"),
				prompt: "Keep draining hooks.",
			});
			await waitFor(() =>
				bridge.stateForTest().workspace?.observedThreads?.some((thread) =>
					thread.threadId === "codex-observed-fail" &&
					thread.status === "active"
				) ?? false
			);
			await waitFor(async () =>
				(await readdir(path.join(hookSpoolDir, "pending"))).length === 0
			);
		} finally {
			await bridge.stop();
			await rm(hookSpoolDir, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		}
	});

	test("workspace workbench resumes persisted task thread sessions after restart", async () => {
		const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "discord-workbench-root-"));
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const existingWorkspaceKey = testWorkspaceKey("/workspace/codex-flows");
		const store = new MemoryStateStore({
			...emptyState(),
			workspace: {
				homeChannelId: "home-channel",
				mainThreadId: "codex-main",
				toolsVersion: 1,
				delegations: [
					{
						id: "delegation-existing",
						codexThreadId: "codex-delegated",
						title: "Existing task",
						status: "idle",
						cwd: "/workspace/codex-flows",
						workspaceKey: existingWorkspaceKey,
						discordTaskThreadId: "task-thread-existing",
						discordWorkspaceThreadId: "workspace-post-existing",
						createdAt: "2026-05-14T11:00:00.000Z",
						updatedAt: "2026-05-14T11:00:00.000Z",
					},
				],
				workspaces: [
					{
						key: existingWorkspaceKey,
						cwd: "/workspace/codex-flows",
						title: "codex-flows",
						discordThreadId: "workspace-post-existing",
						statusMessageId: "workspace-status-existing",
						delegationIds: ["delegation-existing"],
						createdAt: "2026-05-14T11:00:00.000Z",
						updatedAt: "2026-05-14T11:00:00.000Z",
					},
				],
			},
			sessions: [
				{
					discordThreadId: "home-channel",
					parentChannelId: "home-channel",
					codexThreadId: "codex-main",
					title: "Codex Workspace",
					createdAt: "2026-05-14T11:00:00.000Z",
					cwd: "/workspace",
					mode: "workspace",
				},
				{
					discordThreadId: "task-thread-existing",
					parentChannelId: "task-channel",
					codexThreadId: "codex-delegated",
					title: "Existing task",
					createdAt: "2026-05-14T11:00:00.000Z",
					cwd: "/workspace/codex-flows",
					mode: "delegated",
				},
			],
			queue: [],
			activeTurns: [],
			processedMessageIds: [],
			deliveries: [],
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig({
				cwd: workspaceRoot,
				workspace: {
					homeChannelId: "home-channel",
					workspaceForumChannelId: "workspace-forum",
					taskThreadsChannelId: "task-channel",
				},
				allowedChannelIds: new Set(["home-channel"]),
			}),
		});

		try {
			await bridge.start();
			await waitFor(() => bridge.stateForTest().sessions.length === 2);
			expect(transport.createdForumPosts).toEqual([]);
			expect(transport.createdThreads).toEqual([]);

			transport.emit({
				kind: "message",
				channelId: "task-thread-existing",
				messageId: "message-existing-task",
				author: { id: "user-1", name: "Peezy", isBot: false },
				content: "Continue the restarted delegated task.",
				createdAt: "2026-05-14T12:00:00.000Z",
			});
			await waitFor(() => client.startTurnCalls.length === 1);
			expect(client.startTurnCalls[0]).toEqual(
				expect.objectContaining({
					threadId: "codex-delegated",
					cwd: "/workspace/codex-flows",
				}),
			);
		} finally {
			await bridge.stop();
			await rm(workspaceRoot, { recursive: true, force: true });
		}
	});

	test("workspace rejects dynamic tool calls outside the main operator thread", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
			}),
		});

		await bridge.start();
		await waitFor(() => bridge.stateForTest().sessions.length === 1);
		client.emitRequest({
			id: "tool-1",
			method: "item/tool/call",
			params: {
				threadId: "codex-thread-elsewhere",
				namespace: "codex_workspace",
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

	test("workspace records group delegation results and wakes after the group finishes", async () => {
		const hookSpoolDir = await testHookSpoolDir();
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
				hookSpoolDir,
			}),
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		});

		try {
			await bridge.start();
			await waitFor(() => bridge.stateForTest().sessions.length === 1);
			for (const [index, title] of ["Workspace A", "Workspace B"].entries()) {
				client.emitRequest({
					id: `tool-${index}`,
					method: "item/tool/call",
					params: {
						threadId: "codex-thread-1",
						namespace: "codex_workspace",
						tool: "start_delegation",
						arguments: {
							cwd: `/workspace/${index}`,
							title,
							prompt: `Inspect ${title}.`,
							groupId: "fanout",
						},
					},
				});
				await waitFor(() => client.responses.length === index + 1);
			}

			await emitStopHook(hookSpoolDir, {
				sessionId: "codex-thread-2",
				turnId: "turn-1",
				lastAssistantMessage: "Result A.",
			});
			await waitFor(() => client.injectThreadItemsCalls.length === 1);
			expect(client.startTurnCalls).toHaveLength(2);
			expect(client.readThreadCalls).toEqual([]);
			expect(transport.messages.some((message) =>
				message.channelId === "home-channel" &&
				message.text.includes("Result A.")
			)).toBe(true);

			await emitStopHook(hookSpoolDir, {
				sessionId: "codex-thread-3",
				turnId: "turn-2",
				lastAssistantMessage: "Result B.",
			});
			await waitFor(() => client.startTurnCalls.length === 3);
			expect(client.injectThreadItemsCalls).toHaveLength(2);
			expect(client.startTurnCalls[2]).toEqual(
				expect.objectContaining({
					threadId: "codex-thread-1",
				}),
			);
			expect(inputText(client.startTurnCalls[2]?.input[0])).toContain(
				"Delegation group fanout completed.",
			);
			expect(bridge.stateForTest().workspace?.pendingWakes?.[0]).toEqual(
				expect.objectContaining({
					kind: "group",
					groupId: "fanout",
					startedAt: "2026-05-14T12:00:00.000Z",
				}),
			);
			await sleep(30);
			expect(client.startTurnCalls).toHaveLength(3);
			expect(bridge.stateForTest().workspace?.pendingWakes).toHaveLength(1);
		} finally {
			await bridge.stop();
			await rm(hookSpoolDir, { recursive: true, force: true });
		}
	});

	test("workspace detached delegations complete without injecting or waking the main thread", async () => {
		const hookSpoolDir = await testHookSpoolDir();
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
				hookSpoolDir,
			}),
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		});

		try {
			await bridge.start();
			await waitFor(() => bridge.stateForTest().sessions.length === 1);
			client.emitRequest({
				id: "tool-1",
				method: "item/tool/call",
				params: {
					threadId: "codex-thread-1",
					namespace: "codex_workspace",
					tool: "start_delegation",
					arguments: {
						cwd: "/workspace/detached",
						title: "Detached workspace",
						prompt: "Prepare this for a human.",
						returnMode: "detached",
					},
				},
			});

			await waitFor(() => client.responses.length === 1);
			await emitStopHook(hookSpoolDir, {
				sessionId: "codex-thread-2",
				turnId: "turn-1",
				lastAssistantMessage: "Detached result.",
			});
			await waitFor(() =>
				bridge.stateForTest().workspace?.delegations[0]?.status === "complete"
			);
			expect(client.injectThreadItemsCalls).toEqual([]);
			expect(client.startTurnCalls).toHaveLength(1);
			expect(client.readThreadCalls).toEqual([]);
			expect(transport.messages.some((message) =>
				message.text.includes("Detached result.")
			)).toBe(false);
		} finally {
			await bridge.stop();
			await rm(hookSpoolDir, { recursive: true, force: true });
		}
	});

	test("workspace queues delegation wake while the main operator thread is busy", async () => {
		const hookSpoolDir = await testHookSpoolDir();
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
				hookSpoolDir,
			}),
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		});

		try {
			await bridge.start();
			await waitFor(() => bridge.stateForTest().sessions.length === 1);
			transport.emit({
				kind: "message",
				channelId: "home-channel",
				messageId: "home-message-1",
				author: { id: "user-1", name: "Peezy", isBot: false },
				content: "work on a long-running main task",
				createdAt: "2026-05-14T12:00:00.000Z",
			});
			await waitFor(() => bridge.stateForTest().activeTurns.length === 1);

			client.emitRequest({
				id: "tool-1",
				method: "item/tool/call",
				params: {
					threadId: "codex-thread-1",
					namespace: "codex_workspace",
					tool: "start_delegation",
					arguments: {
						cwd: "/workspace/side",
						title: "Side task",
						prompt: "Finish this side task.",
					},
				},
			});

			await waitFor(() => client.responses.length === 1);
			await emitStopHook(hookSpoolDir, {
				sessionId: "codex-thread-2",
				turnId: "turn-2",
				lastAssistantMessage: "Side task result.",
			});
			await waitFor(() => client.injectThreadItemsCalls.length === 1);
			expect(client.startTurnCalls).toHaveLength(2);
			expect(bridge.stateForTest().workspace?.pendingWakes?.[0]).toEqual(
				expect.objectContaining({
					kind: "delegation",
				}),
			);
			expect(bridge.stateForTest().workspace?.pendingWakes?.[0]).not.toHaveProperty(
				"startedAt",
			);
			await emitStopHook(hookSpoolDir, {
				sessionId: "codex-thread-1",
				turnId: "turn-1",
				lastAssistantMessage: "Main task paused.",
			});
			await waitFor(() => client.startTurnCalls.length === 3);
			expect(inputText(client.startTurnCalls[2]?.input[0])).toContain(
				"Delegation Side task completed.",
			);
			expect(bridge.stateForTest().workspace?.pendingWakes?.[0]).toEqual(
				expect.objectContaining({
					startedAt: "2026-05-14T12:00:00.000Z",
				}),
			);
		} finally {
			await bridge.stop();
			await rm(hookSpoolDir, { recursive: true, force: true });
		}
	});

	test("workspace record-only delegations inject and mirror without waking", async () => {
		const hookSpoolDir = await testHookSpoolDir();
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
				hookSpoolDir,
			}),
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		});

		try {
			await bridge.start();
			await waitFor(() => bridge.stateForTest().sessions.length === 1);
			client.emitRequest({
				id: "tool-1",
				method: "item/tool/call",
				params: {
					threadId: "codex-thread-1",
					namespace: "codex_workspace",
					tool: "start_delegation",
					arguments: {
						cwd: "/workspace/record",
						title: "Record only task",
						prompt: "Record this result.",
						returnMode: "record_only",
					},
				},
			});

			await waitFor(() => client.responses.length === 1);
			await emitStopHook(hookSpoolDir, {
				sessionId: "codex-thread-2",
				turnId: "turn-1",
				lastAssistantMessage: "Record-only result.",
			});
			await waitFor(() => client.injectThreadItemsCalls.length === 1);
			expect(client.startTurnCalls).toHaveLength(1);
			expect(bridge.stateForTest().workspace?.pendingWakes ?? []).toEqual([]);
			expect(transport.messages.some((message) =>
				message.text.includes("Record-only result.")
			)).toBe(true);
		} finally {
			await bridge.stop();
			await rm(hookSpoolDir, { recursive: true, force: true });
		}
	});

	test("workspace drains queued stop hook events on startup", async () => {
		const hookSpoolDir = await testHookSpoolDir();
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore({
			...emptyState(),
			workspace: {
				homeChannelId: "home-channel",
				mainThreadId: "codex-thread-1",
				toolsVersion: 1,
				delegations: [
					{
						id: "delegation-queued",
						codexThreadId: "codex-thread-2",
						title: "Queued event task",
						status: "active",
						cwd: "/workspace/queued",
						returnMode: "record_only",
						createdAt: "2026-05-14T11:59:00.000Z",
						updatedAt: "2026-05-14T11:59:00.000Z",
					},
				],
				pendingWakes: [],
				processedStopHookEventIds: [],
			},
			sessions: [
				{
					discordThreadId: "home-channel",
					parentChannelId: "home-channel",
					codexThreadId: "codex-thread-1",
					title: "Codex Workspace",
					createdAt: "2026-05-14T11:59:00.000Z",
					cwd: "/workspace",
					mode: "workspace",
				},
			],
		});
		await emitStopHook(hookSpoolDir, {
			sessionId: "codex-thread-2",
			turnId: "turn-queued",
			lastAssistantMessage: "Queued result.",
			cwd: "/workspace/queued",
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
				hookSpoolDir,
			}),
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		});

		try {
			await bridge.start();
			await waitFor(() => client.injectThreadItemsCalls.length === 1);
			expect(client.readThreadCalls).toEqual([]);
			expect(bridge.stateForTest().workspace?.delegations[0]).toEqual(
				expect.objectContaining({
					status: "complete",
					lastTurnId: "turn-queued",
					lastFinal: "Queued result.",
					injectedAt: "2026-05-14T12:00:00.000Z",
				}),
			);
			expect(transport.messages.some((message) =>
				message.text.includes("Queued result.")
			)).toBe(true);
		} finally {
			await bridge.stop();
			await rm(hookSpoolDir, { recursive: true, force: true });
		}
	});

	test("workspace stop hook events are idempotent", async () => {
		const hookSpoolDir = await testHookSpoolDir();
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
				hookSpoolDir,
			}),
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		});

		try {
			await bridge.start();
			await waitFor(() => bridge.stateForTest().sessions.length === 1);
			client.emitRequest({
				id: "tool-1",
				method: "item/tool/call",
				params: {
					threadId: "codex-thread-1",
					namespace: "codex_workspace",
					tool: "start_delegation",
					arguments: {
						cwd: "/workspace/idempotent",
						title: "Idempotent task",
						prompt: "Return once.",
						returnMode: "record_only",
					},
				},
			});
			await waitFor(() => client.responses.length === 1);
			await emitStopHook(hookSpoolDir, {
				sessionId: "codex-thread-2",
				turnId: "turn-1",
				lastAssistantMessage: "Exactly once.",
			});
			await waitFor(() => client.injectThreadItemsCalls.length === 1);
			await emitStopHook(hookSpoolDir, {
				sessionId: "codex-thread-2",
				turnId: "turn-1",
				lastAssistantMessage: "Duplicate with changed text.",
			});
			await sleep(200);
			expect(client.injectThreadItemsCalls).toHaveLength(1);
			expect(transport.messages.filter((message) =>
				message.text.includes("Exactly once.")
			)).toHaveLength(1);
			expect(
				bridge.stateForTest().workspace?.processedStopHookEventIds,
			).toHaveLength(1);
		} finally {
			await bridge.stop();
			await rm(hookSpoolDir, { recursive: true, force: true });
		}
	});

	test("workspace manually flushes completed manual delegation results", async () => {
		const hookSpoolDir = await testHookSpoolDir();
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
				hookSpoolDir,
			}),
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		});

		try {
			await bridge.start();
			await waitFor(() => bridge.stateForTest().sessions.length === 1);
			client.emitRequest({
				id: "tool-1",
				method: "item/tool/call",
				params: {
					threadId: "codex-thread-1",
					namespace: "codex_workspace",
					tool: "start_delegation",
					arguments: {
						cwd: "/workspace/manual",
						title: "Manual task",
						prompt: "Finish manually.",
						returnMode: "manual",
					},
				},
			});

			await waitFor(() => client.responses.length === 1);
			await emitStopHook(hookSpoolDir, {
				sessionId: "codex-thread-2",
				turnId: "turn-1",
				lastAssistantMessage: "Manual result.",
			});
			await waitFor(() =>
				bridge.stateForTest().workspace?.delegations[0]?.status === "complete"
			);
			expect(client.injectThreadItemsCalls).toEqual([]);
			client.emitRequest({
				id: "tool-2",
				method: "item/tool/call",
				params: {
					threadId: "codex-thread-1",
					namespace: "codex_workspace",
					tool: "flush_delegation_results",
					arguments: {
						delegationId: bridge.stateForTest().workspace?.delegations[0]?.id,
						wake: "false",
					},
				},
			});

			await waitFor(() => client.injectThreadItemsCalls.length === 1);
			expect(client.startTurnCalls).toHaveLength(1);
			await waitFor(() =>
				transport.messages.some((message) =>
					message.text.includes("Manual result.")
				)
			);
		} finally {
			await bridge.stop();
			await rm(hookSpoolDir, { recursive: true, force: true });
		}
	});

	test("answers workspace status command without starting a turn", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const replies: string[] = [];
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
			}),
		});

		await bridge.start();
		await waitFor(() => bridge.stateForTest().sessions.length === 1);
		transport.emit({
			kind: "status",
			channelId: "home-channel",
			author: { id: "user-1", name: "Peezy", isBot: false },
			createdAt: "2026-05-14T00:00:00.000Z",
			reply: async (text) => {
				replies.push(text);
			},
		});

		await waitFor(() => replies.length === 1);
		expect(replies[0]).toContain("**Codex Workspace**");
		expect(client.startTurnCalls).toHaveLength(0);
		await bridge.stop();
	});

	test("status lists active Codex threads and opens unlinked threads", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "discord-status-"));
		await mkdir(path.join(root, "alpha", "project"), { recursive: true });
		await mkdir(path.join(root, "beta", "project"), { recursive: true });
		const client = new FakeCodexClient();
		client.threads = [
			testThread({
				id: "codex-active-linked",
				cwd: path.join(root, "alpha", "project"),
				name: "Linked active",
				status: { type: "active" } as v2.ThreadStatus,
				updatedAt: 30,
			}),
			testThread({
				id: "codex-active-missing",
				cwd: path.join(root, "beta", "project"),
				name: "Missing active",
				status: { type: "active" } as v2.ThreadStatus,
				updatedAt: 40,
			}),
			testThread({
				id: "codex-idle",
				cwd: path.join(root, "beta", "project"),
				name: "Idle thread",
				status: { type: "idle" } as v2.ThreadStatus,
				updatedAt: 50,
			}),
		];
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore({
				...emptyState(),
				sessions: [
					{
						discordThreadId: "task-linked",
						parentChannelId: "task-channel",
						codexThreadId: "codex-active-linked",
						title: "Linked active",
						createdAt: "2026-05-14T11:00:00.000Z",
						cwd: path.join(root, "alpha", "project"),
						mode: "workspace",
					},
				],
			}),
			config: testConfig({
				cwd: root,
				workspace: {
					homeChannelId: "home-channel",
					workspaceForumChannelId: "workspace-forum",
					taskThreadsChannelId: "task-channel",
				},
			}),
		});

		try {
			await bridge.start();
			const replies: string[] = [];
			transport.emit({
				kind: "status",
				channelId: "home-channel",
				author: { id: "user-1", name: "Peezy", isBot: false },
				createdAt: "2026-05-14T12:00:00.000Z",
				reply: async (text) => {
					replies.push(text);
				},
				replyPicker: transport.threadsReplyPicker(),
			});

			await waitFor(() => transport.ephemeralPickers.length === 1);
			expect(replies).toEqual([]);
			const picker = transport.ephemeralPickers[0];
			expect(picker?.text).toContain("**Active Codex Threads**");
			expect(picker?.text).toContain("<#task-linked> Linked active (active)");
			expect(picker?.text).toContain("1️⃣ `not opened` Missing active (active)");
			expect(picker?.text).not.toContain("Idle thread");
			expect(picker?.options).toEqual([{ id: "0", label: "1" }]);

			transport.emitThreadPicker({
				pickerId: picker?.pickerId ?? "",
				optionId: "0",
			});
			await waitFor(() => transport.createdThreads.length === 1);
			expect(client.resumeThreadCalls.some((call) =>
				call.threadId === "codex-active-missing"
			)).toBe(true);
			expect(transport.createdThreads[0]).toEqual({
				channelId: "task-channel",
				name: "beta: Missing active",
				sourceMessageId: undefined,
			});
			expect(transport.ephemeralUpdates.some((update) =>
				update.pickerId === picker?.pickerId &&
				update.text === "Opened Missing active: <#discord-thread-1>"
			)).toBe(true);
		} finally {
			await bridge.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("multi-guild workspace surfaces scope workspaces, status, hooks, and home delivery", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "discord-surfaces-"));
		const hookSpoolDir = await testHookSpoolDir();
		const alphaCwd = path.join(root, "alpha", "project");
		const cryptoWorkspace = path.join(root, "crypto-workspace");
		const cryptoCwd = path.join(cryptoWorkspace, "project");
		await mkdir(alphaCwd, { recursive: true });
		await mkdir(cryptoCwd, { recursive: true });
		const client = new FakeCodexClient();
		client.threads = [
			testThread({
				id: "codex-alpha-active",
				cwd: alphaCwd,
				name: "Alpha active",
				status: { type: "active" } as v2.ThreadStatus,
				updatedAt: 20,
			}),
			testThread({
				id: "codex-crypto-active",
				cwd: cryptoCwd,
				name: "Crypto active",
				status: { type: "active" } as v2.ThreadStatus,
				updatedAt: 30,
			}),
		];
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				cwd: root,
				workspace: {
					homeChannelId: "home-default",
					workspaceForumChannelId: "forum-default",
					taskThreadsChannelId: "tasks-default",
					surfaces: [
						{
							key: "default",
							homeChannelId: "home-default",
							workspaceForumChannelId: "forum-default",
							taskThreadsChannelId: "tasks-default",
						},
						{
							key: "crypto",
							homeChannelId: "home-crypto",
							workspaceForumChannelId: "forum-crypto",
							taskThreadsChannelId: "tasks-crypto",
							workspaceCwds: [cryptoWorkspace],
						},
					],
				},
				hookSpoolDir,
			}),
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		});

		try {
			await bridge.start();
			expect(transport.createdForumPosts).toEqual([
				expect.objectContaining({
					channelId: "forum-default",
					name: "alpha",
					threadId: "forum-post-1",
				}),
				expect.objectContaining({
					channelId: "forum-crypto",
					name: "crypto-workspace",
					threadId: "forum-post-2",
				}),
			]);
			expect(bridge.stateForTest().workspace?.workspaces).toEqual([
				expect.objectContaining({
					cwd: path.join(root, "alpha"),
					surfaceKey: "default",
				}),
				expect.objectContaining({
					cwd: cryptoWorkspace,
					surfaceKey: "crypto",
				}),
			]);
			expect(transport.registeredCommands).toEqual([
				{
					channelIds: [
						"parent-channel",
						"home-default",
						"forum-default",
						"tasks-default",
						"home-crypto",
						"forum-crypto",
						"tasks-crypto",
					],
				},
			]);

			transport.emit({
				kind: "status",
				channelId: "home-crypto",
				author: { id: "user-1", name: "Peezy", isBot: false },
				createdAt: "2026-05-14T12:00:30.000Z",
				reply: async () => {},
				replyPicker: transport.threadsReplyPicker(),
			});
			await waitFor(() => transport.ephemeralPickers.length === 1);
			const statusPicker = transport.ephemeralPickers[0];
			expect(statusPicker?.text).toContain("Surface: `crypto`");
			expect(statusPicker?.text).toContain("1️⃣ `not opened` Crypto active (active)");
			expect(statusPicker?.text).not.toContain("Alpha active");

			transport.emitThreadPicker({
				pickerId: statusPicker?.pickerId ?? "",
				optionId: "0",
			});
			await waitFor(() => transport.createdThreads.length === 1);
			expect(transport.createdThreads[0]).toEqual({
				channelId: "tasks-crypto",
				name: "crypto-workspace: Crypto active",
				sourceMessageId: undefined,
			});
			expect(bridge.stateForTest().sessions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						discordThreadId: "discord-thread-1",
						parentChannelId: "tasks-crypto",
						codexThreadId: "codex-crypto-active",
						surfaceKey: "crypto",
					}),
				]),
			);

			await emitHookEvent(hookSpoolDir, {
				eventName: "UserPromptSubmit",
				sessionId: "codex-crypto-observed",
				turnId: "turn-crypto-observed",
				cwd: cryptoCwd,
				prompt: "Watch the crypto workspace.",
			});
			await waitFor(() =>
				bridge.stateForTest().workspace?.observedThreads?.some((thread) =>
					thread.threadId === "codex-crypto-observed" &&
					thread.surfaceKey === "crypto" &&
					thread.status === "active"
				) ?? false
			);
			expect(transport.updatedMessages.some((message) =>
				message.channelId === "forum-post-2" &&
				message.text.includes("Watch the crypto workspace.")
			)).toBe(true);
			expect(transport.updatedMessages.some((message) =>
				message.channelId === "forum-post-1" &&
				message.text.includes("Watch the crypto workspace.")
			)).toBe(false);

			transport.emit({
				kind: "threads",
				channelId: "forum-post-2",
				author: { id: "user-1", name: "Peezy", isBot: false },
				createdAt: "2026-05-14T12:00:45.000Z",
				reply: async () => {},
				replyPicker: transport.threadsReplyPicker(),
			});
			await waitFor(() => transport.ephemeralPickers.length === 2);
			expect(transport.ephemeralPickers[1]?.text).toContain("Crypto active");
			expect(transport.ephemeralPickers[1]?.text).toContain(
				"Watch the crypto workspace.",
			);
			expect(transport.ephemeralPickers[1]?.text).not.toContain("Alpha active");

			client.threadGoals.set("codex-crypto-active", {
				threadId: "codex-crypto-active",
				objective: "Manage crypto workspace goals",
				status: "active",
				tokenBudget: null,
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 1,
				updatedAt: 1,
			});
			transport.emit({
				kind: "goals",
				channelId: "forum-post-2",
				author: { id: "user-1", name: "Peezy", isBot: false },
				createdAt: "2026-05-14T12:00:50.000Z",
				reply: async () => {},
				replyPicker: transport.threadsReplyPicker(),
			});
			await waitFor(() => transport.ephemeralPickers.length === 3);
			expect(transport.ephemeralPickers[2]?.text).toContain(
				"Manage crypto workspace goals",
			);
			expect(transport.ephemeralPickers[2]?.text).not.toContain("Alpha active");

			transport.emit({
				kind: "message",
				channelId: "home-crypto",
				messageId: "home-crypto-message",
				author: { id: "user-1", name: "Peezy", isBot: false },
				content: "hello from crypto guild",
				createdAt: "2026-05-14T12:01:00.000Z",
			});
			await waitFor(() => client.startTurnCalls.length === 1);
			expect(inputText(client.startTurnCalls[0]?.input[0])).toContain(
				"Surface: crypto",
			);
			expect(inputText(client.startTurnCalls[0]?.input[0])).toContain(
				"Home channel: home-crypto",
			);

			client.emitNotification({
				method: "item/completed",
				params: {
					threadId: "codex-thread-1",
					turnId: "turn-1",
					item: {
						id: "message-crypto-final",
						type: "agentMessage",
						text: "Crypto workspace answer.",
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
						status: "completed",
						items: [],
					},
				},
			});
			await waitFor(() =>
				transport.messages.some((message) =>
					message.channelId === "home-crypto" &&
					message.text === "Crypto workspace answer."
				)
			);
			expect(transport.messages.some((message) =>
				message.channelId === "home-default" &&
				message.text === "Crypto workspace answer."
			)).toBe(false);
		} finally {
			await bridge.stop();
			await rm(hookSpoolDir, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		}
	});

	test("goals command manages thread goals from workspace forum posts", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "discord-goals-"));
		await mkdir(path.join(root, "alpha", "project"), { recursive: true });
		const client = new FakeCodexClient();
		client.threads = [
			testThread({
				id: "codex-goal",
				cwd: path.join(root, "alpha", "project"),
				name: "Goal thread",
				updatedAt: 30,
			}),
		];
		client.threadGoals.set("codex-goal", {
			threadId: "codex-goal",
			objective: "Ship goal management",
			status: "active",
			tokenBudget: null,
			tokensUsed: 42,
			timeUsedSeconds: 9,
			createdAt: 1,
			updatedAt: 2,
		});
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				cwd: root,
				workspace: {
					homeChannelId: "home-channel",
					workspaceForumChannelId: "workspace-forum",
					taskThreadsChannelId: "task-channel",
				},
			}),
		});

		try {
			await bridge.start();
			expect(transport.createdForumPosts.map((post) => post.name)).toEqual([
				"alpha",
			]);

			const replies: string[] = [];
			transport.emit({
				kind: "goals",
				channelId: "task-channel",
				author: { id: "user-1", name: "Peezy", isBot: false },
				createdAt: "2026-05-15T00:00:00.000Z",
				reply: async (text) => {
					replies.push(text);
				},
				replyPicker: transport.threadsReplyPicker(),
			});
			await waitFor(() => replies.length === 1);
			expect(replies[0]).toBe(
				"Run `/goals` in a workspace forum post or opened Codex thread.",
			);

			transport.emit({
				kind: "goals",
				channelId: "forum-post-1",
				author: { id: "user-1", name: "Peezy", isBot: false },
				createdAt: "2026-05-15T00:00:01.000Z",
				reply: async (text) => {
					replies.push(text);
				},
				replyPicker: transport.threadsReplyPicker(),
			});
			await waitFor(() => transport.ephemeralPickers.length === 1);
			const picker = transport.ephemeralPickers[0];
			expect(picker?.text).toContain("**Goals: alpha**");
			expect(picker?.text).toContain("1️⃣ `not opened` Goal thread - `active` Ship goal management");
			expect(picker?.options).toEqual([{ id: "0", label: "1" }]);

			transport.emitThreadPicker({
				pickerId: picker?.pickerId ?? "",
				optionId: "0",
			});
			await waitFor(() => transport.ephemeralPickers.length === 2);
			const actionPicker = transport.ephemeralPickers[1];
			expect(actionPicker?.text).toContain("**Goal: Goal thread**");
			expect(actionPicker?.text).toContain("Goal: `active` Ship goal management");
			expect(actionPicker?.options).toEqual([
				{ id: "open", label: "Open" },
				{ id: "status:paused", label: "Pause" },
				{ id: "status:complete", label: "Complete" },
				{ id: "clear", label: "Clear" },
			]);

			transport.emitThreadPicker({
				pickerId: actionPicker?.pickerId ?? "",
				optionId: "status:complete",
			});
			await waitFor(() => client.setThreadGoalCalls.length === 1);
			expect(client.setThreadGoalCalls[0]).toEqual({
				threadId: "codex-goal",
				status: "complete",
			});
			await waitFor(() => transport.ephemeralPickers.length === 3);
			expect(transport.ephemeralPickers[2]?.text).toContain(
				"Set goal status to complete.",
			);
			expect(transport.ephemeralPickers[2]?.text).toContain(
				"Goal: `complete` Ship goal management",
			);
		} finally {
			await bridge.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("goals command manages the current Discord thread goal", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "discord-thread-goals-"));
		const cwd = path.join(root, "alpha", "project");
		await mkdir(cwd, { recursive: true });
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore({
				...emptyState(),
				sessions: [
					{
						discordThreadId: "task-goal",
						parentChannelId: "task-channel",
						codexThreadId: "codex-thread-goal",
						title: "Goal task",
						createdAt: "2026-05-14T11:00:00.000Z",
						cwd,
						mode: "workspace",
					},
				],
			}),
			config: testConfig({
				cwd: root,
				workspace: {
					homeChannelId: "home-channel",
					workspaceForumChannelId: "workspace-forum",
					taskThreadsChannelId: "task-channel",
				},
			}),
		});

		try {
			await bridge.start();

			const replies: string[] = [];
			transport.emit({
				kind: "goals",
				channelId: "task-goal",
				author: { id: "user-1", name: "Peezy", isBot: false },
				createdAt: "2026-05-15T00:00:00.000Z",
				objective: "Improve delegation CRUD",
				goalStatus: "active",
				tokenBudget: 1234,
				reply: async (text) => {
					replies.push(text);
				},
				replyPicker: transport.threadsReplyPicker(),
			});
			await waitFor(() => client.setThreadGoalCalls.length === 1);
			expect(client.setThreadGoalCalls[0]).toEqual({
				threadId: "codex-thread-goal",
				objective: "Improve delegation CRUD",
				status: "active",
				tokenBudget: 1234,
			});
			await waitFor(() => transport.ephemeralPickers.length === 1);
			expect(transport.ephemeralPickers[0]?.text).toContain("Saved goal.");
			expect(transport.ephemeralPickers[0]?.text).toContain(
				"Goal: `active` Improve delegation CRUD",
			);

			transport.emit({
				kind: "goals",
				channelId: "task-goal",
				author: { id: "user-1", name: "Peezy", isBot: false },
				createdAt: "2026-05-15T00:00:01.000Z",
				reply: async (text) => {
					replies.push(text);
				},
				replyPicker: transport.threadsReplyPicker(),
			});
			await waitFor(() => transport.ephemeralPickers.length === 2);
			const picker = transport.ephemeralPickers[1];
			expect(picker?.text).toContain("**Goal: Goal task**");
			expect(picker?.text).toContain("Thread: <#task-goal> `codex-thread-goal`");
			expect(picker?.options).toEqual([
				{ id: "status:paused", label: "Pause" },
				{ id: "status:complete", label: "Complete" },
				{ id: "clear", label: "Clear" },
			]);

			transport.emitThreadPicker({
				pickerId: picker?.pickerId ?? "",
				optionId: "status:complete",
			});
			await waitFor(() => client.setThreadGoalCalls.length === 2);
			expect(client.setThreadGoalCalls[1]).toEqual({
				threadId: "codex-thread-goal",
				status: "complete",
			});
			await waitFor(() => transport.ephemeralPickers.length === 3);
			expect(transport.ephemeralPickers[2]?.text).toContain(
				"Set goal status to complete.",
			);

			transport.emit({
				kind: "goals",
				channelId: "task-goal",
				author: { id: "user-1", name: "Peezy", isBot: false },
				createdAt: "2026-05-15T00:00:02.000Z",
				clear: true,
				reply: async (text) => {
					replies.push(text);
				},
				replyPicker: transport.threadsReplyPicker(),
			});
			await waitFor(() => client.clearThreadGoalCalls.length === 1);
			expect(client.clearThreadGoalCalls[0]).toEqual({
				threadId: "codex-thread-goal",
			});
			await waitFor(() => replies.includes("Cleared goal for Goal task."));
		} finally {
			await bridge.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	test("resumes a configured workspace main thread without creating Discord threads", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				workspace: {
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
				mode: "operator",
			}),
		);
		await bridge.stop();
	});

	test("replaces stale persisted workspace sessions when no main thread is configured", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore({
			...emptyState(),
			workspace: {
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
					title: "Codex Workspace",
					createdAt: "2026-05-13T00:00:00.000Z",
					cwd: "/workspace",
					mode: "workspace",
				},
			],
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
			}),
		});

		await bridge.start();
		await waitFor(() => bridge.stateForTest().workspace?.mainThreadId === "codex-thread-1");

		expect(client.resumeThreadCalls).toEqual([]);
		expect(client.startThreadCalls).toHaveLength(1);
		expect(client.startThreadCalls[0]?.dynamicTools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ namespace: "codex_workspace" }),
			]),
		);
		expect(bridge.stateForTest().sessions.filter((session) =>
			session.mode === "operator"
		)).toEqual([
			expect.objectContaining({
				codexThreadId: "codex-thread-1",
			}),
		]);
		expect(bridge.stateForTest().workspace).toEqual(
			expect.objectContaining({
				mainThreadId: "codex-thread-1",
				toolsVersion: 1,
			}),
		);
		await bridge.stop();
	});

	test("recreates a tool-enabled workspace session when resume reports thread not found", async () => {
		const client = new FakeCodexClient();
		client.failedResumeThreadIds.add("missing-codex-thread");
		const transport = new FakeDiscordTransport();
		const store = new MemoryStateStore({
			...emptyState(),
			workspace: {
				homeChannelId: "home-channel",
				mainThreadId: "missing-codex-thread",
				createdAt: "2026-05-13T00:00:00.000Z",
				toolsVersion: 1,
				delegations: [],
			},
			sessions: [
				{
					discordThreadId: "home-channel",
					parentChannelId: "home-channel",
					codexThreadId: "missing-codex-thread",
					title: "Codex Workspace",
					createdAt: "2026-05-13T00:00:00.000Z",
					cwd: "/workspace",
					mode: "workspace",
				},
			],
		});
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store,
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
			}),
		});

		await bridge.start();
		await waitFor(() => bridge.stateForTest().workspace?.mainThreadId === "codex-thread-1");

		expect(client.resumeThreadCalls[0]).toEqual(
			expect.objectContaining({ threadId: "missing-codex-thread" }),
		);
		expect(client.startThreadCalls).toHaveLength(1);
		expect(client.startThreadCalls[0]?.dynamicTools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ namespace: "codex_workspace" }),
			]),
		);
		expect(bridge.stateForTest().workspace).toEqual(
			expect.objectContaining({
				mainThreadId: "codex-thread-1",
				toolsVersion: 1,
			}),
		);
		expect(bridge.stateForTest().sessions.filter((session) =>
			session.mode === "operator"
		)).toEqual([
			expect.objectContaining({
				codexThreadId: "codex-thread-1",
			}),
		]);
		await bridge.stop();
	});

	test("routes bot mentions in the home channel to the workspace instead of creating threads", async () => {
		const client = new FakeCodexClient();
		const transport = new FakeDiscordTransport();
		const bridge = new DiscordCodexBridge({
			client,
			transport,
			store: new MemoryStateStore(),
			config: testConfig({
				workspace: { homeChannelId: "home-channel" },
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

async function testHookSpoolDir(): Promise<string> {
	return await mkdtemp(path.join(os.tmpdir(), "discord-bridge-hooks-"));
}

async function emitHookEvent(
	spoolDir: string,
	input: {
		eventName: string;
		sessionId: string;
		turnId?: string;
		cwd?: string;
		prompt?: string;
		toolName?: string;
		toolInput?: unknown;
		lastAssistantMessage?: string;
	},
): Promise<void> {
	await writeStopHookSpoolEvent(
		{
			hook_event_name: input.eventName,
			session_id: input.sessionId,
			turn_id: input.turnId,
			cwd: input.cwd ?? "/workspace",
			transcript_path: `/tmp/${input.sessionId}.jsonl`,
			prompt: input.prompt,
			tool_name: input.toolName,
			tool_input: input.toolInput,
			last_assistant_message: input.lastAssistantMessage ?? null,
		},
		{
			spoolDir,
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		},
	);
}

async function emitStopHook(
	spoolDir: string,
	input: {
		sessionId: string;
		turnId: string;
		lastAssistantMessage?: string;
		cwd?: string;
	},
): Promise<void> {
	await writeStopHookSpoolEvent(
		{
			hook_event_name: "Stop",
			session_id: input.sessionId,
			turn_id: input.turnId,
			cwd: input.cwd ?? "/workspace",
			transcript_path: `/tmp/${input.sessionId}.jsonl`,
			last_assistant_message: input.lastAssistantMessage ?? null,
		},
		{
			spoolDir,
			now: () => new Date("2026-05-14T12:00:00.000Z"),
		},
	);
}

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

function testWorkspaceKey(cwd: string): string {
	return `workspace-${createHash("sha256").update(cwd).digest("hex").slice(0, 12)}`;
}

function testThread(input: {
	id: string;
	cwd: string;
	name?: string;
	preview?: string;
	updatedAt?: number;
	status?: v2.ThreadStatus;
}): v2.Thread {
	return {
		id: input.id,
		sessionId: input.id,
		forkedFromId: null,
		preview: input.preview ?? input.name ?? input.id,
		ephemeral: false,
		modelProvider: "openai",
		createdAt: input.updatedAt ?? 1,
		updatedAt: input.updatedAt ?? 1,
		status: input.status ?? { type: "idle" },
		path: null,
		cwd: input.cwd,
		cliVersion: "test",
		source: "cli",
		threadSource: null,
		agentNickname: null,
		agentRole: null,
		gitInfo: null,
		name: input.name ?? null,
		turns: [],
	} as v2.Thread;
}

class FakeFlowBackendClient implements FlowBackendClient {
	listRunsCalls: Array<{ eventId?: string; status?: string; limit?: number }> = [];
	listEventsCalls: Array<{ type?: string; limit?: number }> = [];

	async listRuns(options: { eventId?: string; status?: string; limit?: number } = {}) {
		this.listRunsCalls.push(options);
		return {
			eventId: options.eventId,
			runs: [
				{
					id: "run-1",
					eventId: options.eventId,
					flowName: "openai-codex-bindings",
					stepName: "regenerate-bindings",
					processStatus: "completed",
					resultStatus: "blocked" as const,
					status: "blocked",
					effectiveStatus: "blocked",
					needsAttention: true,
					attemptCount: 1,
					attempts: [],
					output: [],
					raw: {},
				},
			],
			raw: {},
		};
	}

	async getRun(): Promise<never> {
		throw new Error("getRun should not be called by Discord flow inspection");
	}

	async listEvents(options: { type?: string; limit?: number } = {}) {
		this.listEventsCalls.push(options);
		return {
			events: [
				{
					id: "event-1",
					type: options.type,
					receivedAt: "2026-05-15T00:00:00.000Z",
					runIds: ["run-1"],
					runs: [],
					raw: {},
				},
			],
			raw: {},
		};
	}

	async getEvent(): Promise<never> {
		throw new Error("getEvent should not be called by Discord flow inspection");
	}

	async dispatchEvent(): Promise<never> {
		throw new Error("dispatchEvent should not be exposed through Discord in this increment");
	}

	async replayEvent(): Promise<never> {
		throw new Error("replayEvent should not be exposed through Discord in this increment");
	}

	async cancelRun(): Promise<never> {
		throw new Error("cancelRun should not be exposed through Discord in this increment");
	}
}

class FakeCodexClient implements CodexBridgeClient {
	startThreadCalls: v2.ThreadStartParams[] = [];
	resumeThreadCalls: v2.ThreadResumeParams[] = [];
	setThreadNameCalls: v2.ThreadSetNameParams[] = [];
	startTurnCalls: v2.TurnStartParams[] = [];
	steerTurnCalls: v2.TurnSteerParams[] = [];
	readThreadCalls: v2.ThreadReadParams[] = [];
	injectThreadItemsCalls: v2.ThreadInjectItemsParams[] = [];
	listThreadsCalls: v2.ThreadListParams[] = [];
	getThreadGoalCalls: v2.ThreadGoalGetParams[] = [];
	setThreadGoalCalls: v2.ThreadGoalSetParams[] = [];
	clearThreadGoalCalls: v2.ThreadGoalClearParams[] = [];
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
	threads: v2.Thread[] = [];
	failedResumeThreadIds = new Set<string>();
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
		if (this.failedResumeThreadIds.has(params.threadId)) {
			throw new Error(`thread not found: ${params.threadId}`);
		}
		const listedThread = this.threads.find((thread) => thread.id === params.threadId);
		const cwd = params.cwd ?? this.threadCwds.get(params.threadId) ??
			listedThread?.cwd ?? "/workspace";
		return {
			cwd,
			thread: listedThread ?? {
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

	async injectThreadItems(
		params: v2.ThreadInjectItemsParams,
	): Promise<v2.ThreadInjectItemsResponse> {
		this.injectThreadItemsCalls.push(params);
		return {};
	}

	async listThreads(params: v2.ThreadListParams): Promise<v2.ThreadListResponse> {
		this.listThreadsCalls.push(params);
		const cwdFilter = Array.isArray(params.cwd)
			? new Set(params.cwd)
			: params.cwd
			? new Set([params.cwd])
			: undefined;
		const filtered = this.threads.filter((thread) =>
			!cwdFilter || cwdFilter.has(thread.cwd)
		);
		return {
			data: filtered.slice(0, params.limit ?? filtered.length),
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

	async setThreadGoal(
		params: v2.ThreadGoalSetParams,
	): Promise<v2.ThreadGoalSetResponse> {
		this.setThreadGoalCalls.push(params);
		const existing = this.threadGoals.get(params.threadId);
		const goal: v2.ThreadGoal = {
			threadId: params.threadId,
			objective: params.objective ?? existing?.objective ?? "Goal",
			status: params.status ?? existing?.status ?? "active",
			tokenBudget: params.tokenBudget ?? existing?.tokenBudget ?? null,
			tokensUsed: existing?.tokensUsed ?? 0,
			timeUsedSeconds: existing?.timeUsedSeconds ?? 0,
			createdAt: existing?.createdAt ?? 1,
			updatedAt: (existing?.updatedAt ?? 1) + 1,
		};
		this.threadGoals.set(params.threadId, goal);
		return { goal };
	}

	async clearThreadGoal(
		params: v2.ThreadGoalClearParams,
	): Promise<v2.ThreadGoalClearResponse> {
		this.clearThreadGoalCalls.push(params);
		const cleared = this.threadGoals.delete(params.threadId);
		return { cleared };
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
	createdForumPosts: Array<{
		channelId: string;
		name: string;
		message: string;
		threadId: string;
		messageId: string;
	}> = [];
	messages: Array<{
		channelId: string;
		id: string;
		text: string;
		webhookId?: string;
	}> = [];
	failUpdateMessages = false;
	ephemeralPickers: DiscordEphemeralPicker[] = [];
	ephemeralUpdates: Array<{
		pickerId: string;
		text: string;
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
	addedReactions: Array<{
		channelId: string;
		messageId: string;
		reactions: string[];
	}> = [];
	registeredCommands: DiscordBridgeCommandRegistration[] = [];
	pinnedMessages: Array<{ channelId: string; messageId: string }> = [];
	typingCount = 0;

	async start(handlers: DiscordBridgeTransportHandlers): Promise<void> {
		this.handlers = handlers;
	}

	async stop(): Promise<void> {}

	async registerCommands(
		options: DiscordBridgeCommandRegistration = {},
	): Promise<void> {
		this.registeredCommands.push(options);
	}

	async createThread(
		channelId: string,
		name: string,
		sourceMessageId?: string,
	): Promise<string> {
		this.createdThreads.push({ channelId, name, sourceMessageId });
		return `discord-thread-${this.createdThreads.length}`;
	}

	async createForumPost(
		channelId: string,
		name: string,
		message: string,
	): Promise<{ threadId: string; messageId?: string }> {
		const threadId = `forum-post-${this.createdForumPosts.length + 1}`;
		const messageId = threadId;
		this.createdForumPosts.push({
			channelId,
			name,
			message,
			threadId,
			messageId,
		});
		this.messages.push({ channelId: threadId, id: messageId, text: message });
		return { threadId, messageId };
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
		if (this.failUpdateMessages) {
			throw new Error("Discord update failed");
		}
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

	async addReactions(
		channelId: string,
		messageId: string,
		reactions: string[],
	): Promise<void> {
		this.addedReactions.push({ channelId, messageId, reactions });
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

	threadsReplyPicker(): (picker: DiscordEphemeralPicker) => Promise<void> {
		return async (picker) => {
			this.ephemeralPickers.push(picker);
		};
	}

	emitThreadPicker(input: {
		pickerId: string;
		optionId: string;
		authorId?: string;
	}): void {
		this.emit({
			kind: "threadPicker",
			channelId: "ephemeral-command",
			pickerId: input.pickerId,
			optionId: input.optionId,
			author: {
				id: input.authorId ?? "user-1",
				name: "Peezy",
				isBot: false,
			},
			createdAt: "2026-05-14T12:00:00.000Z",
			update: async (text) => {
				this.ephemeralUpdates.push({ pickerId: input.pickerId, text });
			},
			reply: async (text) => {
				this.ephemeralUpdates.push({ pickerId: input.pickerId, text });
			},
			updatePicker: async (picker) => {
				this.ephemeralUpdates.push({
					pickerId: input.pickerId,
					text: picker.text,
				});
				this.ephemeralPickers.push(picker);
			},
		});
	}

	emitReaction(input: {
		channelId: string;
		messageId: string;
		emoji: string;
		authorId?: string;
	}): void {
		this.emit({
			kind: "reaction",
			channelId: input.channelId,
			messageId: input.messageId,
			emoji: input.emoji,
			author: {
				id: input.authorId ?? "user-1",
				name: "Peezy",
				isBot: false,
			},
			createdAt: "2026-05-14T12:00:00.000Z",
		});
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

function workspaceToolResult(value: unknown): unknown {
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
