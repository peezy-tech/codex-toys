import { describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	listTurnAutomations,
	parseTurnAutomationResult,
	resolveTurnAutomationTarget,
	runTurnAutomationScript,
} from "@codex-toys/workbench";

describe("turn automation", () => {
	test("treats action-shaped module returns as plain JSON results", () => {
		expect(parseTurnAutomationResult(
			`TURN_AUTOMATION_MODULE_RESULT ${JSON.stringify({ action: "ignored" })}\n`,
		)).toEqual({
			result: { action: "ignored" },
		});
	});

	test("runs module-style scripts and passes prompt context", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "codex-toys-automation-"));
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
		const run = await runTurnAutomationScript({
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

	test("runs module scripts with a programmable host API", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "codex-toys-automation-host-"));
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
		const run = await runTurnAutomationScript({
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

	test("fails module-style scripts that throw", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "codex-toys-automation-"));
		const scriptPath = path.join(dir, "check.ts");
		await writeFile(scriptPath, `
export default function run() {
  throw new Error("boom");
}
`);
		await expect(runTurnAutomationScript({
			scriptPath,
			timeoutMs: 5_000,
		})).rejects.toThrow("boom");
	});

	test("discovers named automation manifests", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "codex-toys-automation-root-"));
		const automationRoot = path.join(root, "automations", "release-check");
		await mkdir(automationRoot, { recursive: true });
		await writeFile(path.join(automationRoot, "check.ts"), "export default () => ({ status: 'skipped' });");
		await writeFile(path.join(automationRoot, "prompt.md"), "Inspect the release.\n");
		await writeFile(path.join(automationRoot, "automation.json"), JSON.stringify({
			name: "release-check",
			description: "Check upstream releases",
			script: "check.ts",
			promptFile: "prompt.md",
			cwd: "../repo",
			skills: ["turn-automation-author"],
			timeoutMs: 123456,
		}));
		const automations = await listTurnAutomations({ cwd: root });
		expect(automations).toHaveLength(1);
		expect(automations[0]).toMatchObject({
			name: "release-check",
			prompt: "Inspect the release.\n",
			skills: ["turn-automation-author"],
			timeoutMs: 123456,
		});
		const target = await resolveTurnAutomationTarget("release-check", { cwd: root });
		expect(target).toMatchObject({
			prompt: "Inspect the release.\n",
			skills: ["turn-automation-author"],
			timeoutMs: 123456,
		});
		expect(target.scriptPath).toBe(path.join(automationRoot, "check.ts"));
		await expect(resolveTurnAutomationTarget("./automations/release-check/check.ts", { cwd: root }))
			.rejects.toThrow("must be a named automation");
	});

	test("resolves workbench-root cwd aliases in automation manifests", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "codex-toys-automation-workbench-root-"));
		const automationRoot = path.join(root, ".codex", "automations", "release-check");
		await mkdir(automationRoot, { recursive: true });
		await writeFile(path.join(automationRoot, "check.ts"), `
export default function run(context) {
  return {
    status: "ready",
    cwd: context.cwd,
    workbenchRoot: context.workbenchRoot
  };
}
`);
		await writeFile(path.join(automationRoot, "automation.json"), JSON.stringify({
			name: "release-check",
			script: "check.ts",
			cwd: "@/fork",
		}));
		const target = await resolveTurnAutomationTarget("release-check", { cwd: root });
		expect(target.cwd).toBe(path.join(root, "fork"));
		const run = await runTurnAutomationScript({
			scriptPath: target.scriptPath,
			automation: target.automation,
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
		const root = await mkdtemp(path.join(tmpdir(), "codex-toys-automation-bad-workbench-root-"));
		const automationRoot = path.join(root, ".codex", "automations", "release-check");
		await mkdir(automationRoot, { recursive: true });
		await writeFile(path.join(automationRoot, "check.ts"), "export default () => ({ status: 'skipped' });");
		await writeFile(path.join(automationRoot, "automation.json"), JSON.stringify({
			name: "release-check",
			script: "check.ts",
			cwd: "@/../outside",
		}));
		await expect(resolveTurnAutomationTarget("release-check", { cwd: root }))
			.rejects.toThrow("must stay inside workbench root");
	});

});
