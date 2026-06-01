import { describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	REMOTE_AUTOMATION_LIST_METHOD,
	REMOTE_AUTOMATION_RUN_METHOD,
	createRemoteAutomationMethods,
} from "@codex-toys/workbench";

describe("remote automation methods", () => {
	test("discover and run named automations against the remote filesystem", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "codex-toys-remote-automation-"));
		const automationRoot = path.join(root, ".codex", "automations", "gm");
		const eventRoot = path.join(root, ".codex", "events", "gm");
		await mkdir(path.join(automationRoot, "exec"), { recursive: true });
		await mkdir(eventRoot, { recursive: true });
		await writeFile(path.join(eventRoot, "manual.json"), JSON.stringify({
			kind: "manual",
			label: "morning",
		}));
		await writeFile(path.join(automationRoot, "automation.json"), JSON.stringify({
			name: "gm",
			script: "exec/gm.ts",
			prompt: "good morning",
		}));
		await writeFile(path.join(automationRoot, "exec", "gm.ts"), `
export default async function run(ctx) {
  const turn = await ctx.turn.start({
    prompt: ctx.prompt + " " + ctx.event.label
  });
  const completed = await ctx.turn.wait(turn, {
    timeoutMs: 1000,
    pollIntervalMs: 1,
    throwOnFailure: false
  });
  return {
    status: "completed",
    turn: completed
  };
}
`);
		const fake = fakeAppServer();
		const methods = createRemoteAutomationMethods({
			cwd: root,
			timeoutMs: 5_000,
			appRequest: fake.request,
		});

		const list = await methods[REMOTE_AUTOMATION_LIST_METHOD]?.({}, request(
			REMOTE_AUTOMATION_LIST_METHOD,
		));
		expect(list).toMatchObject({
			automations: [{
				name: "gm",
				manifestPath: path.join(automationRoot, "automation.json"),
				scriptPath: path.join(automationRoot, "exec", "gm.ts"),
			}],
		});

		const run = await methods[REMOTE_AUTOMATION_RUN_METHOD]?.({
			target: "gm",
			cwd: root,
			eventPath: ".codex/events/gm/manual.json",
			sandbox: "danger-full-access",
			approvalPolicy: "never",
		}, request(REMOTE_AUTOMATION_RUN_METHOD));
		expect(run).toMatchObject({
			result: {
				status: "completed",
				turn: {
					via: "workbench",
					threadId: "thread-1",
					turnId: "turn-1",
					status: "completed",
					outputText: "remote gm done",
				},
			},
		});
		expect(fake.calls).toEqual([
			expect.objectContaining({
				method: "thread/start",
				params: expect.objectContaining({
					cwd: root,
					sandbox: "danger-full-access",
					approvalPolicy: "never",
				}),
			}),
			expect.objectContaining({
				method: "turn/start",
				params: expect.objectContaining({
					threadId: "thread-1",
					cwd: root,
					approvalPolicy: "never",
				}),
			}),
			expect.objectContaining({ method: "thread/read" }),
			expect.objectContaining({ method: "thread/read" }),
		]);
	});
});

function fakeAppServer(): {
	calls: Array<{ method: string; params: unknown }>;
	request(method: string, params: unknown): Promise<unknown>;
} {
	const calls: Array<{ method: string; params: unknown }> = [];
	let reads = 0;
	return {
		calls,
		request: async (method, params) => {
			calls.push({ method, params });
			if (method === "thread/start") {
				return { thread: { id: "thread-1" } };
			}
			if (method === "turn/start") {
				return { turn: { id: "turn-1", status: "inProgress", items: [] } };
			}
			if (method === "thread/read") {
				reads += 1;
				return {
					thread: {
						id: "thread-1",
						turns: [{
							id: "turn-1",
							status: reads > 1 ? "completed" : "inProgress",
							error: null,
							items: reads > 1
								? [{
										type: "agentMessage",
										text: "remote gm done",
										phase: "final_answer",
									}]
								: [],
						}],
					},
				};
			}
			throw new Error(`Unexpected app-server method: ${method}`);
		},
	};
}

function request(method: string): {
	jsonrpc: "2.0";
	id: string;
	method: string;
	params: undefined;
} {
	return {
		jsonrpc: "2.0",
		id: "test",
		method,
		params: undefined,
	};
}
