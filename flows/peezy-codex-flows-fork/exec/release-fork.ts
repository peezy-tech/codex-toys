import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type FlowContext = {
	flow: {
		config?: Record<string, unknown>;
		event: {
			id: string;
			payload?: Record<string, unknown>;
		};
	};
};

type CommandResult = {
	label: string;
	command: string[];
	cwd: string;
	code: number | null;
	stdout: string;
	stderr: string;
};

type PatchBranch = {
	name: string;
	sha: string;
	subject: string;
};

type AppliedPatch = PatchBranch & {
	appliedSha: string;
};

let context: FlowContext;
let config: Record<string, unknown> = {};
let payload: Record<string, unknown> = {};
const commands: CommandResult[] = [];

function finish(value: Record<string, unknown>): never {
	process.stdout.write(`FLOW_RESULT ${JSON.stringify(value)}\n`);
	process.exit(0);
}

void main();

async function main(): Promise<void> {
	context = JSON.parse(await readStdinText()) as FlowContext;
	config = context.flow.config ?? {};
	payload = context.flow.event.payload ?? {};

	try {
	const sourcePackage = stringValue(payload.packageName);
	const sourceVersion = stringValue(payload.version);
	const packageName = stringConfig("package_name", "@peezy.tech/codex-flows");
	const codexPackageName = stringConfig("codex_package_name", "@peezy.tech/codex");

	if (!sourcePackage || !sourceVersion) {
		finish({ status: "failed", message: "downstream.release requires packageName and version." });
	}
	if (sourcePackage !== packageName && sourcePackage !== codexPackageName) {
		finish({ status: "skipped", message: `Ignoring downstream release for ${sourcePackage}.` });
	}

	const repoRoot = path.resolve(
		envConfig(stringConfig("codex_flows_repo_env", "")) ||
			stringConfig("codex_flows_repo", process.cwd()),
	);
	const repoFullName = stringConfig("repo_full_name", "peezy-tech/codex-flows");
	const sourceRemote = stringConfig("source_remote", "origin");
	const sourceBranch = stringConfig("source_branch", "main");
	const sourceRef = stringConfig(
		"source_ref",
		enabled("fetch", true) ? `refs/remotes/${sourceRemote}/${sourceBranch}` : sourceBranch,
	);
	const forkBranch = stringConfig("fork_branch", "fork");
	const patchPrefix = normalizePatchPrefix(stringConfig("patch_prefix", "patch/"));
	const worktreeDir = path.resolve(
		repoRoot,
		stringConfig("worktree_dir", ".codex/flow-artifacts/codex-flows-fork-worktree"),
	);
	const artifactDir = path.resolve(
		repoRoot,
		stringConfig("artifact_dir", ".codex/flow-artifacts/codex-flows-fork-release"),
	);
	const fetchEnabled = enabled("fetch", true);
	const refreshPatchBranches = enabled("refresh_patch_branches", true);
	const commitEnabled = enabled("commit", true);
	const pushEnabled = enabled("push", false);
	const publishEnabled = enabled("publish", false);
	const linkLocalPackage = enabled("link_local_package", false);
	const verifyCommands = stringArrayConfig("verify_commands", [
		"vp install",
		`vp run --filter ${packageName} release:check`,
	]);

	await requireCleanRepo(repoRoot);
	if (fetchEnabled) {
		await runChecked("fetch source branch", ["git", "fetch", sourceRemote, sourceBranch, "--prune"], repoRoot);
	}

	const baseSha = (await runChecked("resolve source ref", [
		"git",
		"rev-parse",
		"--verify",
		`${sourceRef}^{commit}`,
	], repoRoot)).stdout.trim();
	const patchBranches = await listPatchBranches(repoRoot, patchPrefix);
	if (patchBranches.length === 0) {
		finish({
			status: "blocked",
			message: `codex-flows fork release requires at least one ${patchPrefix} branch.`,
			artifacts: {
				repoRoot,
				sourceRef,
				baseSha,
				patchPrefix,
				commands: commandArtifacts(),
			},
		});
	}

	await prepareWorktree(repoRoot, worktreeDir, baseSha);
	const applied = await applyPatchStack({
		repoRoot,
		worktreeDir,
		patchBranches,
		refreshPatchBranches,
	});

	const baseVersion = sourcePackage === packageName
		? sourceVersion
		: await readPackageVersion(path.join(worktreeDir, "packages/codex-client/package.json"));
	const codexVersion = sourcePackage === codexPackageName
		? sourceVersion
		: envConfig(stringConfig("codex_version_env", "")) || await npmPackageVersion(codexPackageName);
	const forkVersion = forkPackageVersion(baseVersion, codexVersion);
	await applyReleaseMetadata({
		worktreeDir,
		packageName,
		codexPackageName,
		codexVersion,
		forkVersion,
	});

	for (const command of verifyCommands) {
		await runChecked(`verify: ${command}`, ["bash", "-lc", command], worktreeDir);
	}

	await rm(artifactDir, { recursive: true, force: true });
	await mkdir(artifactDir, { recursive: true });
	const pack = await runChecked(
		"pack fork release",
		["npm", "pack", "--pack-destination", artifactDir],
		path.join(worktreeDir, "packages/codex-client"),
	);
	const tarball = pack.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
	const tarballPath = tarball ? path.join(artifactDir, tarball) : undefined;

	if (linkLocalPackage) {
		await runChecked(
			"link fork release package",
			["pnpm", "link", "--global"],
			path.join(worktreeDir, "packages/codex-client"),
		);
	}

	const status = await runChecked("read fork release diff", ["git", "status", "--porcelain"], worktreeDir);
	if (commitEnabled && status.stdout.trim()) {
		await runChecked("stage fork release metadata", ["git", "add", "--all"], worktreeDir);
		await runChecked("commit fork release metadata", [
			"git",
			"commit",
			"-m",
			`release: codex-flows fork ${forkVersion}`,
		], worktreeDir);
	}
	const commitSha = (await runChecked("read fork release head", ["git", "rev-parse", "HEAD"], worktreeDir)).stdout.trim();
	if (commitEnabled || !status.stdout.trim()) {
		await runChecked("update fork branch", ["git", "branch", "-f", forkBranch, commitSha], repoRoot);
	}

	let pushed = false;
	if (pushEnabled) {
		await runChecked(
			"push fork branch",
			["git", "push", sourceRemote, `HEAD:refs/heads/${forkBranch}`, "--force-with-lease"],
			worktreeDir,
		);
		pushed = true;
	}

	let published = false;
	if (publishEnabled && tarballPath) {
		await runChecked("publish fork package", [
			"npm",
			"publish",
			tarballPath,
			"--access",
			"public",
			"--tag",
			stringConfig("fork_dist_tag", "fork"),
		], worktreeDir);
		published = true;
	}

		finish({
			status: status.stdout.trim() || applied.length > 0 ? "changed" : "completed",
			message: `Prepared ${packageName} fork ${forkVersion} from ${sourcePackage}@${sourceVersion}.`,
			artifacts: {
				eventId: context.flow.event.id,
				sourcePackage,
				sourceVersion,
				packageName,
				baseVersion,
				codexPackageName,
				codexVersion,
				forkVersion,
				repoRoot,
				sourceRef,
				forkBranch,
				patchPrefix,
				baseSha,
				commitSha,
				applied,
				refreshedPatchBranches: refreshPatchBranches,
				worktreeDir,
				tarballPath,
				linked: linkLocalPackage,
				pushed,
				published,
				candidateRefs: [{
					kind: "branch",
					repo: repoFullName,
					ref: `refs/heads/${forkBranch}`,
					sha: commitSha,
					pushed,
				}],
				commands: commandArtifacts(),
			},
		});
	} catch (error) {
		finish({
			status: "failed",
			message: error instanceof Error ? error.message : String(error),
			artifacts: { commands: commandArtifacts() },
		});
	}
}

