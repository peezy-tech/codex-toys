import { describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	listWorkflows,
	parseWorkflowResult,
	resolveWorkflowTarget,
	runWorkflowScript,
	waitWorkflowTurnWithRequest,
} from "@codex-toys/workbench";

describe("workflow", () => {
	test("treats action-shaped module returns as plain JSON results", () => {
		expect(parseWorkflowResult(
			`WORKFLOW_MODULE_RESULT ${JSON.stringify({ action: "ignored" })}\n`,
		)).toEqual({
			result: { action: "ignored" },
		});
	});

	test("runs module-style scripts and passes prompt context", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "codex-toys-workflow-"));
		const scriptPath = path.join(dir, "check.ts");
		await writeFile(scriptPath, `
export default function run(context) {
  return {
    status: "ready",
    promptText: context.prompt + " for " + context.event.payload.tag,
    cwd: context.cwd,
    skills: ["release-operator"]
  };
}
`);
		const run = await runWorkflowScript({
			scriptPath,
			event: { type: "upstream.release", payload: { tag: "v1.2.3" } },
			prompt: "inspect",
			cwd: "/repo",
			timeoutMs: 5_000,
		});
		expect(run.result).toEqual({
			status: "ready",
			promptText: "inspect for v1.2.3",
			cwd: "/repo",
			skills: ["release-operator"],
		});
	});

	test("runs inline workflow source with inline context metadata", async () => {
		const run = await runWorkflowScript({
			script: `
export default function run(context) {
  return {
    status: "ready",
    sourceKind: context.workflow.sourceKind,
    scriptPath: context.workflow.scriptPath
  };
}
`,
			timeoutMs: 5_000,
		});
		expect(run.result).toEqual({
			status: "ready",
			sourceKind: "inline",
		});
		expect(run.context.workflow.sourceKind).toBe("inline");
		expect(run.context.workflow.scriptPath).toBeUndefined();
	});

	test("requires exactly one workflow script source", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "codex-toys-workflow-source-"));
		const scriptPath = path.join(dir, "check.ts");
		await writeFile(scriptPath, "export default () => ({ status: 'ok' });");
		await expect(runWorkflowScript({
			scriptPath,
			script: "export default () => ({ status: 'ok' });",
			timeoutMs: 5_000,
		})).rejects.toThrow("exactly one script source");
		await expect(runWorkflowScript({
			timeoutMs: 5_000,
		})).rejects.toThrow("exactly one script source");
	});

	test("runs module scripts with a programmable host API", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "codex-toys-workflow-host-"));
		const scriptPath = path.join(dir, "check.ts");
		await writeFile(scriptPath, `
export default async function run(ctx) {
  const echo = await ctx.app.call("demo.echo", { tag: ctx.event.payload.tag });
  return {
    status: "completed",
    echo
  };
}
`);
		const run = await runWorkflowScript({
			scriptPath,
			event: { type: "upstream.release", payload: { tag: "v1.2.3" } },
			timeoutMs: 5_000,
			host: async (call) => {
				expect(call).toEqual({
					method: "app.call",
					params: {
						method: "demo.echo",
						params: { tag: "v1.2.3" },
					},
				});
				return { ok: true, tag: "v1.2.3" };
			},
		});
		expect(run.result).toEqual({
			status: "completed",
			echo: { ok: true, tag: "v1.2.3" },
		});
	});

	test("retries transient empty rollout reads while waiting for a turn", async () => {
		let reads = 0;
		const snapshot = await waitWorkflowTurnWithRequest(
			"app-server",
			async (method, params) => {
				expect(method).toBe("thread/read");
				expect(params).toEqual({
					threadId: "thread-1",
					includeTurns: true,
				});
				reads += 1;
				if (reads === 1) {
					throw new Error("failed to read thread: thread-store internal error: failed to read thread /tmp/rollout.jsonl: rollout at /tmp/rollout.jsonl is empty");
				}
				return {
					thread: {
						turns: [{
							id: "turn-1",
							status: "completed",
							items: [{
								type: "agentMessage",
								phase: "final_answer",
								text: "analysis complete",
							}],
						}],
					},
				};
			},
			{ threadId: "thread-1", turnId: "turn-1" },
			{ timeoutMs: 100, pollIntervalMs: 1 },
		);
		expect(reads).toBe(2);
		expect(snapshot).toMatchObject({
			threadId: "thread-1",
			turnId: "turn-1",
			status: "completed",
			outputText: "analysis complete",
		});
	});

	test("fails module-style scripts that throw", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "codex-toys-workflow-"));
		const scriptPath = path.join(dir, "check.ts");
		await writeFile(scriptPath, `
export default function run() {
  throw new Error("boom");
}
`);
		await expect(runWorkflowScript({
			scriptPath,
			timeoutMs: 5_000,
		})).rejects.toThrow("boom");
	});

	test("discovers named workflow manifests", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "codex-toys-workflow-root-"));
		const workflowRoot = path.join(root, "workflows", "release-check");
		await mkdir(workflowRoot, { recursive: true });
		await writeFile(path.join(workflowRoot, "check.ts"), "export default () => ({ status: 'skipped' });");
		await writeFile(path.join(workflowRoot, "prompt.md"), "Inspect the release.\n");
		await writeFile(path.join(workflowRoot, "workflow.json"), JSON.stringify({
			name: "release-check",
			description: "Check upstream releases",
			script: "check.ts",
			promptFile: "prompt.md",
			cwd: "../repo",
			skills: ["workflow-author"],
			timeoutMs: 123456,
		}));
		const workflows = await listWorkflows({ cwd: root });
		expect(workflows).toHaveLength(1);
		expect(workflows[0]).toMatchObject({
			name: "release-check",
			prompt: "Inspect the release.\n",
			skills: ["workflow-author"],
			timeoutMs: 123456,
		});
		const target = await resolveWorkflowTarget("release-check", { cwd: root });
		expect(target).toMatchObject({
			prompt: "Inspect the release.\n",
			skills: ["workflow-author"],
			timeoutMs: 123456,
		});
		expect(target.scriptPath).toBe(path.join(workflowRoot, "check.ts"));
		await expect(resolveWorkflowTarget("./workflows/release-check/check.ts", { cwd: root }))
			.rejects.toThrow("must be a named workflow");
	});

	test("does not discover retired manifest directories", async () => {
		const oldName = ["auto", "mation"].join("");
		const oldPlural = `${oldName}s`;
		const root = await mkdtemp(path.join(tmpdir(), "codex-toys-workflow-retired-root-"));
		const oldRoot = path.join(root, oldPlural, "release-check");
		await mkdir(oldRoot, { recursive: true });
		await writeFile(path.join(oldRoot, "check.ts"), "export default () => ({ status: 'skipped' });");
		await writeFile(path.join(oldRoot, `${oldName}.json`), JSON.stringify({
			name: "release-check",
			script: "check.ts",
		}));
		expect(await listWorkflows({ cwd: root })).toEqual([]);
		await expect(resolveWorkflowTarget("release-check", { cwd: root }))
			.rejects.toThrow("No workflow named");
	});

	test("resolves workbench-root cwd aliases in workflow manifests", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "codex-toys-workflow-workbench-root-"));
		const workflowRoot = path.join(root, ".codex", "workflows", "release-check");
		await mkdir(workflowRoot, { recursive: true });
		await writeFile(path.join(workflowRoot, "check.ts"), `
export default function run(context) {
  return {
    status: "ready",
    cwd: context.cwd,
    workbenchRoot: context.workbenchRoot
  };
}
`);
		await writeFile(path.join(workflowRoot, "workflow.json"), JSON.stringify({
			name: "release-check",
			script: "check.ts",
			cwd: "@/fork",
		}));
		const target = await resolveWorkflowTarget("release-check", { cwd: root });
		expect(target.cwd).toBe(path.join(root, "fork"));
		const run = await runWorkflowScript({
			scriptPath: target.scriptPath,
			workflow: target.workflow,
			cwd: target.cwd,
			timeoutMs: 5_000,
		});
		expect(run.result).toMatchObject({
			status: "ready",
			cwd: path.join(root, "fork"),
			workbenchRoot: root,
		});
	});

	test("rejects workbench-root cwd aliases that escape the workbench", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "codex-toys-workflow-bad-workbench-root-"));
		const workflowRoot = path.join(root, ".codex", "workflows", "release-check");
		await mkdir(workflowRoot, { recursive: true });
		await writeFile(path.join(workflowRoot, "check.ts"), "export default () => ({ status: 'skipped' });");
		await writeFile(path.join(workflowRoot, "workflow.json"), JSON.stringify({
			name: "release-check",
			script: "check.ts",
			cwd: "@/../outside",
		}));
		await expect(resolveWorkflowTarget("release-check", { cwd: root }))
			.rejects.toThrow("must stay inside workbench root");
	});

});
