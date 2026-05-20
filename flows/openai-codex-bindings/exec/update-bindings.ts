import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type FlowContext = {
	flow: {
		name?: string;
		root?: string;
		step?: string;
		config?: Record<string, unknown>;
		event: {
			id: string;
			type: string;
			payload: Record<string, unknown>;
		};
	};
	runtime?: {
		workspaceBackendUrl?: string;
	};
};

type CommandResult = {
	label: string;
	cmd: string[];
	cwd: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
};

const context = JSON.parse(await readStdinText()) as FlowContext;
const config = context.flow.config ?? {};
const repoRoot = path.resolve(envConfig(stringConfig("codex_flows_repo_env", "")) || stringConfig("codex_flows_repo", process.cwd()));
const commands: CommandResult[] = [];

try {
	const tag = stringValue(context.flow.event.payload.tag, "payload.tag");
	const version = versionFromTag(tag);
	const packageName = stringConfig("package_name", "@peezy.tech/codex-flows");
	const generatedDir = path.resolve(repoRoot, stringConfig("generated_dir", "packages/codex-client/src/app-server/generated"));
	const packageJsonPath = path.resolve(repoRoot, stringConfig("package_json", "packages/codex-client/package.json"));

	const published = await npmPackageExists(packageName, version);
	if (published && !enabled("force", false)) {
		finish("skipped", `${packageName}@${version} is already published.`, { version, tag });
	}

	await requireCleanWorktree();
	await run("regenerate app-server TypeScript bindings", [
		"npx",
		"-y",
		`@openai/codex@${version}`,
		"app-server",
		"generate-ts",
		"--experimental",
		"--out",
		generatedDir,
	]);

	await updatePackageVersion(packageJsonPath, version);
	await run("refresh dependencies", ["vp", "install"]);

	const changedStatus = await run("changed file status", ["git", "status", "--short"]);
	if (!changedStatus.stdout.trim()) {
		finish("skipped", `No generated binding changes for ${tag}.`, { version, tag });
	}

	const followupTurn = await maybeRunFollowupTurn({ tag, version, changedStatus: changedStatus.stdout });

	await run("codex-flows package release check", ["vp", "run", "--filter", packageName, "release:check"]);
	await run("workspace typecheck", ["vp", "run", "check:types"]);
	await run("workspace tests", ["vp", "run", "test"]);
	await run("git diff check", ["git", "diff", "--check"]);

	const status = await run("final git status", ["git", "status", "--short"]);

	if (enabled("commit", true)) {
		await commitRemainingChanges({ version, generatedDir, packageJsonPath });
	}

	if (enabled("push", false)) {
		await run("push jojo main", ["git", "push", "origin", "HEAD:main"]);
	}

	if (enabled("publish", false)) {
		await run("push GitHub main", ["git", "push", "github", "HEAD:main"]);
		await run("trigger GitHub trusted publish", [
			"gh",
			"workflow",
			"run",
			stringConfig("github_publish_workflow", "publish-codex-flows.yml"),
			"--repo",
			stringConfig("github_repo", "peezy-tech/codex-flows"),
			"-f",
			`confirm_package=${packageName}`,
		]);
	}

	finish("changed", `${packageName} regenerated for openai/codex ${tag}.`, {
		version,
		tag,
		committed: enabled("commit", true),
		pushed: enabled("push", false),
		published: enabled("publish", false),
		followupTurn,
	});
} catch (error) {
	finish("failed", error instanceof Error ? error.message : String(error));
}

async function requireCleanWorktree(): Promise<void> {
	const status = await run("dirty worktree check", ["git", "status", "--porcelain=v1"]);
	if (status.stdout.trim()) {
		finish("blocked", "codex-flows checkout has local changes before the release update.", {
			dirtyStatus: status.stdout,
		});
	}
}

async function npmPackageExists(packageName: string, version: string): Promise<boolean> {
	const result = await run("published package check", [
		"npm",
		"view",
		`${packageName}@${version}`,
		"version",
		"--json",
	], { allowFailure: true });
	return result.exitCode === 0 && result.stdout.includes(version);
}

