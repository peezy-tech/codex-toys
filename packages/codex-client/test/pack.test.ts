import { describe, expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	applyPackAdd,
	collectPackDoctor,
	inspectPackSource,
	listInstalledPacks,
	planPackAdd,
} from "../src/cli/pack.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(testDir, "fixtures", "example-pack");

describe("pack installer", () => {
	test("inspects a manifest-backed pack and honors item names", async () => {
		const inspection = await inspectPackSource({ source: fixtureRoot });

		expect(inspection.pack).toMatchObject({
			name: "engineering-capabilities",
			version: "0.1.0",
		});
		expect(inspection.items.map((item) => `${item.kind}:${item.name}`).sort()).toEqual([
			"flow:release-health",
			"hook:workspace-stop",
			"plugin:repo-policy",
			"skill:tdd",
		]);
		expect(inspection.items.find((item) => item.name === "repo-policy")?.pluginHasHooks).toBe(true);
	});

	test("dry-run reports selected copies without writing workspace files", async () => {
		const workspaceRoot = await tempWorkspace();
		const plan = await planPackAdd({
			source: fixtureRoot,
			workspaceRoot,
			include: ["tdd", "release-health"],
		});

		expect(plan.apply).toBe(false);
		expect(plan.items.filter((item) => item.action === "add").map((item) => item.name).sort())
			.toEqual(["release-health", "tdd"]);
		expect(plan.items.filter((item) => item.action === "skip").map((item) => item.name).sort())
			.toEqual(["repo-policy", "workspace-stop"]);
		expect(await exists(path.join(workspaceRoot, ".agents", "skills", "tdd"))).toBe(false);
		expect(await exists(path.join(workspaceRoot, ".codex", "pack-lock.json"))).toBe(false);
	});

	test("apply installs capabilities, marketplace entries, hooks, and lockfile", async () => {
		const workspaceRoot = await tempWorkspace();
		const plan = await applyPackAdd({
			source: fixtureRoot,
			workspaceRoot,
			apply: true,
		});

		expect(plan.items.every((item) => item.action === "add")).toBe(true);
		expect(await readFile(path.join(workspaceRoot, ".agents", "skills", "tdd", "SKILL.md"), "utf8"))
			.toContain("# TDD");
		expect(await readFile(path.join(workspaceRoot, ".codex", "flows", "release-health", "flow.toml"), "utf8"))
			.toContain('name = "release-health"');
		expect(await readFile(path.join(workspaceRoot, "plugins", "repo-policy", ".codex-plugin", "plugin.json"), "utf8"))
			.toContain('"name": "repo-policy"');

		const marketplace = JSON.parse(
			await readFile(path.join(workspaceRoot, ".agents", "plugins", "marketplace.json"), "utf8"),
		) as { plugins: Array<{ name: string; source: { path: string } }> };
		expect(marketplace.plugins).toContainEqual(expect.objectContaining({
			name: "repo-policy",
			source: { source: "local", path: "./plugins/repo-policy" },
		}));

		const hooks = JSON.parse(
			await readFile(path.join(workspaceRoot, ".codex", "hooks.json"), "utf8"),
		) as { hooks: { PostToolUse: unknown[] }; codexPack: { hooks: Record<string, unknown> } };
		expect(hooks.hooks.PostToolUse).toHaveLength(1);
		expect(hooks.codexPack.hooks["workspace-stop"]).toBeDefined();

		const list = await listInstalledPacks({ workspaceRoot });
		expect(list.items.map((item) => `${item.kind}:${item.name}`).sort()).toEqual([
			"flow:release-health",
			"hook:workspace-stop",
			"plugin:repo-policy",
			"skill:tdd",
		]);

		const doctor = await collectPackDoctor({ workspaceRoot });
		expect(doctor.installedItems).toBe(4);
		expect(doctor.missingDestinations).toEqual([]);
		expect(doctor.marketplace.valid).toBe(true);
		expect(doctor.hooks.valid).toBe(true);
	});

	test("conflicts skip changed destinations and overwrite backs them up", async () => {
		const workspaceRoot = await tempWorkspace();
		await applyPackAdd({
			source: fixtureRoot,
			workspaceRoot,
			apply: true,
			include: ["tdd"],
		});
		const installedSkill = path.join(workspaceRoot, ".agents", "skills", "tdd", "SKILL.md");
		await writeFile(installedSkill, "workspace edit\n");

		const conflict = await planPackAdd({
			source: fixtureRoot,
			workspaceRoot,
			include: ["tdd"],
		});
		expect(conflict.items.find((item) => item.name === "tdd")?.action).toBe("conflict");

		const overwritten = await applyPackAdd({
			source: fixtureRoot,
			workspaceRoot,
			apply: true,
			overwrite: true,
			include: ["tdd"],
		});
		const tdd = overwritten.items.find((item) => item.name === "tdd");
		expect(tdd?.action).toBe("overwrite");
		expect(tdd?.backupPath).toBeDefined();
		expect(await readFile(path.join(tdd?.backupPath ?? "", "SKILL.md"), "utf8"))
			.toContain("workspace edit");
		expect(await readFile(installedSkill, "utf8")).toContain("# TDD");
	});

	test("treats destination files as conflicts and overwrites them with backups", async () => {
		const workspaceRoot = await tempWorkspace();
		const skillDestination = path.join(workspaceRoot, ".agents", "skills", "tdd");
		await writeFixtureFile(workspaceRoot, ".agents/skills/tdd", "not a directory\n");

		const conflict = await planPackAdd({
			source: fixtureRoot,
			workspaceRoot,
			include: ["tdd"],
		});
		expect(conflict.items.find((item) => item.name === "tdd")).toMatchObject({
			action: "conflict",
			reason: expect.stringContaining("destination is a file"),
		});

		const overwritten = await applyPackAdd({
			source: fixtureRoot,
			workspaceRoot,
			apply: true,
			overwrite: true,
			include: ["tdd"],
		});
		const tdd = overwritten.items.find((item) => item.name === "tdd");
		expect(tdd?.action).toBe("overwrite");
		expect(tdd?.backupPath).toBeDefined();
		expect(await readFile(tdd?.backupPath ?? "", "utf8")).toContain("not a directory");
		expect(await readFile(path.join(skillDestination, "SKILL.md"), "utf8")).toContain("# TDD");
	});

	test("conflicts with same-name marketplace plugins from another source unless overwritten", async () => {
		const workspaceRoot = await tempWorkspace();
		await writeMarketplace(workspaceRoot, [
			{
				name: "repo-policy",
				source: { source: "local", path: "./plugins/existing-policy" },
			},
			{
				name: "other-plugin",
				source: { source: "local", path: "./plugins/other-plugin" },
			},
		]);

		const conflict = await planPackAdd({
			source: fixtureRoot,
			workspaceRoot,
			include: ["repo-policy"],
		});
		expect(conflict.items.find((item) => item.name === "repo-policy")).toMatchObject({
			action: "conflict",
			reason: expect.stringContaining("marketplace already has plugin repo-policy"),
		});

		const overwritten = await applyPackAdd({
			source: fixtureRoot,
			workspaceRoot,
			apply: true,
			overwrite: true,
			include: ["repo-policy"],
		});

		expect(overwritten.marketplaceBackupPath).toBeDefined();
		expect(await readFile(overwritten.marketplaceBackupPath ?? "", "utf8"))
			.toContain("./plugins/existing-policy");
		const marketplace = JSON.parse(
			await readFile(path.join(workspaceRoot, ".agents", "plugins", "marketplace.json"), "utf8"),
		) as { plugins: Array<{ name: string; source: { path: string } }> };
		expect(marketplace.plugins.filter((plugin) => plugin.name === "repo-policy")).toEqual([
			expect.objectContaining({
				name: "repo-policy",
				source: { source: "local", path: "./plugins/repo-policy" },
			}),
		]);
		expect(marketplace.plugins.find((plugin) => plugin.name === "other-plugin")).toBeDefined();
	});

	test("does not inspect marketplace when no plugins are selected", async () => {
		const workspaceRoot = await tempWorkspace();
		await writeFixtureFile(workspaceRoot, ".agents/plugins/marketplace.json", "{not json");

		const plan = await planPackAdd({
			source: fixtureRoot,
			workspaceRoot,
			include: ["tdd"],
		});

		expect(plan.items.find((item) => item.name === "tdd")?.action).toBe("add");
		expect(plan.items.find((item) => item.name === "repo-policy")?.action).toBe("skip");
	});

	test("doctor reports changed installed destinations", async () => {
		const workspaceRoot = await tempWorkspace();
		await applyPackAdd({
			source: fixtureRoot,
			workspaceRoot,
			apply: true,
			include: ["tdd"],
		});
		await writeFile(
			path.join(workspaceRoot, ".agents", "skills", "tdd", "SKILL.md"),
			"# Edited\n",
		);

		const doctor = await collectPackDoctor({ workspaceRoot });

		expect(doctor.missingDestinations).toEqual([]);
		expect(doctor.changedDestinations).toHaveLength(1);
		expect(doctor.changedDestinations[0]).toMatchObject({
			kind: "skill",
			name: "tdd",
			reason: "content hash differs",
		});
	});

	test("supports remote git refs that are commit SHAs", async () => {
		const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-pack-git-source-"));
		await writeFixtureFile(sourceRoot, "skills/git-skill/SKILL.md", "# Git Skill\n");
		await runGit(["init"], sourceRoot);
		await runGit(["config", "user.email", "test@example.com"], sourceRoot);
		await runGit(["config", "user.name", "Pack Test"], sourceRoot);
		await runGit(["add", "."], sourceRoot);
		await runGit(["commit", "-m", "Initial pack"], sourceRoot);
		const commit = (await runGit(["rev-parse", "HEAD"], sourceRoot)).trim();

		const inspection = await inspectPackSource({
			source: `file://${sourceRoot}`,
			ref: commit,
		});

		expect(inspection.source).toMatchObject({
			type: "git",
			ref: commit,
			commit,
		});
		expect(inspection.items.map((item) => `${item.kind}:${item.name}`)).toEqual([
			"skill:git-skill",
		]);
	});

	test("discovers conventional layouts without codex-pack.toml", async () => {
		const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-pack-source-"));
		await writeFixtureFile(sourceRoot, "skills/demo/SKILL.md", "# Demo\n");
		await writeFixtureFile(sourceRoot, "flows/demo-flow/flow.toml", [
			'name = "demo-flow"',
			"version = 1",
			"[[steps]]",
			'name = "check"',
			'runner = "node"',
			'script = "check.ts"',
		].join("\n"));
		await writeFixtureFile(sourceRoot, "plugins/demo-plugin/.codex-plugin/plugin.json", '{"name":"demo-plugin"}');
		await writeFixtureFile(sourceRoot, "hooks/demo-hooks/hooks.json", '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo stop"}]}]}}');

		const inspection = await inspectPackSource({ source: sourceRoot });

		expect(inspection.items.map((item) => `${item.kind}:${item.name}`).sort()).toEqual([
			"flow:demo-flow",
			"hook:demo-hooks",
			"plugin:demo-plugin",
			"skill:demo",
		]);
	});

	test("does not treat root plugin hooks as direct hook packs", async () => {
		const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-plugin-source-"));
		await writeFixtureFile(sourceRoot, ".codex-plugin/plugin.json", '{"name":"demo-plugin"}');
		await writeFixtureFile(sourceRoot, "hooks/hooks.json", '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo stop"}]}]}}');

		const inspection = await inspectPackSource({ source: sourceRoot });

		expect(inspection.items.map((item) => `${item.kind}:${item.name}`).sort()).toEqual([]);
	});
});

async function tempWorkspace(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "codex-pack-workspace-"));
	await mkdir(path.join(root, ".git"), { recursive: true });
	return root;
}

async function writeFixtureFile(root: string, relativePath: string, contents: string): Promise<void> {
	const fullPath = path.join(root, relativePath);
	await mkdir(path.dirname(fullPath), { recursive: true });
	await writeFile(fullPath, contents);
}

async function writeMarketplace(root: string, plugins: Array<Record<string, unknown>>): Promise<void> {
	await writeFixtureFile(
		root,
		".agents/plugins/marketplace.json",
		`${JSON.stringify({
			name: "workspace",
			interface: { displayName: "Workspace" },
			plugins,
		}, null, 2)}\n`,
	);
}

async function runGit(args: string[], cwd: string): Promise<string> {
	const proc = spawn("git", args, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(proc.stdout),
		collectText(proc.stderr),
		exitCodeFor(proc),
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
	}
	return stdout;
}

async function collectText(stream: NodeJS.ReadableStream | null): Promise<string> {
	let output = "";
	if (!stream) {
		return output;
	}
	for await (const chunk of stream) {
		output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
	}
	return output;
}

function exitCodeFor(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}
