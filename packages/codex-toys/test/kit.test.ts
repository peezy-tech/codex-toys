import { describe, expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	applyKitAdd,
	collectKitDoctor,
	inspectKitSource,
	listInstalledKits,
	planKitAdd,
} from "@codex-toys/kits";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(testDir, "fixtures", "example-kit");
const setupFixtureRoot = path.join(testDir, "fixtures", "workspace-ops-baseline");

describe("kit installer", () => {
	test("inspects a manifest-backed kit and honors item names", async () => {
		const inspection = await inspectKitSource({ source: fixtureRoot });

		expect(inspection.kit).toMatchObject({
			name: "engineering-capabilities",
			version: "0.1.0",
		});
		expect(inspection.items.map((item) => `${item.kind}:${item.name}`).sort()).toEqual([
			"automation:release-candidate",
			"plugin:repo-policy",
			"skill:tdd",
		]);
	});

	test("dry-run reports selected copies without writing workbench files", async () => {
		const workbenchRoot = await tempWorkbench();
		const plan = await planKitAdd({
			source: fixtureRoot,
			workbenchRoot,
			include: ["tdd", "release-candidate"],
		});

		expect(plan.apply).toBe(false);
		expect(plan.items.filter((item) => item.action === "add").map((item) => item.name).sort())
			.toEqual(["release-candidate", "tdd"]);
		expect(plan.items.filter((item) => item.action === "skip").map((item) => item.name).sort())
			.toEqual(["repo-policy"]);
		expect(await exists(path.join(workbenchRoot, ".agents", "skills", "tdd"))).toBe(false);
		expect(await exists(path.join(workbenchRoot, ".codex", "kit-lock.json"))).toBe(false);
	});

	test("apply installs capabilities, marketplace entries, and lockfile", async () => {
		const workbenchRoot = await tempWorkbench();
		const plan = await applyKitAdd({
			source: fixtureRoot,
			workbenchRoot,
			apply: true,
		});

		expect(plan.items.every((item) => item.action === "add")).toBe(true);
		expect(await readFile(path.join(workbenchRoot, ".agents", "skills", "tdd", "SKILL.md"), "utf8"))
			.toContain("# TDD");
		expect(await readFile(path.join(workbenchRoot, "plugins", "repo-policy", ".codex-plugin", "plugin.json"), "utf8"))
			.toContain('"name": "repo-policy"');
		expect(await readFile(
			path.join(workbenchRoot, ".codex", "automations", "release-candidate", "automation.json"),
			"utf8",
		)).toContain('"name": "release-candidate"');

		const marketplace = JSON.parse(
			await readFile(path.join(workbenchRoot, ".agents", "plugins", "marketplace.json"), "utf8"),
		) as { plugins: Array<{ name: string; source: { path: string } }> };
		expect(marketplace.plugins).toContainEqual(expect.objectContaining({
			name: "repo-policy",
			source: { source: "local", path: "./plugins/repo-policy" },
		}));

		const list = await listInstalledKits({ workbenchRoot });
		expect(list.items.map((item) => `${item.kind}:${item.name}`).sort()).toEqual([
			"automation:release-candidate",
			"plugin:repo-policy",
			"skill:tdd",
		]);

		const doctor = await collectKitDoctor({ workbenchRoot });
		expect(doctor.installedItems).toBe(3);
		expect(doctor.missingDestinations).toEqual([]);
		expect(doctor.marketplace.valid).toBe(true);
	});

	test("conflicts skip changed destinations and overwrite backs them up", async () => {
		const workbenchRoot = await tempWorkbench();
		await applyKitAdd({
			source: fixtureRoot,
			workbenchRoot,
			apply: true,
			include: ["tdd"],
		});
		const installedSkill = path.join(workbenchRoot, ".agents", "skills", "tdd", "SKILL.md");
		await writeFile(installedSkill, "workbench edit\n");

		const conflict = await planKitAdd({
			source: fixtureRoot,
			workbenchRoot,
			include: ["tdd"],
		});
		expect(conflict.items.find((item) => item.name === "tdd")?.action).toBe("conflict");

		const overwritten = await applyKitAdd({
			source: fixtureRoot,
			workbenchRoot,
			apply: true,
			overwrite: true,
			include: ["tdd"],
		});
		const tdd = overwritten.items.find((item) => item.name === "tdd");
		expect(tdd?.action).toBe("overwrite");
		expect(tdd?.backupPath).toBeDefined();
		expect(await readFile(path.join(tdd?.backupPath ?? "", "SKILL.md"), "utf8"))
			.toContain("workbench edit");
		expect(await readFile(installedSkill, "utf8")).toContain("# TDD");
	});

	test("treats destination files as conflicts and overwrites them with backups", async () => {
		const workbenchRoot = await tempWorkbench();
		const skillDestination = path.join(workbenchRoot, ".agents", "skills", "tdd");
		await writeFixtureFile(workbenchRoot, ".agents/skills/tdd", "not a directory\n");

		const conflict = await planKitAdd({
			source: fixtureRoot,
			workbenchRoot,
			include: ["tdd"],
		});
		expect(conflict.items.find((item) => item.name === "tdd")).toMatchObject({
			action: "conflict",
			reason: expect.stringContaining("destination is a file"),
		});

		const overwritten = await applyKitAdd({
			source: fixtureRoot,
			workbenchRoot,
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
		const workbenchRoot = await tempWorkbench();
		await writeMarketplace(workbenchRoot, [
			{
				name: "repo-policy",
				source: { source: "local", path: "./plugins/existing-policy" },
			},
			{
				name: "other-plugin",
				source: { source: "local", path: "./plugins/other-plugin" },
			},
		]);

		const conflict = await planKitAdd({
			source: fixtureRoot,
			workbenchRoot,
			include: ["repo-policy"],
		});
		expect(conflict.items.find((item) => item.name === "repo-policy")).toMatchObject({
			action: "conflict",
			reason: expect.stringContaining("marketplace already has plugin repo-policy"),
		});

		const overwritten = await applyKitAdd({
			source: fixtureRoot,
			workbenchRoot,
			apply: true,
			overwrite: true,
			include: ["repo-policy"],
		});

		expect(overwritten.marketplaceBackupPath).toBeDefined();
		expect(await readFile(overwritten.marketplaceBackupPath ?? "", "utf8"))
			.toContain("./plugins/existing-policy");
		const marketplace = JSON.parse(
			await readFile(path.join(workbenchRoot, ".agents", "plugins", "marketplace.json"), "utf8"),
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
		const workbenchRoot = await tempWorkbench();
		await writeFixtureFile(workbenchRoot, ".agents/plugins/marketplace.json", "{not json");

		const plan = await planKitAdd({
			source: fixtureRoot,
			workbenchRoot,
			include: ["tdd"],
		});

		expect(plan.items.find((item) => item.name === "tdd")?.action).toBe("add");
		expect(plan.items.find((item) => item.name === "repo-policy")?.action).toBe("skip");
	});

	test("doctor reports changed installed destinations", async () => {
		const workbenchRoot = await tempWorkbench();
		await applyKitAdd({
			source: fixtureRoot,
			workbenchRoot,
			apply: true,
			include: ["tdd"],
		});
		await writeFile(
			path.join(workbenchRoot, ".agents", "skills", "tdd", "SKILL.md"),
			"# Edited\n",
		);

		const doctor = await collectKitDoctor({ workbenchRoot });

		expect(doctor.missingDestinations).toEqual([]);
		expect(doctor.changedDestinations).toHaveLength(1);
		expect(doctor.changedDestinations[0]).toMatchObject({
			kind: "skill",
			name: "tdd",
			reason: "content hash differs",
		});
	});

	test("supports remote git refs that are commit SHAs", async () => {
		const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-kit-git-source-"));
		await writeFixtureFile(sourceRoot, "skills/git-skill/SKILL.md", "# Git Skill\n");
		await runGit(["init"], sourceRoot);
		await runGit(["config", "user.email", "test@example.com"], sourceRoot);
		await runGit(["config", "user.name", "Kit Test"], sourceRoot);
		await runGit(["add", "."], sourceRoot);
		await runGit(["commit", "-m", "Initial kit"], sourceRoot);
		const commit = (await runGit(["rev-parse", "HEAD"], sourceRoot)).trim();

		const inspection = await inspectKitSource({
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

	test("discovers conventional layouts without codex-kit.toml", async () => {
		const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-kit-source-"));
		await writeFixtureFile(sourceRoot, "skills/demo/SKILL.md", "# Demo\n");
		await writeFixtureFile(sourceRoot, "plugins/demo-plugin/.codex-plugin/plugin.json", '{"name":"demo-plugin"}');
		await writeFixtureFile(sourceRoot, "automations/demo-automation/automation.json", '{"name":"demo-automation"}');

		const inspection = await inspectKitSource({ source: sourceRoot });

		expect(inspection.items.map((item) => `${item.kind}:${item.name}`).sort()).toEqual([
			"automation:demo-automation",
			"plugin:demo-plugin",
			"skill:demo",
		]);
	});

	test("installs the reserved setup skill as a normal skill", async () => {
		const inspection = await inspectKitSource({ source: setupFixtureRoot });
		expect(inspection.items.map((item) => `${item.kind}:${item.name}`)).toEqual([
			"skill:setup",
		]);

		const workbenchRoot = await tempWorkbench();
		await applyKitAdd({
			source: setupFixtureRoot,
			workbenchRoot,
			apply: true,
		});

		expect(await readFile(path.join(workbenchRoot, ".agents/skills/setup/SKILL.md"), "utf8"))
			.toContain("When this skill exists");
		expect(await exists(path.join(workbenchRoot, ".agents/skills/setup/scripts/setup.mjs"))).toBe(true);
	});

	test("workspace ops setup script validates, retires, and tears down managed files", async () => {
		const workbenchRoot = await tempWorkbench();
		await applyKitAdd({
			source: setupFixtureRoot,
			workbenchRoot,
			apply: true,
		});
		const scriptPath = path.join(workbenchRoot, ".agents/skills/setup/scripts/setup.mjs");

		await runNodeScript(scriptPath, ["setup"], workbenchRoot);
		const validate = await runNodeScript(scriptPath, ["validate", "--json"], workbenchRoot);
		const validation = JSON.parse(validate.stdout) as { ok: boolean; setupId: string };
		expect(validation).toMatchObject({
			ok: true,
			setupId: "workspace-ops-baseline",
		});
		expect(await exists(path.join(workbenchRoot, ".codex/setup-doctor"))).toBe(false);

		await runNodeScript(scriptPath, ["retire"], workbenchRoot);
		expect(await exists(path.join(workbenchRoot, ".agents/skills/setup/SKILL.md"))).toBe(false);
		expect(await exists(path.join(workbenchRoot, ".agents/skills/setup/SKILL.retired.md"))).toBe(true);

		const doctor = await collectKitDoctor({ workbenchRoot });
		expect(doctor.changedDestinations).toEqual([]);
		expect(doctor.missingDestinations).toEqual([]);
		const reinstallPlan = await planKitAdd({ source: setupFixtureRoot, workbenchRoot });
		expect(reinstallPlan.items.find((item) => item.name === "setup")?.action).toBe("unchanged");

		await runNodeScript(scriptPath, ["teardown"], workbenchRoot);
		expect(await exists(path.join(workbenchRoot, "notes"))).toBe(false);
		expect(await exists(path.join(workbenchRoot, "runbooks/README.md"))).toBe(false);
		expect(await exists(path.join(workbenchRoot, ".codex/setup-receipts/workspace-ops-baseline.json"))).toBe(false);
	});
});

async function tempWorkbench(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "codex-kit-workbench-"));
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
			name: "workbench",
			interface: { displayName: "Workbench" },
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

async function runNodeScript(
	scriptPath: string,
	args: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string }> {
	const proc = spawn(process.execPath, [scriptPath, ...args], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(proc.stdout),
		collectText(proc.stderr),
		exitCodeFor(proc),
	]);
	if (exitCode !== 0) {
		throw new Error(
			`node ${path.basename(scriptPath)} ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`,
		);
	}
	return { stdout, stderr };
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