async function updatePackageVersion(packageJsonPath: string, version: string): Promise<void> {
	const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
	parsed.version = version;
	await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, "\t")}\n`);
}

async function maybeRunFollowupTurn(input: {
	tag: string;
	version: string;
	changedStatus: string;
}): Promise<Record<string, unknown> | undefined> {
	if (!enabled("followup_turn", true)) {
		return undefined;
	}
	const runCodexAgentTurnFromFlow = await loadRunCodexAgentTurnFromFlow();
	const threadJson = stringConfig("followup_thread_json", ".codex/flow-artifacts/openai-codex-bindings-thread.json");
	const prompt = [
		`OpenAI Codex ${input.tag} regenerated app-server TypeScript bindings for @peezy.tech/codex-flows ${input.version}.`,
		"",
		"Review the changed files and make any source, test, or export updates needed so the package still builds against the regenerated bindings.",
		"Keep changes focused on codex-flows compatibility with the regenerated app-server surface.",
		"If you make source, test, export, or generated-file changes, commit them before finishing.",
		`Use a focused commit message such as "flow: update codex-flows for openai codex ${input.version}".`,
		"Do not push, publish, or edit release metadata beyond what this flow already changed.",
		"",
		"Current changed files:",
		input.changedStatus.trim(),
	].join("\n");
	const turn = await runCodexAgentTurnFromFlow(
		{
			flow: {
				name: context.flow.name ?? "openai-codex-bindings",
				root: repoRoot,
				step: context.flow.step ?? "regenerate-bindings",
				event: context.flow.event,
			},
			runtime: context.runtime,
		},
		{
			prompt,
			cwd: repoRoot,
			approvalPolicy: "never",
			sandbox: "danger-full-access",
			appServerUrl: process.env.CODEX_APP_SERVER_URL,
			requestTimeoutMs: numberConfig("followup_request_timeout_ms", 900000),
			wait: {
				timeoutMs: numberConfig("followup_wait_timeout_ms", 900000),
				throwOnFailure: true,
			},
			exportThreadJson: threadJson || false,
		},
	) as {
		artifacts?: Record<string, unknown>;
		threadId?: string;
		turnId?: string;
		threadJsonPath?: string;
	};
	return {
		threadId: turn.threadId,
		turnId: turn.turnId,
		threadJsonPath: turn.threadJsonPath,
		...(turn.artifacts ?? {}),
	};
}

async function commitRemainingChanges(input: {
	version: string;
	generatedDir: string;
	packageJsonPath: string;
}): Promise<CommandResult | undefined> {
	const status = await run("dirty check before release commit", ["git", "status", "--porcelain=v1"]);
	if (!status.stdout.trim()) {
		return undefined;
	}
	await run("stage release update", [
		"git",
		"add",
		"--",
		input.generatedDir,
		input.packageJsonPath,
		path.join(repoRoot, "pnpm-lock.yaml"),
		path.join(repoRoot, "packages/codex-client/src"),
		path.join(repoRoot, "packages/codex-client/test"),
		path.join(repoRoot, "packages/codex-client/scripts"),
	]);
	const staged = await run("staged release update status", ["git", "diff", "--cached", "--quiet"], { allowFailure: true });
	if (staged.exitCode === 0) {
		return undefined;
	}
	return await run("commit release update", [
		"git",
		"commit",
		"-m",
		`flow: update codex-flows for openai codex ${input.version}`,
	]);
}

async function loadRunCodexAgentTurnFromFlow(): Promise<(
	context: unknown,
	options: Record<string, unknown>,
) => Promise<unknown>> {
	const candidates = [
		"@peezy.tech/codex-flows/flows",
		pathToFileURL(path.join(repoRoot, "packages/codex-client/src/app-server/flows.ts")).href,
	];
	const errors: string[] = [];
	for (const candidate of candidates) {
		try {
			const module = await import(candidate) as { runCodexAgentTurnFromFlow?: unknown };
			if (typeof module.runCodexAgentTurnFromFlow === "function") {
				return module.runCodexAgentTurnFromFlow as (
					context: unknown,
					options: Record<string, unknown>,
				) => Promise<unknown>;
			}
			errors.push(`${candidate}: runCodexAgentTurnFromFlow is not exported`);
		} catch (error) {
			errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`Could not load codex-flows follow-up turn helper:\n${errors.join("\n")}`);
}

async function run(
	label: string,
	cmd: string[],
	options: { allowFailure?: boolean; cwd?: string } = {},
): Promise<CommandResult> {
	const child = spawn(cmd[0] ?? "", cmd.slice(1), {
		cwd: options.cwd ?? repoRoot,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(child.stdout),
		collectText(child.stderr),
		exitCodeFor(child),
	]);
	const result = { label, cmd, cwd: options.cwd ?? repoRoot, exitCode, stdout, stderr };
	commands.push(result);
	if (exitCode !== 0 && !options.allowFailure) {
		throw new Error(`${label} failed with exit ${exitCode}:\n${stderr || stdout}`);
	}
	return result;
}

function finish(status: string, message: string, artifacts: Record<string, unknown> = {}): never {
	const trimmedCommands = commands.map((command) => ({
		...command,
		stdout: truncate(command.stdout),
		stderr: truncate(command.stderr),
	}));
	console.log(`FLOW_RESULT ${JSON.stringify({ status, message, artifacts: { ...artifacts, commands: trimmedCommands } })}`);
	process.exit(0);
}

function enabled(name: string, fallback: boolean): boolean {
	const envName = `CODEX_FLOW_${name.toUpperCase()}`;
	const envValue = process.env[envName];
	if (envValue !== undefined) {
		return ["1", "true", "yes", "on"].includes(envValue.trim().toLowerCase());
	}
	const value = config[name];
	return typeof value === "boolean" ? value : fallback;
}

function envConfig(name: string): string | undefined {
	return name.trim() ? process.env[name]?.trim() || undefined : undefined;
}

function stringConfig(name: string, fallback: string): string {
	const value = config[name];
	return typeof value === "string" && value.trim() ? value : fallback;
}

function numberConfig(name: string, fallback: number): number {
	const envName = `CODEX_FLOW_${name.toUpperCase()}`;
	const envValue = process.env[envName];
	const raw = envValue !== undefined ? envValue : config[name];
	const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : fallback;
	return Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${name} must be a non-empty string`);
	}
	return value;
}

function versionFromTag(tag: string): string {
	const match = tag.match(/[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?/);
	if (!match) {
		throw new Error(`Could not infer semantic version from release tag ${tag}`);
	}
	return match[0];
}

function truncate(value: string, max = 4000): string {
	return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
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