async function requireCleanRepo(repoRoot: string): Promise<void> {
	const status = await runChecked("read repository status", ["git", "status", "--porcelain"], repoRoot);
	const relevant = status.stdout
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.filter((line) => !line.includes(".codex/flow-artifacts/"));
	if (relevant.length > 0) {
		finish({
			status: "blocked",
			message: "codex-flows checkout has local changes before fork release preparation.",
			artifacts: { status: relevant.join("\n"), commands: commandArtifacts() },
		});
	}
}

async function prepareWorktree(repoRoot: string, worktreeDir: string, baseSha: string): Promise<void> {
	if (existsSync(worktreeDir)) {
		await run("remove old fork worktree", ["git", "worktree", "remove", "--force", worktreeDir], repoRoot);
		await rm(worktreeDir, { recursive: true, force: true });
	}
	await run("prune worktrees", ["git", "worktree", "prune"], repoRoot);
	await runChecked("create fork worktree", ["git", "worktree", "add", "--detach", worktreeDir, baseSha], repoRoot);
}

async function applyPatchStack(input: {
	repoRoot: string;
	worktreeDir: string;
	patchBranches: PatchBranch[];
	refreshPatchBranches: boolean;
}): Promise<AppliedPatch[]> {
	const applied: AppliedPatch[] = [];
	for (const patchBranch of input.patchBranches) {
		const pick = await run(`apply ${patchBranch.name}`, ["git", "cherry-pick", patchBranch.sha], input.worktreeDir, {
			allowFailure: true,
		});
		if (pick.code !== 0) {
			const status = await run("patch rebuild conflict status", ["git", "status", "--short", "--branch"], input.worktreeDir, {
				allowFailure: true,
			});
			const unmerged = await run("unmerged files", ["git", "diff", "--name-only", "--diff-filter=U"], input.worktreeDir, {
				allowFailure: true,
			});
			finish({
				status: "needs_intervention",
				message: `codex-flows fork rebuild stopped while applying ${patchBranch.name}.`,
				artifacts: {
					failedPatch: patchBranch,
					applied,
					statusOutput: status.stdout,
					unmergedFiles: lines(unmerged.stdout),
					commands: commandArtifacts(),
				},
			});
		}
		const appliedSha = (await runChecked("read applied patch head", ["git", "rev-parse", "HEAD"], input.worktreeDir)).stdout.trim();
		const appliedPatch = { ...patchBranch, appliedSha };
		applied.push(appliedPatch);
		if (input.refreshPatchBranches) {
			await runChecked(
				`refresh ${patchBranch.name}`,
				["git", "branch", "-f", patchBranch.name, appliedSha],
				input.repoRoot,
			);
		}
	}
	return applied;
}

