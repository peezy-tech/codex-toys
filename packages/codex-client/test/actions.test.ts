import { describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	cleanupActionsCodexHome,
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

	test("cleanup removes runtime-only files and preserves durable Actions state and sessions", async () => {
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
			"shell_snapshots",
			"state.sqlite",
			"tmp",
		]);
		expect(await readFile(path.join(codexHome, "sessions", "rollout.jsonl"), "utf8")).toBe("{}");
		expect(await readFile(path.join(codexHome, "memories", "raw_memories.md"), "utf8")).toBe("keep");
		expect(await readFile(path.join(codexHome, "workspace", "actions", "state.json"), "utf8")).toBe("{}");
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
