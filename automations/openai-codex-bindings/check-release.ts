import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

type AutomationContext = {
	automation: {
		config?: Record<string, unknown>;
	};
	event?: {
		type?: string;
		source?: string;
		payload?: Record<string, unknown>;
	};
	prompt?: string;
	cwd?: string;
	workbenchRoot?: string;
	turn?: {
		start(params: {
			id?: string;
			prompt: string;
			cwd?: string;
			sandbox?: "read-only" | "workspace-write" | "danger-full-access";
			approvalPolicy?: "never" | "on-failure" | "on-request" | "untrusted";
		}): Promise<{ id?: string; threadId?: string; turnId?: string }>;
		wait(
			turn: { id?: string; threadId?: string; turnId?: string },
			options?: {
				timeoutMs?: number;
				pollIntervalMs?: number;
				throwOnFailure?: boolean;
			},
		): Promise<{ status?: string; outputText?: string; threadId?: string; turnId?: string }>;
	};
};

type CommandResult = {
	command: string;
	args: string[];
	stdout: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
};

type RunOptions = {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	allowFailure?: boolean;
	redact?: string[];
};

type CommandRunner = (
	command: string,
	args: string[],
	options?: RunOptions,
) => Promise<CommandResult>;

type CodexVersionCheck = {
	before: string;
	after: string;
	beforeVersion: string;
	afterVersion: string;
	targetVersion: string;
	actions: string[];
};

type ReleaseInfo = {
	itemId: string;
	externalId?: string;
	title: string;
	url?: string;
	version: string;
	tag?: string;
	updatedAt?: string;
	publishedAt?: string;
};

type PullRequestSummary = {
	number: number;
	url: string;
	state: string;
	title: string;
	headRefName: string;
	body?: string;
};

type BranchPlan = {
	slug: string;
	targetBranch: string;
	threadBranch: string;
};

export default async function refreshOpenAiCodexBindings(context: AutomationContext) {
	return await runOpenAiCodexBindings(context);
}