async function listPatchBranches(repoRoot: string, patchPrefix: string): Promise<PatchBranch[]> {
	const refsPath = `refs/heads/${patchPrefix.replace(/\/+$/, "")}`;
	const result = await run("list patch branches", [
		"git",
		"for-each-ref",
		"--format=%(refname:short)%09%(objectname)%09%(contents:subject)",
		refsPath,
	], repoRoot, { allowFailure: true });
	if (result.code !== 0 || !result.stdout.trim()) {
		return [];
	}
	return result.stdout
		.trim()
		.split(/\r?\n/)
		.map((line) => {
			const [name = "", sha = "", subject = ""] = line.split("\t");
			return { name, sha, subject };
		})
		.filter((branch) => branch.name.startsWith(patchPrefix))
		.sort((left, right) => left.name.localeCompare(right.name));
}

async function applyReleaseMetadata(input: {
	worktreeDir: string;
	packageName: string;
	codexPackageName: string;
	codexVersion: string;
	forkVersion: string;
}): Promise<void> {
	const packageJsonPath = path.join(input.worktreeDir, "packages/codex-client/package.json");
	const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
	packageJson.version = input.forkVersion;
	packageJson.dependencies = sortRecord({
		...(recordValue(packageJson.dependencies)),
		[input.codexPackageName]: input.codexVersion,
	});
	await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, "\t")}\n`, "utf8");
}

function forkPackageVersion(baseVersion: string, codexVersion: string): string {
	const prefix = sanitizePrerelease(stringConfig("fork_version_prefix", "peezy"));
	const codex = sanitizePrerelease(codexVersion);
	return baseVersion.includes("-")
		? `${baseVersion}.${prefix}.${codex}`
		: `${baseVersion}-${prefix}.${codex}`;
}

function sanitizePrerelease(value: string): string {
	return value
		.replace(/^v/, "")
		.replace(/[^0-9A-Za-z]+/g, ".")
		.split(".")
		.filter(Boolean)
		.join(".") || "0";
}

async function readPackageVersion(packageJsonPath: string): Promise<string> {
	const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: string };
	if (!packageJson.version) {
		throw new Error(`Could not read package version from ${packageJsonPath}`);
	}
	return packageJson.version;
}

async function npmPackageVersion(packageName: string): Promise<string> {
	const result = await runChecked("read latest Codex fork package version", ["npm", "view", packageName, "version", "--json"], process.cwd());
	return JSON.parse(result.stdout) as string;
}

async function runChecked(label: string, command: string[], cwd: string): Promise<CommandResult> {
	const result = await run(label, command, cwd);
	if (result.code !== 0) {
		throw new Error(`${label} failed with exit ${result.code}:\n${result.stderr || result.stdout}`);
	}
	return result;
}

async function run(
	label: string,
	command: string[],
	cwd: string,
	options: { allowFailure?: boolean } = {},
): Promise<CommandResult> {
	process.stderr.write(`+ ${label}: ${command.join(" ")}\n`);
	const proc = spawn(command[0] ?? "", command.slice(1), {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const [stdout, stderr, code] = await Promise.all([
		collectText(proc.stdout),
		collectText(proc.stderr),
		exitCodeFor(proc),
	]);
	if (stdout) process.stderr.write(stdout);
	if (stderr) process.stderr.write(stderr);
	const result = { label, command, cwd, code, stdout, stderr };
	commands.push(result);
	if (code !== 0 && !options.allowFailure) {
		throw new Error(`${label} failed with exit ${code}:\n${stderr || stdout}`);
	}
	return result;
}

function commandArtifacts(): Array<Record<string, unknown>> {
	return commands.map((command) => ({
		...command,
		stdout: truncate(command.stdout),
		stderr: truncate(command.stderr),
	}));
}

function enabled(name: string, fallback: boolean): boolean {
	const envName = `CODEX_FLOW_${name.toUpperCase()}`;
	const envValue = process.env[envName];
	if (envValue !== undefined) {
		return booleanValue(envValue);
	}
	const value = config[name];
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return booleanValue(value);
	return fallback;
}

function stringConfig(name: string, fallback: string): string {
	const value = config[name];
	return typeof value === "string" && value.trim() ? value : fallback;
}

function stringArrayConfig(name: string, fallback: string[]): string[] {
	const value = config[name];
	if (!Array.isArray(value)) return fallback;
	const entries = value.filter((entry): entry is string =>
		typeof entry === "string" && entry.trim().length > 0
	);
	return entries.length > 0 ? entries : fallback;
}

function envConfig(name: string): string | undefined {
	return name ? process.env[name]?.trim() || undefined : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function sortRecord(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function booleanValue(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizePatchPrefix(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return "patch/";
	}
	return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function lines(value: string): string[] {
	return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function truncate(value: string, max = 4000): string {
	if (value.length <= max) {
		return value;
	}
	return `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
}

async function readStdinText(): Promise<string> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
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
