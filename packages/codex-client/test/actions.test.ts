import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	assertActionsFlowRun,
	cleanupActionsCodexHome,
	dispatchActionsFlowEvent,
	prepareActionsCodexAuth,
	repoCodexHome,
} from "../src/actions.ts";

describe("Actions helpers", () => {
	test("repoCodexHome always points at repo .codex", async () => {
		const root = await tempWorkspace();
		expect(repoCodexHome(root)).toBe(path.join(root, ".codex"));
	});

	test("prepareActionsCodexAuth writes base64, raw JSON, API key, and handles missing auth", async () => {
		const base64Root = await tempWorkspace();
		const base64 = Buffer.from(JSON.stringify({ token: "base64" }), "utf8").toString("base64");
		const base64Result = await prepareActionsCodexAuth({
			workspaceRoot: base64Root,
			env: { CODEX_AUTH_JSON_B64: base64 },
		});
		expect(base64Result).toMatchObject({ source: "CODEX_AUTH_JSON_B64", wrote: true });
		expect(JSON.parse(await readFile(base64Result.authPath, "utf8"))).toEqual({ token: "base64" });
		expect((await stat(base64Result.authPath)).mode & 0o777).toBe(0o600);

		const rawRoot = await tempWorkspace();
		const rawResult = await prepareActionsCodexAuth({
			workspaceRoot: rawRoot,
			env: { CODEX_AUTH_JSON: "{\"token\":\"raw\"}" },
		});
		expect(rawResult.source).toBe("CODEX_AUTH_JSON");
		expect(JSON.parse(await readFile(rawResult.authPath, "utf8"))).toEqual({ token: "raw" });

		const keyRoot = await tempWorkspace();
		const keyResult = await prepareActionsCodexAuth({
			workspaceRoot: keyRoot,
			env: { OPENAI_API_KEY: "sk-test" },
		});
		expect(keyResult.source).toBe("OPENAI_API_KEY");
		expect(JSON.parse(await readFile(keyResult.authPath, "utf8"))).toEqual({
			OPENAI_API_KEY: "sk-test",
		});

		const missingRoot = await tempWorkspace();
		expect(await prepareActionsCodexAuth({ workspaceRoot: missingRoot, env: {} }))
			.toMatchObject({ source: "none", wrote: false });
	});

	test("cleanup removes runtime-only files and preserves durable Actions state", async () => {
		const root = await tempWorkspace();
		const codexHome = repoCodexHome(root);
		await writeFile(path.join(codexHome, "auth.json"), "{}");
		await writeFile(path.join(codexHome, "install_id"), "install");
		await writeFile(path.join(codexHome, "state.sqlite"), "db");
		await writeFile(path.join(codexHome, "sessions", "rollout.jsonl"), "{}");
		await writeFile(path.join(codexHome, "shell_snapshots", "one.json"), "{}");
		await writeFile(path.join(codexHome, "tmp", "x"), "tmp");
		await writeFile(path.join(codexHome, "memories", ".git", "HEAD"), "ref\n");
		await writeFile(path.join(codexHome, "memories", "phase2_workspace_diff.md"), "diff");
		await writeFile(path.join(codexHome, "memories", "raw_memories.md"), "keep");
		await writeFile(path.join(codexHome, "workspace", "actions", "state.json"), "{}");

		const result = await cleanupActionsCodexHome({ workspaceRoot: root });

		expect(result.removed).toEqual([
			"auth.json",
			"install_id",
			"memories/.git",
			"memories/phase2_workspace_diff.md",
			"sessions",
			"shell_snapshots",
			"state.sqlite",
			"tmp",
		]);
		expect(await readFile(path.join(codexHome, "memories", "raw_memories.md"), "utf8")).toBe("keep");
		expect(await readFile(path.join(codexHome, "workspace", "actions", "state.json"), "utf8")).toBe("{}");
	});

	test("dispatchActionsFlowEvent persists events and file-backed run state under .codex/workspace/actions", async () => {
		const root = await tempWorkspace();
		await writeSmokeFlow(root);

		const result = await dispatchActionsFlowEvent({
			workspaceRoot: root,
			env: { CODEX_HOME: "/tmp/external-codex-home" },
			event: {
				id: "event-1",
				type: "workspace.smoke",
				receivedAt: "2026-05-17T00:00:00.000Z",
				payload: { name: "Ada" },
			},
		});

		expect(result.eventPath).toContain(path.join(".codex", "workspace", "actions", "events"));
		expect(await readFile(result.eventPath, "utf8")).toContain("\"id\": \"event-1\"");
		expect(await readFile(path.join(root, ".codex", "workspace", "actions", "flow-client", "state.json"), "utf8"))
			.toContain("actions smoke Ada");

		const asserted = await assertActionsFlowRun({
			workspaceRoot: root,
			flowName: "actions-smoke",
			stepName: "smoke",
			requireCompleted: true,
			artifactText: path.join(root, ".codex"),
			env: { CODEX_HOME: "/tmp/external-codex-home" },
		});
		expect(asserted.run.resultStatus).toBe("completed");
	});
});

async function tempWorkspace(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "codex-actions-"));
	for (const dir of [
		path.join(root, ".codex"),
		path.join(root, ".codex", "sessions"),
		path.join(root, ".codex", "shell_snapshots"),
		path.join(root, ".codex", "tmp"),
		path.join(root, ".codex", "memories", ".git"),
		path.join(root, ".codex", "workspace", "actions"),
	]) {
		await mkdir(dir, { recursive: true });
	}
	return root;
}

async function writeSmokeFlow(root: string): Promise<void> {
	const flowRoot = path.join(root, ".codex", "flows", "actions-smoke");
	await mkdir(path.join(flowRoot, "exec"), { recursive: true });
	await writeFile(
		path.join(flowRoot, "flow.toml"),
		[
			'name = "actions-smoke"',
			"version = 1",
			"",
			"[[steps]]",
			'name = "smoke"',
			'runner = "bun"',
			'script = "exec/smoke.ts"',
			"timeout_ms = 30000",
			"",
			"[steps.trigger]",
			'type = "workspace.smoke"',
			"",
		].join("\n"),
	);
	await writeFile(
		path.join(flowRoot, "exec", "smoke.ts"),
		[
			"const context = JSON.parse(await Bun.stdin.text());",
			"const name = context.flow.event.payload.name;",
			"console.log('FLOW_RESULT ' + JSON.stringify({",
			"  status: 'completed',",
			"  message: `actions smoke ${name}`,",
			"  artifacts: { codexHome: process.env.CODEX_HOME },",
			"}));",
			"",
		].join("\n"),
	);
}
