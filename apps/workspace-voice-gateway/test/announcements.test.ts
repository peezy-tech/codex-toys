import { describe, expect, test } from "vite-plus/test";

import type { JsonRpcNotification } from "@peezy.tech/codex-flows/rpc";
import {
	draftFromNotification,
	draftFromWorkspaceEvent,
	finalTextFromTurn,
} from "../src/announcements.ts";

const policy = {
	announceBackendConnected: true,
	announceTurnStarted: false,
};

describe("announcement extraction", () => {
	test("announces backend connection when enabled", () => {
		const draft = draftFromWorkspaceEvent({
			type: "connected",
			at: "2026-05-16T00:00:00.000Z",
		}, policy);
		expect(draft?.text).toBe("Workspace backend connected.");
		expect(draft?.priority).toBe("low");
	});

	test("extracts final turn text and removes speech-hostile formatting", () => {
		const message: JsonRpcNotification = {
			jsonrpc: "2.0",
			method: "turn/completed",
			params: {
				threadId: "thread-1",
				turn: {
					id: "turn-1",
					status: "completed",
					durationMs: 1200,
					error: null,
					items: [
						{
							type: "agentMessage",
							id: "m1",
							phase: "commentary",
							text: "Still working",
						},
						{
							type: "agentMessage",
							id: "m2",
							phase: "final_answer",
							text: "Implemented `voice gateway`. See https://example.com.\n```txt\nlogs\n```",
						},
					],
				},
			},
		};
		const draft = draftFromNotification(message, policy);
		expect(draft?.kind).toBe("turn.completed");
		expect(draft?.turnCompletion?.finalText).toContain("Implemented");
		expect(draft?.text).toBe("Workspace turn completed. Implemented voice gateway. See code block");
	});

	test("ignores announcer thread notifications", () => {
		const draft = draftFromNotification({
			jsonrpc: "2.0",
			method: "turn/started",
			params: { threadId: "announcer", turn: { id: "turn-1" } },
		}, {
			...policy,
			announceTurnStarted: true,
			ignoredThreadIds: new Set(["announcer"]),
		});
		expect(draft).toBeUndefined();
	});

	test("announces failed hooks and turn errors", () => {
		const hook = draftFromNotification({
			jsonrpc: "2.0",
			method: "hook/completed",
			params: {
				threadId: "thread-1",
				run: {
					id: "hook-1",
					eventName: "turn-completed",
					status: "failed",
					statusMessage: "post hook failed",
				},
			},
		}, policy);
		expect(hook?.priority).toBe("high");
		expect(hook?.text).toBe("Codex turn-completed hook failed. post hook failed");
	});
});

describe("finalTextFromTurn", () => {
	test("uses the last non-commentary agent message", () => {
		expect(finalTextFromTurn({
			items: [
				{ type: "agentMessage", id: "one", phase: "final_answer", text: "first" },
				{ type: "agentMessage", id: "two", phase: "commentary", text: "progress" },
				{ type: "agentMessage", id: "three", phase: null, text: "last" },
			],
		})).toBe("last");
	});
});
