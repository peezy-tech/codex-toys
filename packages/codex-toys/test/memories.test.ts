import { describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	applyMemoryTransplant,
	planMemoryTransplant,
} from "../src/cli/memories.ts";
import {
	copyCodexMemoryArtifacts,
	findTextInCodexMemoryArtifacts,
	listCodexMemoryArtifacts,
	sanitizeWorkbenchMemoryArtifacts,
	waitForCodexMemoryArtifacts,
} from "@codex-toys/bridge";

describe("memory transplant", () => {
	test("dry-run reports adds, conflicts, skipped files, and bytes", async () => {
		const { globalHome, workbenchHome, workbenchRoot } = await memoryHomes();
		await writeFile(path.join(globalHome, "memories", "memory_summary.md"), "summary\n");
		await writeFile(path.join(globalHome, "memories", "rollout_summaries", "one.md"), "rollout\n");
		await writeFile(path.join(globalHome, "memories", "state_5.sqlite"), "db");
		await writeFile(path.join(globalHome, "memories", ".git", "HEAD"), "ref: refs/heads/main\n");
		await mkdir(path.join(globalHome, "memories", "extensions", "ad_hoc"), { recursive: true });
		await writeFile(
			path.join(globalHome, "memories", "extensions", "ad_hoc", "instructions.md"),
			"generated machinery\n",
		);
		await writeFile(
			path.join(globalHome, "memories", "MEMORY.md.backup-2026-05-16T07-13-00-000Z"),
			"backup\n",
		);
		await writeFile(path.join(workbenchHome, "memories", "memory_summary.md"), "workbench\n");
		const plan = await planMemoryTransplant({
			direction: "global-to-workbench",
			workbenchRoot,
			globalCodexHome: globalHome,
			workbenchCodexHome: workbenchHome,
		});
		expect(plan.apply).toBe(false);
		expect(plan.filesToAdd.map((file) => file.relativePath)).toEqual(["rollout_summaries/one.md"]);
		expect(plan.conflicts.map((file) => file.relativePath)).toEqual(["memory_summary.md"]);
		expect(plan.skipped.map((file) => file.relativePath)).toEqual([
			"MEMORY.md.backup-2026-05-16T07-13-00-000Z",
			"state_5.sqlite",
		]);
		expect(plan.estimatedBytes).toBeGreaterThan(0);
	});

	test("copies only durable artifacts from a real Codex memory layout", async () => {
		const { globalHome, workbenchHome, workbenchRoot } = await memoryHomes();
		await mkdir(path.join(globalHome, "memories", ".git", "objects"), { recursive: true });
		await mkdir(path.join(globalHome, "memories", "extensions", "ad_hoc"), { recursive: true });
		await writeFile(path.join(globalHome, "memories", ".git", "HEAD"), "ref: refs/heads/main\n");
		await writeFile(path.join(globalHome, "memories", "MEMORY.md"), "handbook\n");
		await writeFile(path.join(globalHome, "memories", "memory_summary.md"), "summary\n");
		await writeFile(path.join(globalHome, "memories", "raw_memories.md"), "raw\n");
		await writeFile(path.join(globalHome, "memories", "rollout_summaries", "natural.md"), "rollout\n");
		await writeFile(path.join(globalHome, "memories", "extensions", "ad_hoc", "instructions.md"), "extension\n");
		await writeFile(path.join(globalHome, "memories", "phase2_workbench_diff.md"), "diff\n");
		await writeFile(path.join(globalHome, "memories", "state_5.sqlite"), "db");

		const plan = await applyMemoryTransplant({
			direction: "global-to-workbench",
			workbenchRoot,
			globalCodexHome: globalHome,
			workbenchCodexHome: workbenchHome,
			apply: true,
		});

		expect(plan.filesToAdd.map((file) => file.relativePath)).toEqual([
			"MEMORY.md",
			"memory_summary.md",
			"raw_memories.md",
			"rollout_summaries/natural.md",
		]);
		expect(plan.skipped.map((file) => file.relativePath)).toEqual([
			"phase2_workbench_diff.md",
			"state_5.sqlite",
		]);
		expect(await readFile(path.join(workbenchHome, "memories", "raw_memories.md"), "utf8")).toBe("raw\n");
		expect(await exists(path.join(workbenchHome, "memories", ".git", "HEAD"))).toBe(false);
		expect(await exists(path.join(workbenchHome, "memories", "extensions", "ad_hoc", "instructions.md"))).toBe(false);
	});

	test("apply copies missing files and leaves conflicts without overwrite", async () => {
		const { globalHome, workbenchHome, workbenchRoot } = await memoryHomes();
		await writeFile(path.join(globalHome, "memories", "MEMORY.md"), "global\n");
		await writeFile(path.join(globalHome, "memories", "raw_memories.md"), "raw\n");
		await writeFile(path.join(workbenchHome, "memories", "MEMORY.md"), "workbench\n");
		await applyMemoryTransplant({
			direction: "global-to-workbench",
			workbenchRoot,
			globalCodexHome: globalHome,
			workbenchCodexHome: workbenchHome,
			apply: true,
		});
		expect(await readFile(path.join(workbenchHome, "memories", "raw_memories.md"), "utf8")).toBe("raw\n");
		expect(await readFile(path.join(workbenchHome, "memories", "MEMORY.md"), "utf8")).toBe("workbench\n");
	});

	test("overwrite creates backups before replacing conflicts", async () => {
		const { globalHome, workbenchHome, workbenchRoot } = await memoryHomes();
		await writeFile(path.join(globalHome, "memories", "memory_summary.md"), "global\n");
		await writeFile(path.join(workbenchHome, "memories", "memory_summary.md"), "workbench\n");
		const plan = await applyMemoryTransplant({
			direction: "global-to-workbench",
			workbenchRoot,
			globalCodexHome: globalHome,
			workbenchCodexHome: workbenchHome,
			apply: true,
			overwrite: true,
		});
		expect(await readFile(path.join(workbenchHome, "memories", "memory_summary.md"), "utf8")).toBe("global\n");
		expect(plan.conflicts[0]?.backupPath).toBeDefined();
		expect(await readFile(plan.conflicts[0]?.backupPath ?? "", "utf8")).toBe("workbench\n");
	});

	test("public memory helpers use stable raw and rollout artifacts", async () => {
		const { globalHome, workbenchRoot } = await memoryHomes();
		await writeFile(path.join(globalHome, "memories", "MEMORY.md"), "not required\n");
		await writeFile(path.join(globalHome, "memories", "memory_summary.md"), "not required\n");
		await writeFile(path.join(globalHome, "memories", "raw_memories.md"), "needle raw\n");
		await writeFile(path.join(globalHome, "memories", "rollout_summaries", "one.md"), "needle rollout\n");
		await writeFile(path.join(globalHome, "memories", "state_5.sqlite"), "db");

		const artifacts = await listCodexMemoryArtifacts({ codexHome: globalHome });
		expect(artifacts.map((artifact) => artifact.relativePath)).toEqual([
			"raw_memories.md",
			"rollout_summaries/one.md",
		]);
		expect((await findTextInCodexMemoryArtifacts({ codexHome: globalHome, text: "needle" })))
			.toHaveLength(2);
		expect((await waitForCodexMemoryArtifacts({
			codexHome: globalHome,
			text: "needle raw",
			timeoutMs: 10,
			pollIntervalMs: 1,
		}))[0]?.relativePath).toBe("raw_memories.md");

		const copy = await copyCodexMemoryArtifacts({
			sourceCodexHome: globalHome,
			workbenchRoot,
		});
		expect(copy.copied.map((artifact) => artifact.relativePath)).toEqual([
			"raw_memories.md",
			"rollout_summaries/one.md",
		]);
		expect(await readFile(path.join(workbenchRoot, ".codex", "memories", "raw_memories.md"), "utf8"))
			.toBe("needle raw\n");
	});

	test("sanitizeWorkbenchMemoryArtifacts removes memory runtime files", async () => {
		const { workbenchHome, workbenchRoot } = await memoryHomes();
		await mkdir(path.join(workbenchHome, "memories", ".git"), { recursive: true });
		await writeFile(path.join(workbenchHome, "memories", ".git", "HEAD"), "ref\n");
		await writeFile(path.join(workbenchHome, "memories", "phase2_workbench_diff.md"), "diff\n");
		await writeFile(path.join(workbenchHome, "memories", "state_5.sqlite"), "db\n");
		await writeFile(path.join(workbenchHome, "memories", "raw_memories.md"), "keep\n");

		const result = await sanitizeWorkbenchMemoryArtifacts({ workbenchRoot });

		expect(result.removed).toEqual([
			".git",
			"phase2_workbench_diff.md",
			"state_5.sqlite",
		]);
		expect(await readFile(path.join(workbenchHome, "memories", "raw_memories.md"), "utf8"))
			.toBe("keep\n");
	});
});

async function memoryHomes(): Promise<{
	workbenchRoot: string;
	globalHome: string;
	workbenchHome: string;
}> {
	const root = await mkdtemp(path.join(os.tmpdir(), "codex-memories-"));
	const globalHome = path.join(root, "global");
	const workbenchRoot = path.join(root, "workbench");
	const workbenchHome = path.join(workbenchRoot, ".codex");
	for (const dir of [
		path.join(globalHome, "memories", "rollout_summaries"),
		path.join(globalHome, "memories", ".git"),
		path.join(workbenchHome, "memories", "rollout_summaries"),
	]) {
		await mkdir(dir, { recursive: true });
	}
	return { workbenchRoot, globalHome, workbenchHome };
}

async function exists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
}
