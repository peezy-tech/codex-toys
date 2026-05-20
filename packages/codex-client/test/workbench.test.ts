import { expect, test } from "vite-plus/test";
import type { v2 } from "../src/app-server/generated/index.ts";
import {
	createThreadSnapshot,
	markProgressMessagesDelivered,
	pendingProgressMessages,
	reduceCompletedTurn,
	reduceThreadNotification,
	snapshotFromThread,
	threadGoalSetDescriptor,
	threadReadDescriptor,
	turnStartDescriptor,
} from "../src/workbench.ts";

const fixedNow = new Date("2026-05-15T00:00:00.000Z");

test("derives goal, plan, running command, activity, and final answer state", () => {
	let snapshot = createThreadSnapshot("thread-1", { now: fixedNow });
	snapshot = reduceThreadNotification(snapshot, {
		method: "thread/goal/updated",
		params: {
			threadId: "thread-1",
			turnId: null,
			goal: {
				threadId: "thread-1",
				objective: "Ship the bridge extraction",
				status: "active",
				tokenBudget: 12000,
				tokensUsed: 300,
				timeUsedSeconds: 42,
				createdAt: 1,
				updatedAt: 2,
			},
		},
	}, { now: fixedNow });
	snapshot = reduceThreadNotification(snapshot, {
		method: "turn/started",
		params: { threadId: "thread-1", turn: turn("turn-1", "inProgress") },
	}, { now: fixedNow });
	snapshot = reduceThreadNotification(snapshot, {
		method: "turn/plan/updated",
		params: {
			threadId: "thread-1",
			turnId: "turn-1",
			explanation: "Extract shared state first.",
			plan: [
				{ step: "Add workbench reducer", status: "completed" },
				{ step: "Wire bridge", status: "inProgress" },
			],
		},
	}, { now: fixedNow });
	snapshot = reduceThreadNotification(snapshot, {
		method: "item/started",
		params: {
			threadId: "thread-1",
			turnId: "turn-1",
			item: commandItem("cmd-1", "vp test", "inProgress"),
			startedAtMs: fixedNow.getTime(),
		},
	}, { now: fixedNow });
	snapshot = reduceThreadNotification(snapshot, {
		method: "item/completed",
		params: {
			threadId: "thread-1",
			turnId: "turn-1",
			item: dynamicToolItem("tool-1", "codex_workspace", "list_flow_runs", "completed"),
			completedAtMs: fixedNow.getTime(),
		},
	}, { now: fixedNow });
	snapshot = reduceThreadNotification(snapshot, {
		method: "turn/completed",
		params: {
			threadId: "thread-1",
			turn: turn("turn-1", "completed", [
				commandItem("cmd-1", "vp test", "completed", "ok"),
				agentMessage("answer-1", "Done.", "final_answer"),
			]),
		},
	}, { now: fixedNow });

	expect(snapshot.goal).toMatchObject({
		objective: "Ship the bridge extraction",
		status: "active",
		tokenBudget: 12000,
	});
	expect(snapshot.plan.steps).toEqual([
		{ step: "Add workbench reducer", status: "completed" },
		{ step: "Wire bridge", status: "inProgress" },
	]);
	expect(snapshot.runningCommands).toEqual([]);
	expect(snapshot.recentActivity).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				itemId: "cmd-1",
				kind: "command",
				status: "completed",
			}),
		]),
	);
	expect(snapshot.recentActivity).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				itemId: "tool-1",
				kind: "tool",
				label: "codex_workspace.list_flow_runs",
				status: "completed",
			}),
		]),
	);
	expect(snapshot.progress.finalAnswer).toEqual(
		expect.objectContaining({
			kind: "final",
			ready: true,
			text: "Done.",
			turnId: "turn-1",
		}),
	);
});

test("keeps summary/commentary progress separate and does not expose final early", () => {
	let snapshot = createThreadSnapshot("thread-1", { now: fixedNow });
	snapshot = reduceThreadNotification(snapshot, {
		method: "turn/started",
		params: { threadId: "thread-1", turn: turn("turn-1", "inProgress") },
	}, { now: fixedNow });
	snapshot = reduceThreadNotification(snapshot, {
		method: "item/reasoning/summaryPartAdded",
		params: {
			threadId: "thread-1",
			turnId: "turn-1",
			itemId: "reasoning-1",
			summaryIndex: 0,
		},
	}, { now: fixedNow });
	snapshot = reduceThreadNotification(snapshot, {
		method: "item/reasoning/summaryTextDelta",
		params: {
			threadId: "thread-1",
			turnId: "turn-1",
			itemId: "reasoning-1",
			summaryIndex: 0,
			delta: "Thinking through the boundary.",
		},
	}, { now: fixedNow });
	snapshot = reduceThreadNotification(snapshot, {
		method: "item/agentMessage/delta",
		params: {
			threadId: "thread-1",
			turnId: "turn-1",
			itemId: "msg-commentary",
			delta: "I am checking the backend client.",
		},
	}, { now: fixedNow });
	snapshot = reduceThreadNotification(snapshot, {
		method: "item/completed",
		params: {
			threadId: "thread-1",
			turnId: "turn-1",
			item: agentMessage("msg-commentary", "", "commentary"),
			completedAtMs: fixedNow.getTime(),
		},
	}, { now: fixedNow });
	snapshot = reduceThreadNotification(snapshot, {
		method: "item/completed",
		params: {
			threadId: "thread-1",
			turnId: "turn-1",
			item: agentMessage("msg-final", "This is the final answer.", "final_answer"),
			completedAtMs: fixedNow.getTime(),
		},
	}, { now: fixedNow });

	expect(pendingProgressMessages(snapshot, { mode: "summary" })).toEqual([]);
	expect(pendingProgressMessages(snapshot, { mode: "commentary" })).toEqual([
		expect.objectContaining({
			kind: "commentary",
			text: "I am checking the backend client.",
			ready: true,
		}),
	]);
	expect(snapshot.progress.finalAnswer).toEqual(
		expect.objectContaining({
			ready: false,
			text: "This is the final answer.",
		}),
	);

	snapshot = reduceThreadNotification(snapshot, {
		method: "turn/completed",
		params: {
			threadId: "thread-1",
			turn: turn("turn-1", "completed", [
				agentMessage("msg-final", "This is the final answer.", "final_answer"),
			]),
		},
	}, { now: fixedNow });

	expect(pendingProgressMessages(snapshot, { mode: "summary" })).toEqual([
		expect.objectContaining({
			kind: "final",
			text: "This is the final answer.",
			ready: true,
		}),
		expect.objectContaining({
			kind: "summary",
			text: "Thinking through the boundary.",
			ready: true,
		}),
	]);

	const delivered = markProgressMessagesDelivered(
		snapshot,
		pendingProgressMessages(snapshot, { mode: "summary" }).map((message) => message.id),
		{ now: fixedNow },
	);
	expect(pendingProgressMessages(delivered, { mode: "summary" })).toEqual([]);
});