export async function runOpenAiCodexBindings(
	context: AutomationContext,
	options: { run?: CommandRunner; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
) {
	const config = context.automation.config ?? {};
	const env = options.env ?? process.env;
	const sourceId = stringValue(config.source_id, "openai-codex-releases");
	if (context.event?.type !== "feed.item" || context.event.source !== sourceId) {
		return {
			status: "skipped",
			reason: "event is not an openai/codex feed item",
		};
	}
	const payload = record(context.event.payload);
	if (stringValue(payload.sourceId) !== sourceId) {
		return {
			status: "skipped",
			reason: "feed item source did not match openai/codex source",
		};
	}

	const release = releaseInfoFromFeedItem(payload);
	const run = options.run ?? runCommand;
	const fetchImpl = options.fetch ?? fetch;
	const workbenchRoot = context.workbenchRoot || context.cwd || process.cwd();
	const codexCommand = stringValue(config.codex_command, "codex");
	const commandEnv = codexEnv(env);
	const codex = await ensureCodexAtLeast({
		codexCommand,
		targetVersion: release.version,
		run,
		env: commandEnv,
	});

	const owner = stringValue(config.target_owner, "peezy-tech");
	const repo = stringValue(config.target_repo, "codex-toys");
	const baseBranch = stringValue(config.target_base, "main");
	const branchPlan = branchPlanForRelease(release, {
		targetBranchPrefix: stringValue(config.target_branch_prefix, "codex/openai-codex-bindings"),
		threadBranchPrefix: stringValue(config.thread_branch_prefix, "thread/openai-codex-bindings"),
	});
	const githubUrl = stringValue(config.github_url, "https://github.com").replace(/\/+$/, "");
	const githubApiUrl = stringValue(config.github_api_url, "https://api.github.com").replace(/\/+$/, "");
	const generatedDir = normalizeRepoPath(stringValue(config.generated_dir, "packages/bridge/src/app-server/generated"));
	const packageManager = stringValue(config.package_manager, "pnpm");
	const tempRoot = await mkdtemp(path.join(tmpdir(), "codex-toys-openai-codex-"));
	const targetRepo = path.join(tempRoot, repo);
	const validations: CommandResult[] = [];

	try {
		await run("git", [
			"clone",
			"--depth",
			"1",
			"--branch",
			baseBranch,
			`${githubUrl}/${owner}/${repo}.git`,
			targetRepo,
		], { env: commandEnv });
		await run("git", ["switch", "-c", branchPlan.targetBranch], { cwd: targetRepo, env: commandEnv });
		validations.push(await run(packageManager, ["install", "--frozen-lockfile"], {
			cwd: targetRepo,
			env: commandEnv,
		}));
		await run(codexCommand, [
			"app-server",
			"generate-ts",
			"--experimental",
			"--out",
			generatedDir,
		], { cwd: targetRepo, env: commandEnv });

		const changedFiles = await gitChangedFiles(targetRepo, run, commandEnv);
		if (changedFiles.length === 0) {
			return {
				status: "skipped",
				reason: "generated app-server bindings are already current",
				release,
				codex,
				changedFiles,
				targetBranch: branchPlan.targetBranch,
				threadBranch: branchPlan.threadBranch,
			};
		}
		const nonGenerated = changedFiles.filter((file) => !pathInsideRepoDir(generatedDir, file));
		if (nonGenerated.length > 0) {
			throw new Error(`Refusing to continue because non-generated files changed: ${nonGenerated.join(", ")}`);
		}

		validations.push(await run(packageManager, ["--filter", "@codex-toys/bridge", "check:types"], {
			cwd: targetRepo,
			env: commandEnv,
		}));
		validations.push(await run(packageManager, ["--filter", "@codex-toys/bridge", "build"], {
			cwd: targetRepo,
			env: commandEnv,
		}));
		validations.push(await run(packageManager, ["--filter", "codex-toys", "check:types"], {
			cwd: targetRepo,
			env: commandEnv,
		}));
		validations.push(await run(packageManager, ["--filter", "codex-toys", "test"], {
			cwd: targetRepo,
			env: commandEnv,
		}));
		validations.push(await run(packageManager, ["--filter", "codex-toys", "smoke:exports"], {
			cwd: targetRepo,
			env: commandEnv,
		}));

		const diffStat = (await run("git", ["diff", "--stat", "--", generatedDir], {
			cwd: targetRepo,
			env: commandEnv,
		})).stdout.trim();
		const diff = (await run("git", ["diff", "--", generatedDir], {
			cwd: targetRepo,
			env: commandEnv,
		})).stdout;
		const analysis = await maybeAnalyzeDiff(context, {
			config,
			release,
			changedFiles,
			diff,
			diffStat,
			targetRepo,
			workbenchRoot,
		});

		await run("git", ["config", "user.name", "codex-toys-actions"], { cwd: targetRepo, env: commandEnv });
		await run("git", ["config", "user.email", "codex-toys-actions@users.noreply.github.com"], {
			cwd: targetRepo,
			env: commandEnv,
		});
		await run("git", ["add", "--", generatedDir], { cwd: targetRepo, env: commandEnv });
		await run("git", [
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			`Refresh Codex app-server bindings for ${release.version}`,
		], { cwd: targetRepo, env: commandEnv });

		const token = await githubToken(env, run);
		if (!token) {
			throw new Error("WORKSPACE_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, or a local gh auth token is required to push the branch and create or update the PR");
		}
		const existingPullRequest = await findOpenPullRequestForRelease({
			fetchImpl,
			githubApiUrl,
			token,
			owner,
			repo,
			baseBranch,
			targetBranch: branchPlan.targetBranch,
			release,
			title: `Refresh Codex app-server bindings for ${release.version}`,
		});
		if (existingPullRequest && existingPullRequest.headRefName !== branchPlan.targetBranch) {
			await renameBranch({
				fetchImpl,
				githubApiUrl,
				token,
				owner,
				repo,
				from: existingPullRequest.headRefName,
				to: branchPlan.targetBranch,
			});
		}
		await run("git", ["push", "--force", authenticatedGitUrl(githubUrl, owner, repo, token), `HEAD:${branchPlan.targetBranch}`], {
			cwd: targetRepo,
			env: gitTokenAuthEnv(commandEnv),
			redact: [token, encodeURIComponent(token)],
		});

		const prBody = renderPrBody({
			release,
			codex,
			changedFiles,
			diffStat,
			validations,
			analysis,
			targetRepo,
			branchPlan,
		});
		const pullRequest = await createOrUpdatePullRequest({
			fetchImpl,
			githubApiUrl,
			token,
			owner,
			repo,
			baseBranch,
			targetBranch: branchPlan.targetBranch,
			release,
			title: `Refresh Codex app-server bindings for ${release.version}`,
			body: prBody,
		});

		return {
			status: "pr-ready",
			release,
			codex,
			changedFiles,
			targetBranch: branchPlan.targetBranch,
			threadBranch: branchPlan.threadBranch,
			pullRequest,
			validations: validationSummaries(validations),
			analysis,
		};
	} finally {
		await rm(tempRoot, { recursive: true, force: true });
	}
}

export async function ensureCodexAtLeast(input: {
	codexCommand: string;
	targetVersion: string;
	run: CommandRunner;
	env?: NodeJS.ProcessEnv;
}): Promise<CodexVersionCheck> {
	const actions: string[] = [];
	const before = await input.run(input.codexCommand, ["--version"], { env: input.env });
	const beforeVersion = installedCodexVersion(before.stdout || before.stderr);
	let after = before;
	let afterVersion = beforeVersion;
	if (compareVersions(afterVersion, input.targetVersion) < 0) {
		actions.push("codex update");
		await input.run(input.codexCommand, ["update"], { env: input.env });
		after = await input.run(input.codexCommand, ["--version"], { env: input.env });
		afterVersion = installedCodexVersion(after.stdout || after.stderr);
	}
	if (compareVersions(afterVersion, input.targetVersion) < 0) {
		actions.push("standalone installer");
		await input.run("sh", [
			"-c",
			"curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
		], { env: input.env });
		after = await input.run(input.codexCommand, ["--version"], { env: input.env });
		afterVersion = installedCodexVersion(after.stdout || after.stderr);
	}
	if (compareVersions(afterVersion, input.targetVersion) < 0) {
		throw new Error(`Installed Codex ${afterVersion} is still older than release ${input.targetVersion}`);
	}
	return {
		before: before.stdout.trim() || before.stderr.trim(),
		after: after.stdout.trim() || after.stderr.trim(),
		beforeVersion,
		afterVersion,
		targetVersion: input.targetVersion,
		actions,
	};
}

export function releaseInfoFromFeedItem(payload: Record<string, unknown>): ReleaseInfo {
	const title = requiredString(payload.title, "feed item title");
	const url = stringValue(payload.url);
	const tag = releaseTagFromFeedItem(payload);
	const version = codexVersionFromReleaseText(title) ??
		(tag ? codexVersionFromReleaseText(tag) : undefined) ??
		(url ? codexVersionFromReleaseText(url) : undefined);
	if (!version) {
		throw new Error(`Could not determine Codex release version from feed item ${title}`);
	}
	return compactUndefined({
		itemId: requiredString(payload.id, "feed item id"),
		externalId: optionalString(payload.externalId),
		title,
		url,
		version,
		tag,
		updatedAt: optionalString(payload.updatedAt),
		publishedAt: optionalString(payload.publishedAt),
	});
}

export function branchSlugForRelease(release: Pick<ReleaseInfo, "tag" | "version" | "externalId" | "itemId">): string {
	const source = release.tag || `v${release.version}` || release.externalId || release.itemId;
	const slug = source
		.replace(/^refs\/tags\//, "")
		.replace(/[^0-9A-Za-z._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	if (slug) {
		return slug;
	}
	return `release-${shortStableHash(release.externalId || release.itemId || release.version)}`;
}

export function targetBranchForRelease(
	release: Pick<ReleaseInfo, "tag" | "version" | "externalId" | "itemId">,
	prefix = "codex/openai-codex-bindings",
): string {
	return branchWithPrefix(prefix, branchSlugForRelease(release));
}

export function threadBranchForRelease(
	release: Pick<ReleaseInfo, "tag" | "version" | "externalId" | "itemId">,
	prefix = "thread/openai-codex-bindings",
): string {
	return branchWithPrefix(prefix, branchSlugForRelease(release));
}

function branchPlanForRelease(
	release: ReleaseInfo,
	input: {
		targetBranchPrefix: string;
		threadBranchPrefix: string;
	},
): BranchPlan {
	const slug = branchSlugForRelease(release);
	return {
		slug,
		targetBranch: branchWithPrefix(input.targetBranchPrefix, slug),
		threadBranch: branchWithPrefix(input.threadBranchPrefix, slug),
	};
}

function branchWithPrefix(prefix: string, slug: string): string {
	const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
	if (!cleanPrefix) {
		throw new Error("branch prefix must be a non-empty string");
	}
	return `${cleanPrefix}/${slug}`;
}

function shortStableHash(value: string): string {
	let hash = 5381;
	for (let index = 0; index < value.length; index += 1) {
		hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
	}
	return (hash >>> 0).toString(36);
}

export function codexVersionFromReleaseText(value: string): string | undefined {
	const match = value.match(/(?:^|[^\d])(?:rust-v|v)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
	return match?.[1];
}

export function installedCodexVersion(output: string): string {
	const version = codexVersionFromReleaseText(output);
	if (!version) {
		throw new Error(`Could not parse Codex version from: ${output.trim()}`);
	}
	return version;
}

export function compareVersions(left: string, right: string): number {
	const a = semverParts(left);
	const b = semverParts(right);
	for (let index = 0; index < 3; index += 1) {
		const leftPart = a[index] ?? 0;
		const rightPart = b[index] ?? 0;
		if (leftPart !== rightPart) {
			return leftPart > rightPart ? 1 : -1;
		}
	}
	return 0;
}

function releaseTagFromFeedItem(payload: Record<string, unknown>): string | undefined {
	const url = stringValue(payload.url);
	if (!url) {
		return undefined;
	}
	const last = url.split("/").filter(Boolean).pop();
	return last ? decodeURIComponent(last) : undefined;
}

function semverParts(value: string): [number, number, number] {
	const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) {
		throw new Error(`Invalid semantic version: ${value}`);
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

async function gitChangedFiles(
	cwd: string,
	run: CommandRunner,
	env: NodeJS.ProcessEnv,
): Promise<string[]> {
	const status = await run("git", ["status", "--short", "--porcelain"], { cwd, env });
	return status.stdout
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.map((line) => {
			const file = line.slice(3).trim();
			const renamed = file.split(" -> ").pop() ?? file;
			return normalizeRepoPath(renamed);
		})
		.sort();
}

async function maybeAnalyzeDiff(
	context: AutomationContext,
	input: {
		config: Record<string, unknown>;
		release: ReleaseInfo;
		changedFiles: string[];
		diff: string;
		diffStat: string;
		targetRepo: string;
		workbenchRoot: string;
	},
): Promise<unknown> {
	if (!booleanValue(input.config.start_turn, false)) {
		return fallbackAnalysis(input);
	}
	if (!context.turn) {
		throw new Error("Codex analysis is required but no turn host is available");
	}
	const turn = await context.turn.start({
		id: `openai-codex-bindings-${input.release.version}`,
		cwd: input.targetRepo,
		sandbox: "read-only",
		approvalPolicy: "never",
		prompt: analysisPrompt(input),
	});
	const snapshot = await context.turn.wait(turn, {
		timeoutMs: numberValue(input.config.turn_timeout_ms, 1_800_000),
		pollIntervalMs: numberValue(input.config.poll_interval_ms, 1500),
		throwOnFailure: true,
	});
	if (snapshot.status && snapshot.status !== "completed") {
		throw new Error(`Codex analysis turn ${snapshot.turnId ?? turn.turnId ?? "unknown"} finished with status ${snapshot.status}`);
	}
	return {
		status: "completed",
		turn,
		snapshot: {
			status: snapshot.status,
			threadId: snapshot.threadId,
			turnId: snapshot.turnId,
			outputText: snapshot.outputText,
		},
		summary: snapshot.outputText?.trim() || fallbackAnalysis(input).summary,
	};
}

function fallbackAnalysis(input: {
	release: ReleaseInfo;
	changedFiles: string[];
	diffStat: string;
}): { status: "fallback"; summary: string } {
	return {
		status: "fallback",
		summary: [
			`Generated Codex app-server bindings for ${input.release.version}.`,
			`Changed files: ${input.changedFiles.join(", ")}`,
			input.diffStat ? `Diff stat: ${input.diffStat}` : undefined,
		].filter(Boolean).join("\n"),
	};
}

function analysisPrompt(input: {
	release: ReleaseInfo;
	changedFiles: string[];
	diff: string;
	diffStat: string;
}): string {
	return [
		`Review regenerated Codex app-server TypeScript bindings for Codex ${input.release.version}.`,
		input.release.url ? `Release URL: ${input.release.url}` : undefined,
		"",
		"Changed files:",
		...input.changedFiles.map((file) => `- ${file}`),
		"",
		"Diff stat:",
		input.diffStat || "(none)",
		"",
		"Diff:",
		boundedText(input.diff, 60_000),
	].filter((line) => line !== undefined).join("\n");
}

function renderPrBody(input: {
	release: ReleaseInfo;
	codex: CodexVersionCheck;
	changedFiles: string[];
	diffStat: string;
	validations: CommandResult[];
	analysis: unknown;
	targetRepo: string;
	branchPlan: BranchPlan;
}): string {
	return [
		"## Generated Update",
		"",
		`Source: openai/codex ${input.release.version}`,
		input.release.url ? `Release URL: ${input.release.url}` : undefined,
		`Codex before: ${input.codex.before}`,
		`Codex after: ${input.codex.after}`,
		`Update actions: ${input.codex.actions.length > 0 ? input.codex.actions.join(", ") : "none"}`,
		`Target repo: ${input.targetRepo}`,
		`Code branch: \`${input.branchPlan.targetBranch}\``,
		`Thread state branch: \`${input.branchPlan.threadBranch}\``,
		`Changed files: ${input.changedFiles.join(", ")}`,
		"",
		"## Validation",
		"",
		...validationSummaries(input.validations).map((item) => `- \`${item.command}\`: ${item.status}`),
		"",
		"## Diff Stat",
		"",
		"```text",
		input.diffStat || "(none)",
		"```",
		"",
		"## Codex Analysis",
		"",
		analysisText(input.analysis),
		"",
		`<!-- codex-toys:openai-codex-bindings release=${input.branchPlan.slug} -->`,
	].filter((line) => line !== undefined).join("\n");
}

function validationSummaries(results: CommandResult[]): Array<{
	command: string;
	status: string;
	durationMs: number;
}> {
	return results.map((result) => ({
		command: [result.command, ...result.args].join(" "),
		status: result.exitCode === 0 ? "passed" : `failed (${result.exitCode})`,
		durationMs: result.durationMs,
	}));
}

function analysisText(value: unknown): string {
	const input = isRecord(value) ? value : {};
	const summary = stringValue(input.summary);
	if (summary) {
		return summary;
	}
	return "Codex analysis was not requested for this run.";
}

async function createOrUpdatePullRequest(input: {
	fetchImpl: typeof fetch;
	githubApiUrl: string;
	token: string;
	owner: string;
	repo: string;
	baseBranch: string;
	targetBranch: string;
	release: ReleaseInfo;
	title: string;
	body: string;
}): Promise<PullRequestSummary> {
	const existing = await findOpenPullRequestForRelease(input);
	const pr = existing
		? await githubRequest<Record<string, unknown>>(input, "PATCH", `/repos/${input.owner}/${input.repo}/pulls/${existing.number}`, {
			title: input.title,
			body: input.body,
		})
		: await githubRequest<Record<string, unknown>>(input, "POST", `/repos/${input.owner}/${input.repo}/pulls`, {
			title: input.title,
			body: input.body,
			head: input.targetBranch,
			base: input.baseBranch,
		});
	return pullRequestSummary(pr);
}

async function findOpenPullRequestForRelease(input: {
	fetchImpl: typeof fetch;
	githubApiUrl: string;
	token: string;
	owner: string;
	repo: string;
	baseBranch: string;
	targetBranch: string;
	release: ReleaseInfo;
	title: string;
}): Promise<PullRequestSummary | undefined> {
	const headQuery = new URLSearchParams({
		state: "open",
		head: `${input.owner}:${input.targetBranch}`,
		base: input.baseBranch,
	});
	const byHead = await githubRequest<Array<Record<string, unknown>>>(input, "GET", `/repos/${input.owner}/${input.repo}/pulls?${headQuery}`);
	if (byHead[0]) {
		return pullRequestSummary(byHead[0]);
	}
	const baseQuery = new URLSearchParams({
		state: "open",
		base: input.baseBranch,
		per_page: "100",
	});
	const open = await githubRequest<Array<Record<string, unknown>>>(input, "GET", `/repos/${input.owner}/${input.repo}/pulls?${baseQuery}`);
	const slug = branchSlugForRelease(input.release);
	const match = open.find((candidate) => {
		const title = stringValue(candidate.title);
		const body = stringValue(candidate.body);
		return title === input.title ||
			body.includes(`codex-toys:openai-codex-bindings release=${slug}`) ||
			(body.includes("codex-toys:openai-codex-bindings") && title.includes(input.release.version));
	});
	return match ? pullRequestSummary(match) : undefined;
}

async function renameBranch(input: {
	fetchImpl: typeof fetch;
	githubApiUrl: string;
	token: string;
	owner: string;
	repo: string;
	from: string;
	to: string;
}): Promise<void> {
	await githubRequest<Record<string, unknown>>(input, "POST", `/repos/${input.owner}/${input.repo}/branches/${encodeURIComponent(input.from)}/rename`, {
		new_name: input.to,
	});
}

function pullRequestSummary(pr: Record<string, unknown>): PullRequestSummary {
	const head = record(pr.head);
	return {
		number: requiredNumber(pr.number, "pull request number"),
		url: requiredString(pr.html_url, "pull request url"),
		state: requiredString(pr.state, "pull request state"),
		title: requiredString(pr.title, "pull request title"),
		headRefName: requiredString(head.ref, "pull request head ref"),
		body: optionalString(pr.body),
	};
}

async function githubRequest<T>(
	input: { fetchImpl: typeof fetch; githubApiUrl: string; token: string },
	method: string,
	pathname: string,
	body?: unknown,
): Promise<T> {
	const response = await input.fetchImpl(`${input.githubApiUrl}${pathname}`, {
		method,
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			Authorization: `Bearer ${input.token}`,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(`GitHub API ${method} ${pathname} failed with HTTP ${response.status}: ${await response.text()}`);
	}
	return await response.json() as T;
}

async function githubToken(env: NodeJS.ProcessEnv, run: CommandRunner): Promise<string> {
	const token = env.WORKSPACE_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN;
	if (token) {
		return token;
	}
	const gh = await run("gh", ["auth", "token"], { allowFailure: true, env });
	return gh.exitCode === 0 ? gh.stdout.trim() : "";
}

function authenticatedGitUrl(githubUrl: string, owner: string, repo: string, token: string): string {
	const parsed = new URL(githubUrl);
	return `${parsed.protocol}//x-access-token:${encodeURIComponent(token)}@${parsed.host}/${owner}/${repo}.git`;
}

function gitTokenAuthEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
	};
}

function codexEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const home = env.HOME || homedir();
	const localBin = path.join(home, ".local", "bin");
	return {
		...env,
		CODEX_NON_INTERACTIVE: "1",
		PATH: [localBin, env.PATH].filter(Boolean).join(":"),
	};
}

async function runCommand(
	command: string,
	args: string[],
	options: RunOptions = {},
): Promise<CommandResult> {
	const startedAt = Date.now();
	const proc = spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(proc.stdout),
		collectText(proc.stderr),
		exitCodeFor(proc),
	]);
	const result = {
		command,
		args,
		stdout: redactText(stdout, options.redact),
		stderr: redactText(stderr, options.redact),
		exitCode: exitCode ?? 1,
		durationMs: Date.now() - startedAt,
	};
	if (result.exitCode !== 0 && !options.allowFailure) {
		throw new Error(`Command failed (${result.exitCode}): ${command} ${args.join(" ")}\n${result.stderr || result.stdout}`);
	}
	return result;
}

function collectText(stream: NodeJS.ReadableStream | null): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = "";
		if (!stream) {
			resolve(output);
			return;
		}
		stream.setEncoding("utf8");
		stream.on("data", (chunk: string) => {
			output += chunk;
		});
		stream.once("error", reject);
		stream.once("end", () => resolve(output));
	});
}

function exitCodeFor(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
}

function redactText(value: string, secrets?: string[]): string {
	let result = value;
	for (const secret of secrets ?? []) {
		if (secret) {
			result = result.split(secret).join("[redacted]");
		}
	}
	return result;
}

function normalizeRepoPath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function pathInsideRepoDir(parent: string, child: string): boolean {
	const normalizedParent = normalizeRepoPath(parent);
	const normalizedChild = normalizeRepoPath(child);
	return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function boundedText(value: string, limit: number): string {
	if (value.length <= limit) {
		return value;
	}
	return `${value.slice(0, limit)}\n... truncated ${value.length - limit} bytes ...`;
}

function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
	return optionalString(value) ?? fallback;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, label: string): string {
	const result = stringValue(value);
	if (!result) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return result;
}

function requiredNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must be a number`);
	}
	return value;
}

function numberValue(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function compactUndefined<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) {
		if (value[key] === undefined) {
			delete value[key];
		}
	}
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