test("preserves current app-server thread goal statuses", () => {
	for (const status of ["blocked", "usageLimited"] satisfies v2.ThreadGoalStatus[]) {
		const snapshot = reduceThreadNotification(
			createThreadSnapshot("thread-1", { now: fixedNow }),
			{
				method: "thread/goal/updated",
				params: {
					threadId: "thread-1",
					turnId: null,
					goal: {
						threadId: "thread-1",
						objective: `Goal is ${status}`,
						status,
						tokenBudget: null,
						tokensUsed: 0,
						timeUsedSeconds: 0,
						createdAt: 1,
						updatedAt: 2,
					},
				},
			},
			{ now: fixedNow },
		);

		expect(snapshot.goal).toMatchObject({ status });
	}
});

test("derives snapshots from completed thread payloads", () => {
	const snapshot = snapshotFromThread(thread("thread-1", [
		turn("turn-1", "completed", [
			agentMessage("answer-1", "Final from loaded turn.", "final_answer"),
			dynamicToolItem("tool-1", null, "read_delegation", "completed"),
		]),
	]), { now: fixedNow });

	expect(snapshot.turnStatus).toBe("completed");
	expect(snapshot.progress.finalAnswer?.text).toBe("Final from loaded turn.");
	expect(snapshot.recentActivity[0]).toMatchObject({
		kind: "tool",
		label: "read_delegation",
	});
});

test("action descriptors return method and params without executing requests", () => {
	expect(threadGoalSetDescriptor({
		threadId: "thread-1",
		objective: "Keep the boundary clear",
		status: "active",
		tokenBudget: 5000,
	})).toEqual({
		method: "thread/goal/set",
		params: {
			threadId: "thread-1",
			objective: "Keep the boundary clear",
			status: "active",
			tokenBudget: 5000,
		},
	});
	expect(threadReadDescriptor({ threadId: "thread-1", includeTurns: true })).toEqual({
		method: "thread/read",
		params: { threadId: "thread-1", includeTurns: true },
	});
	expect(turnStartDescriptor({
		threadId: "thread-1",
		input: [{ type: "text", text: "continue", text_elements: [] }],
	})).toEqual({
		method: "turn/start",
		params: {
			threadId: "thread-1",
			input: [{ type: "text", text: "continue", text_elements: [] }],
		},
	});
});

function thread(id: string, turns: v2.Turn[] = []): v2.Thread {
	return {
		id,
		sessionId: `${id}-session`,
		forkedFromId: null,
		preview: "preview",
		ephemeral: false,
		modelProvider: "openai",
		createdAt: 1,
		updatedAt: 2,
		status: { type: "idle" },
		path: null,
		cwd: "/workspace",
		cliVersion: "0.0.0",
		source: "appServer",
		threadSource: null,
		agentNickname: null,
		agentRole: null,
		gitInfo: null,
		name: null,
		turns,
	};
}

function turn(
	id: string,
	status: v2.TurnStatus,
	items: v2.ThreadItem[] = [],
): v2.Turn {
	return {
		id,
		items,
		itemsView: "full",
		status,
		error: null,
		startedAt: 1,
		completedAt: status === "inProgress" ? null : 2,
		durationMs: status === "inProgress" ? null : 1000,
	};
}

function agentMessage(
	id: string,
	text: string,
	phase: "commentary" | "final_answer" | null,
): v2.ThreadItem {
	return {
		type: "agentMessage",
		id,
		text,
		phase,
		memoryCitation: null,
	};
}

function commandItem(
	id: string,
	command: string,
	status: v2.CommandExecutionStatus,
	aggregatedOutput: string | null = null,
): v2.ThreadItem {
	return {
		type: "commandExecution",
		id,
		command,
		cwd: "/workspace",
		processId: `process-${id}`,
		source: "agent",
		status,
		commandActions: [],
		aggregatedOutput,
		exitCode: status === "completed" ? 0 : null,
		durationMs: status === "completed" ? 50 : null,
	};
}

function dynamicToolItem(
	id: string,
	namespace: string | null,
	tool: string,
	status: v2.DynamicToolCallStatus,
): v2.ThreadItem {
	return {
		type: "dynamicToolCall",
		id,
		namespace,
		tool,
		arguments: {},
		status,
		contentItems: null,
		success: status === "completed" ? true : null,
		durationMs: status === "completed" ? 20 : null,
	};
}
