import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import {
	createTurnAutomationHost,
	resolveTurnAutomationTarget,
	runTurnAutomationScript,
	startAutomationTurnWithRequest,
	waitAutomationTurnWithRequest,
} from "./turn-automation.ts";
import { parseJsonText } from "@codex-toys/bridge/json";

export type WorkbenchModeInput = "auto" | "local" | "actions";
export type WorkbenchMode = "local" | "actions";

export type WorkbenchSurface = {
	key: string;
	kind: string;
	homeChannelId?: string;
	workbenchForumChannelId?: string;
	taskThreadsChannelId?: string;
};

export type WorkbenchTask =
	| {
			id: string;
			enabled: boolean;
			kind: "skill";
			skill: string;
			schedule?: string;
			var?: string;
	  }
	| {
			id: string;
			enabled: boolean;
			kind: "automation";
			automation: string;
			event?: Record<string, unknown>;
			prompt?: string;
			cwd?: string;
			schedule?: string;
	  }
	| {
			id: string;
			enabled: boolean;
			kind: "command";
			command: string[];
			schedule?: string;
	  };

export type WorkbenchReactiveRule = {
	id: string;
	enabled: boolean;
	task: string;
	consecutiveFailuresGte: number;
	kind: "skill";
	skill: string;
};

export type WorkbenchConfig = {
	name: string;
	surfaces: WorkbenchSurface[];
	tasks: WorkbenchTask[];
	reactive: WorkbenchReactiveRule[];
	path: string;
};

export type WorkbenchContext = {
	mode: WorkbenchMode;
	requestedMode: WorkbenchModeInput;
	repoRoot: string;
	configPath: string;
	workbenchCodexHome: string;
	runtimeCodexHome: string;
	stateRoot: string;
	localStateRoot: string;
	actionsStateRoot: string;
	globalCodexHome: string;
	actionsCommitPaths: string[];
};

export type DeferredReasoningEffort =
	| "none"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

export type DeferredRunDependency = {
	kind: "deferred-run";
	intentId: string;
	status?: "completed" | "failed" | "canceled" | "terminal";
};

export type WorkbenchRunRecord = {
	id: string;
	taskId: string;
	status: "completed" | "failed" | "skipped";
	kind: WorkbenchTask["kind"] | "reactive";
	startedAt: string;
	finishedAt: string;
	mode: WorkbenchMode;
	outputPath?: string;
	error?: string;
};

export type DeferredRunTarget =
	| {
			kind: "turn";
			prompt: string;
			threadId?: string;
			cwd?: string;
			model?: string;
			serviceTier?: string;
			effort?: DeferredReasoningEffort;
			sandbox?: "danger-full-access" | "read-only" | "workspace-write";
			approvalPolicy?: "never" | "on-failure" | "on-request" | "untrusted";
			permissions?: string;
			responsesapiClientMetadata?: Record<string, string>;
			outputSchema?: unknown;
	  }
	| {
			kind: "automation";
			automation: string;
			event?: Record<string, unknown>;
			prompt?: string;
			cwd?: string;
			model?: string;
			sandbox?: "danger-full-access" | "read-only" | "workspace-write";
			approvalPolicy?: "never" | "on-failure" | "on-request" | "untrusted";
			permissions?: string;
	  }
	| {
			kind: "workbench-task";
			taskId: string;
	  };

export type DeferredRunIntentStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "canceled";

export type DeferredRunIntent = {
	id: string;
	status: DeferredRunIntentStatus;
	mode: WorkbenchMode;
	runAt: string;
	target: DeferredRunTarget;
	createdAt: string;
	updatedAt: string;
	createdBy?: string;
	reason?: string;
	source?: Record<string, unknown>;
	dependsOn?: DeferredRunDependency[];
	attemptIds: string[];
	lease?: {
		attemptId: string;
		claimedAt: string;
		expiresAt: string;
		executorId: string;
	};
	completedAt?: string;
	canceledAt?: string;
	error?: string;
};

export type DeferredRunAttempt = {
	id: string;
	intentId: string;
	status: "running" | "completed" | "failed";
	mode: WorkbenchMode;
	startedAt: string;
	finishedAt?: string;
	executorId: string;
	leaseExpiresAt: string;
	outputPath?: string;
	error?: string;
};

export type DeferredRunCreateParams = {
	id?: string;
	runAt?: string;
	target: DeferredRunTarget;
	createdBy?: string;
	reason?: string;
	source?: Record<string, unknown>;
	dependsOn?: DeferredRunDependency[];
};

export type DeferredRunRetryParams = {
	id?: string;
	runAt?: string;
	createdBy?: string;
	reason?: string;
	source?: Record<string, unknown>;
};

export type PromptQueueEnqueueParams = {
	id?: string;
	runAt?: string;
	prompt: string;
	title?: string;
	queue?: string;
	labels?: string[];
	threadId?: string;
	cwd?: string;
	model?: string;
	serviceTier?: string;
	effort?: DeferredReasoningEffort;
	sandbox?: "danger-full-access" | "read-only" | "workspace-write";
	approvalPolicy?: "never" | "on-failure" | "on-request" | "untrusted";
	permissions?: string;
	responsesapiClientMetadata?: Record<string, string>;
	outputSchema?: unknown;
	afterIntentId?: string;
	afterStatus?: "completed" | "failed" | "canceled" | "terminal";
	createdBy?: string;
	reason?: string;
	source?: Record<string, unknown>;
};

export type LocalHandoffEnqueueParams = {
	id?: string;
	runAt?: string;
	prompt: string;
	title?: string;
	queue?: string;
	labels?: string[];
	targetHost?: string;
	requiredCapabilities?: string[];
	requesterHost?: string;
	requesterThreadId?: string;
	threadId?: string;
	cwd?: string;
	model?: string;
	serviceTier?: string;
	effort?: DeferredReasoningEffort;
	sandbox?: "danger-full-access" | "read-only" | "workspace-write";
	approvalPolicy?: "never" | "on-failure" | "on-request" | "untrusted";
	permissions?: string;
	responsesapiClientMetadata?: Record<string, string>;
	outputSchema?: unknown;
	afterIntentId?: string;
	afterStatus?: "completed" | "failed" | "canceled" | "terminal";
	createdBy?: string;
	reason?: string;
	source?: Record<string, unknown>;
};

export type LocalHandoffDrainAction = "run" | "materialize";

export type DeferredRunAttemptOutput = {
	attemptId: string;
	outputPath: string;
	output?: unknown;
	error?: string;
};

export type DeferredRunReadResult = {
	intent: DeferredRunIntent;
	attempts: DeferredRunAttempt[];
	outputs?: DeferredRunAttemptOutput[];
};

export type DeferredRunRetryResult = {
	intent: DeferredRunIntent;
	originalIntent: DeferredRunIntent;
};

export type DeferredRunCollectCursor = {
	cursor: string;
	updatedAt: string;
	lastUpdatedAt?: string;
	lastIntentId?: string;
};

export type DeferredRunCollectResult = {
	mode: WorkbenchMode;
	cursor: string;
	collectedAt: string;
	previousCursor?: DeferredRunCollectCursor;
	cursorState: DeferredRunCollectCursor;
	intents: DeferredRunReadResult[];
};

export type DeferredRunExecution = {
	intent: DeferredRunIntent;
	attempt: DeferredRunAttempt;
	output: unknown;
};

export type LocalHandoffDrainResult = {
	mode: WorkbenchMode;
	action: LocalHandoffDrainAction;
	executions: DeferredRunExecution[];
};

export type DeferredRunPruneResult = {
	mode: WorkbenchMode;
	cutoff: string;
	dryRun: boolean;
	inspected: number;
	pruned: number;
	intents: Array<{
		id: string;
		status: Extract<DeferredRunIntentStatus, "completed" | "failed" | "canceled">;
		updatedAt: string;
		attemptIds: string[];
		outputPaths: string[];
	}>;
};

export type WorkbenchRunnerCandidate = {
	kind: "systemd-user";
	timer: string;
	service: string;
	command?: string;
	activeState?: string;
	unitFileState?: string;
	timerActiveState?: string;
	timerUnitFileState?: string;
	nextTrigger?: string;
	lastTrigger?: string;
	workbenchRoot?: string;
	runsWorkbenchTick: boolean;
	runsDeferredOnly: boolean;
	matchesWorkbench: boolean;
};

export type WorkbenchRunnerInfo = {
	kind: "systemd-user";
	status: "active" | "inactive" | "missing" | "unsupported" | "unknown";
	workbenchRoot: string;
	selected?: WorkbenchRunnerCandidate;
	candidates: WorkbenchRunnerCandidate[];
	warning?: string;
	error?: string;
};

export type WorkbenchDoctorOptions = {
	includeRunner?: boolean;
	runnerProbe?: (args: string[]) => Promise<string>;
};

export type WorkbenchDoctorInfo = {
	mode: WorkbenchMode;
	requestedMode: WorkbenchModeInput;
	repoRoot: string;
	configPath: string;
	configExists: boolean;
	runtimeCodexHome: string;
	workbenchCodexHome: string;
	stateRoot: string;
	localStateRoot: string;
	actionsStateRoot: string;
	globalMemoryRoot: string;
	workbenchMemoryRoot: string;
	globalMemorySummaryExists: boolean;
	workbenchMemorySummaryExists: boolean;
	taskCount: number;
	dueCount: number;
	failingCount: number;
	deferredCount: number;
	deferredDueCount: number;
	deferredRunningCount: number;
	deferredFailedCount: number;
	latestRun?: WorkbenchRunRecord;
	latestDeferredRun?: DeferredRunIntent;
	runner?: WorkbenchRunnerInfo;
	surfaces: WorkbenchSurface[];
	errors: string[];
};

export type ScaffoldActionsWorkbenchOptions = {
	workbenchRoot?: string;
	forgejo?: boolean;
	github?: boolean;
	overwrite?: boolean;
};

export type ScaffoldActionsWorkbenchResult = {
	workbenchRoot: string;
	files: Array<{
		path: string;
		action: "created" | "updated" | "unchanged";
	}>;
};

export async function discoverWorkbenchRoot(start = process.cwd()): Promise<string> {
	let current = path.resolve(start);
	let firstDotCodexRoot: string | undefined;
	while (true) {
		try {
			const workbenchConfig = path.join(current, ".codex", "workbench.toml");
			if ((await stat(workbenchConfig)).isFile()) {
				return current;
			}
		} catch {}
		if (!firstDotCodexRoot) {
			try {
				const dotCodex = path.join(current, ".codex");
				if ((await stat(dotCodex)).isDirectory()) {
					firstDotCodexRoot = current;
				}
			} catch {}
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return firstDotCodexRoot ?? path.resolve(start);
		}
		current = parent;
	}
}

export function resolveWorkbenchMode(
	input: WorkbenchModeInput | undefined,
	env: Record<string, string | undefined> = process.env,
): { requestedMode: WorkbenchModeInput; mode: WorkbenchMode } {
	const requestedMode = input ?? parseMode(env.CODEX_WORKBENCH_MODE) ?? "auto";
	if (requestedMode === "actions") {
		return { requestedMode, mode: "actions" };
	}
	if (requestedMode === "local") {
		return { requestedMode, mode: "local" };
	}
	return { requestedMode, mode: env.GITHUB_ACTIONS === "true" ? "actions" : "local" };
}

export function parseMode(value: string | undefined): WorkbenchModeInput | undefined {
	if (value === undefined || value === "") {
		return undefined;
	}
	if (value === "auto" || value === "local" || value === "actions") {
		return value;
	}
	throw new Error(`Invalid workbench mode: ${value}`);
}

export async function createWorkbenchContext(options: {
	workbenchRoot?: string;
	mode?: WorkbenchModeInput;
	env?: Record<string, string | undefined>;
} = {}): Promise<WorkbenchContext> {
	const env = options.env ?? process.env;
	const repoRoot = path.resolve(options.workbenchRoot ?? await discoverWorkbenchRoot());
	const resolved = resolveWorkbenchMode(options.mode, env);
	const workbenchCodexHome = path.join(repoRoot, ".codex");
	const globalCodexHome = env.CODEX_HOME ?? defaultCodexHome();
	return {
		mode: resolved.mode,
		requestedMode: resolved.requestedMode,
		repoRoot,
		configPath: path.join(workbenchCodexHome, "workbench.toml"),
		workbenchCodexHome,
		runtimeCodexHome: resolved.mode === "actions" ? workbenchCodexHome : globalCodexHome,
		stateRoot: path.join(workbenchCodexHome, "workbench", resolved.mode),
		localStateRoot: path.join(workbenchCodexHome, "workbench", "local"),
		actionsStateRoot: path.join(workbenchCodexHome, "workbench", "actions"),
		globalCodexHome,
		actionsCommitPaths: [
			path.join(workbenchCodexHome, "memories"),
			path.join(workbenchCodexHome, "feed", "actions"),
			path.join(workbenchCodexHome, "workbench", "actions"),
			path.join(workbenchCodexHome, "sessions"),
		],
	};
}

export async function loadWorkbenchConfig(context: WorkbenchContext): Promise<WorkbenchConfig> {
	const text = await readFile(context.configPath, "utf8");
	const parsed = parseToml(text) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`workbench.toml must contain a table: ${context.configPath}`);
	}
	const workbench = isRecord(parsed.workbench) ? parsed.workbench : undefined;
	const surfacesInput = Array.isArray(workbench?.surfaces) ? workbench.surfaces : [];
	const tasksInput = Array.isArray(workbench?.tasks) ? workbench.tasks : [];
	const reactiveInput = Array.isArray(workbench?.reactive) ? workbench.reactive : [];
	const tasks = tasksInput.map(parseTask);
	const ids = new Set<string>();
	for (const task of tasks) {
		if (ids.has(task.id)) {
			throw new Error(`Duplicate workbench task id: ${task.id}`);
		}
		ids.add(task.id);
	}
	return {
		name: stringValue(workbench?.name, path.basename(context.repoRoot)),
		surfaces: surfacesInput.map(parseSurface),
		tasks,
		reactive: reactiveInput.map(parseReactiveRule),
		path: context.configPath,
	};
}

export async function collectWorkbenchDoctorInfo(
	context: WorkbenchContext,
	options: WorkbenchDoctorOptions = {},
): Promise<WorkbenchDoctorInfo> {
	let config: WorkbenchConfig | undefined;
	let configExists = true;
	try {
		config = await loadWorkbenchConfig(context);
	} catch (error) {
		try {
			await stat(context.configPath);
		} catch {
			configExists = false;
		}
		if (configExists) {
			throw error;
		}
	}
	const runs = await readRuns(context);
	const latestRun = runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
	const deferredRuns = await listDeferredRunIntents(context);
	const now = new Date();
	const latestDeferredRun = deferredRuns
		.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
	const deferredDueFlags = await Promise.all(
		deferredRuns.map(async (intent) => await isDeferredIntentDue(context, intent, now)),
	);
	const failingCount = countFailingTasks(config?.tasks ?? [], runs);
	const includeRunner = options.includeRunner === true || options.runnerProbe !== undefined;
	const runner = includeRunner
		? await collectWorkbenchRunnerInfo(
			context,
			config?.tasks ?? [],
			deferredRuns,
			options.runnerProbe ?? runSystemctlUser,
		)
		: undefined;
	return {
		mode: context.mode,
		requestedMode: context.requestedMode,
		repoRoot: context.repoRoot,
		configPath: context.configPath,
		configExists,
		runtimeCodexHome: context.runtimeCodexHome,
		workbenchCodexHome: context.workbenchCodexHome,
		stateRoot: context.stateRoot,
		localStateRoot: context.localStateRoot,
		actionsStateRoot: context.actionsStateRoot,
		globalMemoryRoot: path.join(context.globalCodexHome, "memories"),
		workbenchMemoryRoot: path.join(context.workbenchCodexHome, "memories"),
		globalMemorySummaryExists: await exists(path.join(context.globalCodexHome, "memories", "memory_summary.md")),
		workbenchMemorySummaryExists: await exists(path.join(context.workbenchCodexHome, "memories", "memory_summary.md")),
		taskCount: config?.tasks.length ?? 0,
		dueCount: dueTasks(config?.tasks ?? [], runs, new Date()).length,
		failingCount,
		deferredCount: deferredRuns.length,
		deferredDueCount: deferredDueFlags.filter(Boolean).length,
		deferredRunningCount: deferredRuns.filter((intent) => intent.status === "running").length,
		deferredFailedCount: deferredRuns.filter((intent) => intent.status === "failed").length,
		latestRun,
		latestDeferredRun,
		runner,
		surfaces: config?.surfaces ?? [],
		errors: workbenchDoctorErrors(context),
	};
}

export function formatWorkbenchDoctorInfo(info: WorkbenchDoctorInfo): string {
	const rows: Array<[string, string]> = [
		["mode", info.requestedMode === info.mode ? info.mode : `${info.mode} (${info.requestedMode})`],
		["repo root", info.repoRoot],
		["config", `${info.configPath}${info.configExists ? "" : " (missing)"}`],
		["runtime CODEX_HOME", info.runtimeCodexHome],
		["workbench CODEX_HOME", info.workbenchCodexHome],
		["state root", info.stateRoot],
		["local state", info.localStateRoot],
		["actions state", info.actionsStateRoot],
		["global memories", `${info.globalMemoryRoot}${info.globalMemorySummaryExists ? " (summary)" : ""}`],
		["workbench memories", `${info.workbenchMemoryRoot}${info.workbenchMemorySummaryExists ? " (summary)" : ""}`],
		["tasks", `${info.taskCount} configured, ${info.dueCount} due, ${info.failingCount} failing`],
		["latest run", info.latestRun ? `${info.latestRun.status} ${info.latestRun.taskId} ${info.latestRun.finishedAt}` : "none"],
		[
			"deferred runs",
			`${info.deferredCount} total, ${info.deferredDueCount} due, ${info.deferredRunningCount} running, ${info.deferredFailedCount} failed`,
		],
		[
			"latest deferred",
			info.latestDeferredRun
				? `${info.latestDeferredRun.status} ${info.latestDeferredRun.id} ${info.latestDeferredRun.updatedAt}`
				: "none",
		],
		["runner", formatWorkbenchRunnerInfo(info.runner)],
	];
	if (info.runner?.warning) {
		rows.push(["runner warning", info.runner.warning]);
	}
	for (const error of info.errors) {
		rows.push(["error", error]);
	}
	return `${rows.map(([label, value]) => `${label.padEnd(19)} ${value}`).join("\n")}\n`;
}

export async function scaffoldActionsWorkbench(
	options: ScaffoldActionsWorkbenchOptions = {},
): Promise<ScaffoldActionsWorkbenchResult> {
	const workbenchRoot = path.resolve(options.workbenchRoot ?? await discoverWorkbenchRoot());
	const files: ScaffoldActionsWorkbenchResult["files"] = [];
	const write = async (relativePath: string, content: string): Promise<void> => {
		files.push(await writeScaffoldFile(workbenchRoot, relativePath, content, options.overwrite === true));
	};

	await write(".codex/workbench.toml", workbenchTomlTemplate(workbenchRoot));
	await write(".codex/config.toml", codexConfigTemplate());
	if (options.forgejo) {
		await write(".forgejo/workflows/codex-toys-actions.yml", actionsWorkflowTemplate("forgejo"));
	}
	if (options.github || !options.forgejo) {
		await write(".github/workflows/codex-toys-actions.yml", actionsWorkflowTemplate("github"));
	}
	files.push(await appendGitignoreEntries(
		workbenchRoot,
		actionsGitignoreEntries(),
		retiredActionsGitignoreEntries(),
	));
	return { workbenchRoot, files };
}

export async function tickWorkbench(
	context: WorkbenchContext,
	options: {
		callToybox: (method: string, params: unknown) => Promise<unknown>;
		automationCwd?: string;
	},
): Promise<{ mode: WorkbenchMode; due: string[]; runs: WorkbenchRunRecord[] }> {
	await ensureStateDirs(context);
	const config = await loadWorkbenchConfig(context);
	const previousRuns = await readRuns(context);
	const previousIntents = await listDeferredRunIntents(context);
	const now = new Date();
	const due = dueTasks(config.tasks, previousRuns, now, previousIntents);
	const runs: WorkbenchRunRecord[] = [];
	for (const task of due) {
		await createScheduledWorkbenchTaskIntent(context, task, now);
	}
	const executions = await runDueDeferredRuns(context, options);
	for (const execution of executions.executions) {
		const workbenchRun = record(execution.output).workbenchRun;
		if (isWorkbenchRunRecord(workbenchRun)) {
			runs.push(workbenchRun);
		}
	}
	const allRuns = [...previousRuns, ...runs];
	for (const rule of config.reactive.filter((item) => item.enabled)) {
		const targets = config.tasks.filter((task) =>
			rule.task === "*" ? true : task.id === rule.task
		);
		if (targets.some((task) => consecutiveFailures(task.id, allRuns) >= rule.consecutiveFailuresGte)) {
			runs.push(await runReactiveRule(context, rule));
		}
	}
	return { mode: context.mode, due: due.map((task) => task.id), runs };
}

export async function runWorkbenchTaskById(
	context: WorkbenchContext,
	taskId: string,
	options: {
		callToybox: (method: string, params: unknown) => Promise<unknown>;
		automationCwd?: string;
		event?: Record<string, unknown>;
	},
): Promise<WorkbenchRunRecord> {
	await ensureStateDirs(context);
	const config = await loadWorkbenchConfig(context);
	const task = config.tasks.find((item) => item.id === taskId);
	if (!task) {
		throw new Error(`Unknown workbench task: ${taskId}`);
	}
	return await runWorkbenchTask(context, config, task, options);
}

export async function commitActionsWorkbenchState(
	context: WorkbenchContext,
	options: {
		env?: Record<string, string | undefined>;
		message?: string;
	} = {},
): Promise<{ attempted: boolean; committed: boolean; paths: string[]; output?: string }> {
	const env = options.env ?? process.env;
	if (context.mode !== "actions" || env.GITHUB_ACTIONS !== "true") {
		return { attempted: false, committed: false, paths: context.actionsCommitPaths };
	}
	const relativePaths = context.actionsCommitPaths.map((item) => path.relative(context.repoRoot, item));
	const sessionsPath = path.relative(context.repoRoot, path.join(context.workbenchCodexHome, "sessions"));
	const normalPaths = relativePaths.filter((item) => item !== sessionsPath);
	const existingNormalPaths: string[] = [];
	for (const item of normalPaths) {
		if (await exists(path.join(context.repoRoot, item))) {
			existingNormalPaths.push(item);
		}
	}
	if (existingNormalPaths.length > 0) {
		await runGit(context.repoRoot, ["add", "--", ...existingNormalPaths]);
	}
	if (await exists(path.join(context.repoRoot, sessionsPath))) {
		await runGit(context.repoRoot, ["add", "-A", "-f", "--", sessionsPath]);
	}
	const staged = await runGit(context.repoRoot, ["diff", "--cached", "--name-only", "--", ...relativePaths]);
	if (!staged.stdout.trim()) {
		return { attempted: true, committed: false, paths: context.actionsCommitPaths };
	}
	const commit = await runGit(context.repoRoot, [
		"commit",
		"-m",
		options.message ?? "Update Codex workbench state",
		"--",
		...relativePaths,
	]);
	return {
		attempted: true,
		committed: true,
		paths: context.actionsCommitPaths,
		output: commit.stdout || commit.stderr,
	};
}

export async function createDeferredRunIntent(
	context: WorkbenchContext,
	params: unknown,
): Promise<DeferredRunIntent> {
	await ensureDeferredRunDirs(context);
	const input = parseDeferredRunCreateParams(params);
	const now = new Date().toISOString();
	const runAt = input.runAt ?? now;
	const intent: DeferredRunIntent = compactUndefined({
		id: input.id ?? deferredRunId(now),
		status: "pending",
		mode: context.mode,
		runAt,
		target: input.target,
		createdAt: now,
		updatedAt: now,
		createdBy: input.createdBy,
		reason: input.reason,
		source: input.source,
		dependsOn: input.dependsOn,
		attemptIds: [],
	});
	await writeNewJsonFile(deferredIntentPath(context, intent.id), intent);
	return intent;
}

export async function listDeferredRunIntents(
	context: WorkbenchContext,
	options: {
		status?: DeferredRunIntentStatus;
		limit?: number;
	} = {},
): Promise<DeferredRunIntent[]> {
	const dir = deferredIntentDir(context);
	try {
		const entries = await readdir(dir);
		const intents: DeferredRunIntent[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) {
				continue;
			}
			try {
				const intent = normalizeDeferredRunIntent(
					parseJsonText(
						await readFile(path.join(dir, entry), "utf8"),
						path.join(dir, entry),
					),
				);
				if (!options.status || intent.status === options.status) {
					intents.push(intent);
				}
			} catch {}
		}
		const sorted = intents.sort((left, right) =>
			left.runAt.localeCompare(right.runAt) || left.createdAt.localeCompare(right.createdAt)
		);
		return sorted.slice(0, clampLimit(options.limit, 500));
	} catch {
		return [];
	}
}

export async function readDeferredRun(
	context: WorkbenchContext,
	intentId: string,
	options: { includeOutput?: boolean } = {},
): Promise<DeferredRunReadResult> {
	const intent = await readDeferredRunIntent(context, intentId);
	const attempts = await readDeferredRunAttempts(context, intent.attemptIds);
	const outputs = options.includeOutput
		? await readDeferredRunAttemptOutputs(attempts)
		: undefined;
	return compactUndefined({ intent, attempts, outputs });
}

export async function enqueuePromptQueueIntent(
	context: WorkbenchContext,
	params: unknown,
): Promise<DeferredRunIntent> {
	const input = parsePromptQueueEnqueueParams(params);
	const after = input.afterIntentId
		? {
			kind: "deferred-run" as const,
			intentId: input.afterIntentId,
			status: input.afterStatus,
		}
		: undefined;
	return await createDeferredRunIntent(context, {
		id: input.id,
		runAt: input.runAt,
		target: compactUndefined({
			kind: "turn" as const,
			prompt: input.prompt,
			threadId: input.threadId,
			cwd: input.cwd,
			model: input.model,
			serviceTier: input.serviceTier,
			effort: input.effort,
			sandbox: input.sandbox,
			approvalPolicy: input.approvalPolicy,
			permissions: input.permissions,
			responsesapiClientMetadata: input.responsesapiClientMetadata,
			outputSchema: input.outputSchema,
		}),
		createdBy: input.createdBy ?? "workbench-prompt-queue",
		reason: input.reason ?? input.title,
		source: promptQueueSource(input, after),
		dependsOn: after ? [after] : undefined,
	});
}

export async function listPromptQueueIntents(
	context: WorkbenchContext,
	options: {
		status?: DeferredRunIntentStatus;
		queue?: string;
		limit?: number;
	} = {},
): Promise<DeferredRunIntent[]> {
	const intents = await listDeferredRunIntents(context, {
		status: options.status,
	});
	return intents
		.filter((intent) => isPromptQueueIntent(intent, options.queue))
		.sort(comparePromptQueueIntents)
		.slice(0, clampLimit(options.limit, 500));
}

function comparePromptQueueIntents(left: DeferredRunIntent, right: DeferredRunIntent): number {
	if (dependsOnIntent(left, right.id)) {
		return 1;
	}
	if (dependsOnIntent(right, left.id)) {
		return -1;
	}
	return left.runAt.localeCompare(right.runAt) ||
		left.createdAt.localeCompare(right.createdAt) ||
		left.id.localeCompare(right.id);
}

function dependsOnIntent(intent: DeferredRunIntent, dependencyId: string): boolean {
	return (intent.dependsOn ?? []).some((dependency) =>
		dependency.kind === "deferred-run" && dependency.intentId === dependencyId
	);
}

export async function collectPromptQueueRuns(
	context: WorkbenchContext,
	options: {
		cursor?: string;
		queue?: string;
		now?: Date;
	} = {},
): Promise<DeferredRunCollectResult> {
	return await collectDeferredRuns(context, {
		cursor: options.cursor,
		defaultCursor: "prompt-queue",
		now: options.now,
		filter: (intent) => isPromptQueueIntent(intent, options.queue),
	});
}

export async function runDuePromptQueueIntents(
	context: WorkbenchContext,
	options: {
		callToybox: (method: string, params: unknown) => Promise<unknown>;
		automationCwd?: string;
		now?: Date;
		limit?: number;
		leaseMs?: number;
		queue?: string;
	},
): Promise<{ mode: WorkbenchMode; executions: DeferredRunExecution[] }> {
	return await runDueDeferredRuns(context, {
		...options,
		filter: (intent) => isPromptQueueIntent(intent, options.queue),
	});
}

export async function enqueueLocalHandoffIntent(
	context: WorkbenchContext,
	params: unknown,
): Promise<DeferredRunIntent> {
	const input = parseLocalHandoffEnqueueParams(params);
	const after = input.afterIntentId
		? {
			kind: "deferred-run" as const,
			intentId: input.afterIntentId,
			status: input.afterStatus,
		}
		: undefined;
	return await createDeferredRunIntent(context, {
		id: input.id,
		runAt: input.runAt,
		target: compactUndefined({
			kind: "turn" as const,
			prompt: input.prompt,
			threadId: input.threadId,
			cwd: input.cwd,
			model: input.model,
			serviceTier: input.serviceTier,
			effort: input.effort,
			sandbox: input.sandbox,
			approvalPolicy: input.approvalPolicy,
			permissions: input.permissions,
			responsesapiClientMetadata: input.responsesapiClientMetadata,
			outputSchema: input.outputSchema,
		}),
		createdBy: input.createdBy ?? "workbench-local-handoff",
		reason: input.reason ?? input.title,
		source: localHandoffSource(input, after),
		dependsOn: after ? [after] : undefined,
	});
}

export async function listLocalHandoffIntents(
	context: WorkbenchContext,
	options: {
		status?: DeferredRunIntentStatus;
		queue?: string;
		targetHost?: string;
		capabilities?: string[];
		limit?: number;
	} = {},
): Promise<DeferredRunIntent[]> {
	const intents = await listDeferredRunIntents(context, {
		status: options.status,
	});
	return intents
		.filter((intent) => isLocalHandoffIntent(intent, options))
		.slice(0, clampLimit(options.limit, 500));
}

export async function collectLocalHandoffRuns(
	context: WorkbenchContext,
	options: {
		cursor?: string;
		queue?: string;
		targetHost?: string;
		capabilities?: string[];
		now?: Date;
	} = {},
): Promise<DeferredRunCollectResult> {
	return await collectDeferredRuns(context, {
		cursor: options.cursor,
		defaultCursor: "local-handoff",
		now: options.now,
		filter: (intent) => isLocalHandoffIntent(intent, options),
	});
}

export async function drainLocalHandoffQueue(
	context: WorkbenchContext,
	options: {
		callToybox: (method: string, params: unknown) => Promise<unknown>;
		automationCwd?: string;
		now?: Date;
		limit?: number;
		leaseMs?: number;
		queue?: string;
		hostId?: string;
		capabilities?: string[];
		action?: LocalHandoffDrainAction;
		promptQueue?: string;
	},
): Promise<LocalHandoffDrainResult> {
	const action = options.action ?? "run";
	const result = await runDueDeferredRuns(context, {
		...options,
		includeLocalHandoffs: true,
		localHandoffMaterialize: action === "materialize"
			? { queue: options.promptQueue }
			: undefined,
		filter: (intent) => isLocalHandoffIntent(intent, {
			queue: options.queue,
			targetHost: options.hostId ? undefined : "local-controller",
			hostId: options.hostId,
			capabilities: options.capabilities ?? [],
		}),
	});
	return {
		mode: result.mode,
		action,
		executions: result.executions,
	};
}

export async function collectDeferredRuns(
	context: WorkbenchContext,
	options: {
		cursor?: string;
		now?: Date;
		defaultCursor?: string;
		filter?: (intent: DeferredRunIntent) => boolean | Promise<boolean>;
	} = {},
): Promise<DeferredRunCollectResult> {
	await ensureDeferredRunDirs(context);
	const cursor = deferredCollectCursorName(options.cursor, options.defaultCursor);
	const previousCursor = await readDeferredRunCollectCursor(context, cursor);
	const collectedAt = (options.now ?? new Date()).toISOString();
	const filteredIntents: DeferredRunIntent[] = [];
	for (const intent of await listDeferredRunIntents(context)) {
		if (!options.filter || await options.filter(intent)) {
			filteredIntents.push(intent);
		}
	}
	const terminalIntents = filteredIntents
		.filter((intent) => isTerminalDeferredRunStatus(intent.status))
		.toSorted((left, right) =>
			left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
		)
		.filter((intent) => isAfterDeferredRunCollectCursor(intent, previousCursor));
	const intents = await Promise.all(
		terminalIntents.map(async (intent) =>
			await readDeferredRun(context, intent.id, { includeOutput: true })
		),
	);
	const last = terminalIntents.at(-1);
	const cursorState: DeferredRunCollectCursor = compactUndefined({
		cursor,
		updatedAt: collectedAt,
		lastUpdatedAt: last?.updatedAt ?? previousCursor?.lastUpdatedAt,
		lastIntentId: last?.id ?? previousCursor?.lastIntentId,
	});
	await writeJsonFileAtomic(deferredCollectCursorPath(context, cursor), cursorState);
	return compactUndefined({
		mode: context.mode,
		cursor,
		collectedAt,
		previousCursor,
		cursorState,
		intents,
	});
}

export async function cancelDeferredRunIntent(
	context: WorkbenchContext,
	intentId: string,
): Promise<DeferredRunIntent> {
	const intent = await readDeferredRunIntent(context, intentId);
	if (intent.status !== "pending") {
		throw new Error(`Only pending deferred runs can be canceled: ${intentId}`);
	}
	const now = new Date().toISOString();
	const canceled: DeferredRunIntent = {
		...intent,
		status: "canceled",
		updatedAt: now,
		canceledAt: now,
	};
	await writeJsonFileAtomic(deferredIntentPath(context, intentId), canceled);
	return canceled;
}

export async function retryDeferredRunIntent(
	context: WorkbenchContext,
	intentId: string,
	params: unknown = {},
	options: { now?: Date } = {},
): Promise<DeferredRunRetryResult> {
	await ensureDeferredRunDirs(context);
	const originalIntent = await readDeferredRunIntent(context, intentId);
	if (!isTerminalDeferredRunStatus(originalIntent.status)) {
		throw new Error(`Only terminal deferred runs can be retried: ${intentId} is ${originalIntent.status}`);
	}
	const input = parseDeferredRunRetryParams(params);
	const now = (options.now ?? new Date()).toISOString();
	const retrySource = retryDeferredRunSource(originalIntent, input.source);
	let id = input.id ?? deferredRetryRunId(originalIntent.id, now);
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const intent: DeferredRunIntent = compactUndefined({
			id,
			status: "pending",
			mode: context.mode,
			runAt: input.runAt ?? now,
			target: originalIntent.target,
			createdAt: now,
			updatedAt: now,
			createdBy: input.createdBy ?? "workbench-deferred-retry",
			reason: input.reason ?? `Retry deferred run ${originalIntent.id}`,
			source: retrySource,
			dependsOn: originalIntent.dependsOn,
			attemptIds: [],
		});
		try {
			await writeNewJsonFile(deferredIntentPath(context, intent.id), intent);
			return { intent, originalIntent };
		} catch (error) {
			if (!isAlreadyExistsError(error)) {
				throw error;
			}
			id = deferredRetryRunId(originalIntent.id, now);
		}
	}
	throw new Error(`Could not allocate retry deferred run id for ${intentId}`);
}

export async function runDueDeferredRuns(
	context: WorkbenchContext,
	options: {
		callToybox: (method: string, params: unknown) => Promise<unknown>;
		automationCwd?: string;
		now?: Date;
		limit?: number;
		leaseMs?: number;
		filter?: (intent: DeferredRunIntent) => boolean | Promise<boolean>;
		includeLocalHandoffs?: boolean;
		localHandoffMaterialize?: {
			queue?: string;
		};
	}): Promise<{ mode: WorkbenchMode; executions: DeferredRunExecution[] }> {
	await ensureStateDirs(context);
	await ensureDeferredRunDirs(context);
	const now = options.now ?? new Date();
	const due: DeferredRunIntent[] = [];
	for (const intent of await listDeferredRunIntents(context)) {
		if (
			await isDeferredIntentDue(context, intent, now) &&
			(options.includeLocalHandoffs === true || !isLocalHandoffIntent(intent)) &&
			(!options.filter || await options.filter(intent))
		) {
			due.push(intent);
		}
		if (due.length >= clampLimit(options.limit, 100)) {
			break;
		}
	}
	const executions: DeferredRunExecution[] = [];
	for (const intent of due) {
		const claim = await claimDeferredRunIntent(context, intent, {
			now,
			leaseMs: options.leaseMs ?? 30 * 60 * 1000,
		});
		if (!claim) {
			continue;
		}
		try {
			const outputPath = path.join(deferredOutputDir(context), `${claim.attempt.id}.json`);
			await writeJsonFileAtomic(deferredAttemptPath(context, claim.attempt.id), claim.attempt);
			const result = await executeDeferredRunTarget(context, claim.intent, {
				callToybox: options.callToybox,
				automationCwd: options.automationCwd,
				localHandoffMaterialize: options.localHandoffMaterialize,
			});
			await writeJsonFileAtomic(outputPath, result.output);
			const finishedAt = new Date().toISOString();
			const attempt: DeferredRunAttempt = compactUndefined({
				...claim.attempt,
				status: result.status,
				finishedAt,
				outputPath,
				error: result.error,
			});
			const completedIntent: DeferredRunIntent = compactUndefined({
				...claim.intent,
				status: result.status,
				updatedAt: finishedAt,
				attemptIds: [...new Set([...claim.intent.attemptIds, attempt.id])],
				lease: undefined,
				completedAt: result.status === "completed" ? finishedAt : undefined,
				error: result.error,
			});
			await writeJsonFileAtomic(deferredAttemptPath(context, attempt.id), attempt);
			await writeJsonFileAtomic(deferredIntentPath(context, completedIntent.id), completedIntent);
			executions.push({
				intent: completedIntent,
				attempt,
				output: result.output,
			});
		} finally {
			await releaseDeferredRunClaim(context, claim.intent.id);
		}
	}
	return { mode: context.mode, executions };
}

export async function pruneDeferredRunHistory(
	context: WorkbenchContext,
	options: {
		olderThanDays: number;
		dryRun?: boolean;
		now?: Date;
	},
): Promise<DeferredRunPruneResult> {
	if (!Number.isInteger(options.olderThanDays) || options.olderThanDays <= 0) {
		throw new Error("olderThanDays must be a positive integer");
	}
	const now = options.now ?? new Date();
	const cutoff = new Date(now.getTime() - options.olderThanDays * 24 * 60 * 60 * 1000).toISOString();
	const intents = await listDeferredRunIntents(context);
	const pruned: DeferredRunPruneResult["intents"] = [];
	for (const intent of intents) {
		if (!isTerminalDeferredRunStatus(intent.status) || intent.updatedAt >= cutoff) {
			continue;
		}
		const attempts = await readDeferredRunAttempts(context, intent.attemptIds);
		const outputPaths = attempts.flatMap((attempt) => attempt.outputPath ? [attempt.outputPath] : []);
		pruned.push({
			id: intent.id,
			status: intent.status,
			updatedAt: intent.updatedAt,
			attemptIds: attempts.map((attempt) => attempt.id),
			outputPaths,
		});
		if (options.dryRun === true) {
			continue;
		}
		await releaseDeferredRunClaim(context, intent.id);
		for (const outputPath of outputPaths) {
			await rm(outputPath, { force: true });
		}
		for (const attempt of attempts) {
			await rm(deferredAttemptPath(context, attempt.id), { force: true });
		}
		await rm(deferredIntentPath(context, intent.id), { force: true });
	}
	return {
		mode: context.mode,
		cutoff,
		dryRun: options.dryRun === true,
		inspected: intents.length,
		pruned: pruned.length,
		intents: pruned,
	};
}

async function runWorkbenchTask(
	context: WorkbenchContext,
	config: WorkbenchConfig,
	task: WorkbenchTask,
	options: {
		callToybox: (method: string, params: unknown) => Promise<unknown>;
		automationCwd?: string;
		event?: Record<string, unknown>;
	},
): Promise<WorkbenchRunRecord> {
	const startedAt = new Date().toISOString();
	const runId = workbenchRunId(task.id, startedAt);
	const outputPath = path.join(context.stateRoot, "outputs", `${runId}.json`);
	try {
		let result: unknown;
		if (!task.enabled) {
			result = { skipped: "disabled" };
			const run = runRecord(context, runId, task.id, task.kind, startedAt, "skipped", outputPath);
			await persistRun(context, run, result);
			return run;
		}
		if (task.kind === "automation") {
			result = await runAutomationTask(
				context,
				config,
				task,
				runId,
				startedAt,
				options,
			);
		} else if (task.kind === "command") {
			result = await runCommand(task.command, context);
		} else {
			result = await runSkill(task, context);
		}
		const run = runRecord(context, runId, task.id, task.kind, startedAt, "completed", outputPath);
		await persistRun(context, run, result);
		return run;
	} catch (error) {
		const run = runRecord(context, runId, task.id, task.kind, startedAt, "failed", outputPath, errorMessage(error));
		await persistRun(context, run, { error: errorMessage(error) });
		return run;
	}
}

function workbenchRunId(taskId: string, startedAt: string): string {
	return `${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}-${taskId}`;
}

async function runAutomationTask(
	context: WorkbenchContext,
	config: WorkbenchConfig,
	task: Extract<WorkbenchTask, { kind: "automation" }>,
	runId: string,
	startedAt: string,
	options: {
		callToybox: (method: string, params: unknown) => Promise<unknown>;
		automationCwd?: string;
		event?: Record<string, unknown>;
	},
): Promise<unknown> {
	const target = await resolveTurnAutomationTarget(task.automation, {
		cwd: context.repoRoot,
	});
	const event = options.event ?? workbenchAutomationEvent(config, task, runId, startedAt);
	const prompt = task.prompt ?? target.prompt;
	const cwd = task.cwd ?? options.automationCwd ?? target.cwd ?? context.repoRoot;
	const scriptRun = await runTurnAutomationScript({
		scriptPath: target.scriptPath,
		automation: target.automation,
		event,
		prompt,
		cwd,
		timeoutMs: target.timeoutMs ?? 90_000,
		host: createTurnAutomationHost({
			via: "workbench",
			appRequest: async (method, params) =>
				await options.callToybox("app.call", {
					method,
					params,
				}),
			workbenchRequest: options.callToybox,
			defaults: {
				prompt,
				cwd,
				skills: target.skills,
			},
		}),
	});
	return scriptRun.result;
}

async function executeDeferredRunTarget(
	context: WorkbenchContext,
	intent: DeferredRunIntent,
	options: {
		callToybox: (method: string, params: unknown) => Promise<unknown>;
		automationCwd?: string;
		localHandoffMaterialize?: {
			queue?: string;
		};
	},
): Promise<{ status: "completed" | "failed"; output: unknown; error?: string }> {
	try {
		const target = intent.target;
		if (options.localHandoffMaterialize && isLocalHandoffIntent(intent)) {
			const materialized = await materializeLocalHandoffIntent(
				context,
				intent,
				options.localHandoffMaterialize,
			);
			return {
				status: "completed",
				output: { localHandoff: materialized },
			};
		}
		if (target.kind === "workbench-task") {
			const config = await loadWorkbenchConfig(context);
			const task = config.tasks.find((item) => item.id === target.taskId);
			if (!task) {
				throw new Error(`Unknown workbench task: ${target.taskId}`);
			}
			const workbenchRun = await runWorkbenchTask(context, config, task, options);
			return {
				status: workbenchRun.status === "failed" ? "failed" : "completed",
				output: { workbenchRun },
				error: workbenchRun.error,
			};
		}
		if (target.kind === "automation") {
			const config = await loadWorkbenchConfig(context).catch(() => ({
				name: path.basename(context.repoRoot),
				surfaces: [],
				tasks: [],
				reactive: [],
				path: context.configPath,
			} satisfies WorkbenchConfig));
			const result = await runAutomationDeferredTarget(
				context,
				config,
				{ ...intent, target },
				options,
			);
			return { status: "completed", output: result };
		}
		if (target.kind === "turn") {
			const started = await startAutomationTurnWithRequest(
				"workbench",
				target,
				async (method, params) =>
					await options.callToybox("app.call", {
						method,
						params,
					}),
			);
			const snapshot = await waitAutomationTurnWithRequest(
				"workbench",
				async (method, params) =>
					await options.callToybox("app.call", {
						method,
						params,
					}),
				started,
			);
			return { status: "completed", output: { turn: snapshot } };
		}
		return exhaustiveTarget(target);
	} catch (error) {
		return {
			status: "failed",
			output: { error: errorMessage(error) },
			error: errorMessage(error),
		};
	}
}

async function materializeLocalHandoffIntent(
	context: WorkbenchContext,
	intent: DeferredRunIntent,
	options: {
		queue?: string;
	},
): Promise<{
	action: "materialized";
	handoffIntentId: string;
	promptIntentId: string;
	queue: string;
}> {
	if (intent.target.kind !== "turn") {
		throw new Error(`Local handoff can only materialize turn targets: ${intent.id}`);
	}
	const source = recordOrUndefined(intent.source) ?? {};
	const queue = options.queue ?? optionalString(source.queue) ?? "local";
	const promptIntent = await enqueuePromptQueueIntent(context, {
		prompt: intent.target.prompt,
		title: optionalString(source.title) ?? intent.reason,
		queue,
		labels: stringArray(source.labels),
		threadId: intent.target.threadId,
		cwd: intent.target.cwd,
		model: intent.target.model,
		serviceTier: intent.target.serviceTier,
		effort: intent.target.effort,
		sandbox: intent.target.sandbox,
		approvalPolicy: intent.target.approvalPolicy,
		permissions: intent.target.permissions,
		responsesapiClientMetadata: intent.target.responsesapiClientMetadata,
		outputSchema: intent.target.outputSchema,
		createdBy: "workbench-local-handoff-drain",
		reason: intent.reason,
		source: compactUndefined({
			kind: "local-handoff-materialized",
			handoffIntentId: intent.id,
			handoffSource: source,
		}),
	});
	return {
		action: "materialized",
		handoffIntentId: intent.id,
		promptIntentId: promptIntent.id,
		queue,
	};
}

async function runAutomationDeferredTarget(
	context: WorkbenchContext,
	config: WorkbenchConfig,
	intent: DeferredRunIntent & {
		target: Extract<DeferredRunTarget, { kind: "automation" }>;
	},
	options: {
		callToybox: (method: string, params: unknown) => Promise<unknown>;
		automationCwd?: string;
	},
): Promise<unknown> {
	const target = await resolveTurnAutomationTarget(intent.target.automation, {
		cwd: context.repoRoot,
	});
	const startedAt = new Date().toISOString();
	const event = deferredAutomationEvent(config, intent, startedAt);
	const prompt = intent.target.prompt ?? target.prompt;
	const cwd = intent.target.cwd ?? options.automationCwd ?? target.cwd ?? context.repoRoot;
	const scriptRun = await runTurnAutomationScript({
		scriptPath: target.scriptPath,
		automation: target.automation,
		event,
		prompt,
		cwd,
		timeoutMs: target.timeoutMs ?? 90_000,
		host: createTurnAutomationHost({
			via: "workbench",
			appRequest: async (method, params) =>
				await options.callToybox("app.call", {
					method,
					params,
				}),
			workbenchRequest: options.callToybox,
			defaults: {
				prompt,
				cwd,
				skills: target.skills,
				model: intent.target.model,
				sandbox: intent.target.sandbox,
				approvalPolicy: intent.target.approvalPolicy,
				permissions: intent.target.permissions,
			},
		}),
	});
	return scriptRun.result;
}

function workbenchAutomationEvent(
	config: WorkbenchConfig,
	task: Extract<WorkbenchTask, { kind: "automation" }>,
	runId: string,
	startedAt: string,
): Record<string, unknown> {
	const event = task.event ?? {};
	const payload = isRecord(event.payload) ? event.payload : {};
	return {
		...event,
		id: `workbench:${config.name}:${task.id}:${runId}`,
		type: stringValue(event.type, task.automation),
		source: stringValue(event.source, config.name),
		occurredAt: startedAt,
		receivedAt: startedAt,
		payload: {
			taskId: task.id,
			...payload,
		},
	};
}

function deferredAutomationEvent(
	config: WorkbenchConfig,
	intent: DeferredRunIntent & {
		target: Extract<DeferredRunTarget, { kind: "automation" }>;
	},
	startedAt: string,
): Record<string, unknown> {
	const event = intent.target.event ?? {};
	const payload = isRecord(event.payload) ? event.payload : {};
	return {
		...event,
		id: stringValue(event.id, `deferred:${config.name}:${intent.id}`),
		type: stringValue(event.type, intent.target.automation),
		source: stringValue(event.source, config.name),
		occurredAt: stringValue(event.occurredAt, intent.runAt),
		receivedAt: stringValue(event.receivedAt, startedAt),
		payload: {
			deferredRunId: intent.id,
			...payload,
		},
	};
}

function exhaustiveTarget(value: never): never {
	throw new Error(`Unsupported deferred run target: ${JSON.stringify(value)}`);
}

async function runReactiveRule(
	context: WorkbenchContext,
	rule: WorkbenchReactiveRule,
): Promise<WorkbenchRunRecord> {
	const startedAt = new Date().toISOString();
	const runId = `${startedAt.replace(/[:.]/g, "-")}-${rule.id}`;
	const outputPath = path.join(context.stateRoot, "outputs", `${runId}.json`);
	try {
		const result = await runSkill({
			id: rule.id,
			enabled: rule.enabled,
			kind: "skill",
			skill: rule.skill,
			var: `repair failures for ${rule.task}`,
		}, context);
		const run = runRecord(context, runId, rule.id, "reactive", startedAt, "completed", outputPath);
		await persistRun(context, run, result);
		return run;
	} catch (error) {
		const run = runRecord(context, runId, rule.id, "reactive", startedAt, "failed", outputPath, errorMessage(error));
		await persistRun(context, run, { error: errorMessage(error) });
		return run;
	}
}

async function runSkill(task: Extract<WorkbenchTask, { kind: "skill" }>, context: WorkbenchContext) {
	const skillPath = path.join(context.runtimeCodexHome, "skills", task.skill, "SKILL.md");
	if (!await exists(skillPath)) {
		throw new Error(`Skill not found: ${skillPath}`);
	}
	return await runCommand([
		process.env.CODEX_APP_SERVER_CODEX_COMMAND ?? "codex",
		"exec",
		"--cwd",
		context.repoRoot,
		`Use the ${task.skill} skill for this workbench task.${task.var ? `\n\nInput: ${task.var}` : ""}`,
	], context);
}

async function runCommand(command: string[], context: WorkbenchContext) {
	if (command.length === 0) {
		throw new Error("command task requires at least one command element");
	}
	const [cmd, ...args] = command;
	if (!cmd) {
		throw new Error("command task requires command executable");
	}
	const env = {
		...process.env,
		CODEX_WORKBENCH_MODE: context.mode,
		CODEX_HOME: context.runtimeCodexHome,
	};
	const proc = spawn(cmd, args, {
		cwd: context.repoRoot,
		env,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(proc.stdout),
		collectText(proc.stderr),
		exitCodeFor(proc),
	]);
	if (exitCode !== 0) {
		throw new Error(`Command failed (${exitCode}): ${stderr || stdout}`);
	}
	return { exitCode, stdout, stderr };
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	const proc = spawn("git", args, {
		cwd,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(proc.stdout),
		collectText(proc.stderr),
		exitCodeFor(proc),
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
	}
	return { stdout, stderr };
}

async function runSystemctlUser(args: string[]): Promise<string> {
	const proc = spawn("systemctl", ["--user", ...args]);
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(proc.stdout),
		collectText(proc.stderr),
		exitCodeFor(proc),
	]);
	if (exitCode !== 0) {
		throw new Error(`systemctl --user ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
	}
	return stdout;
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

async function persistRun(context: WorkbenchContext, run: WorkbenchRunRecord, output: unknown): Promise<void> {
	await ensureStateDirs(context);
	if (run.outputPath) {
		await writeFile(run.outputPath, `${JSON.stringify(output, null, 2)}\n`);
	}
	await writeFile(path.join(context.stateRoot, "runs", `${run.id}.json`), `${JSON.stringify(run, null, 2)}\n`);
	await writeHealth(context, run);
}

async function writeHealth(context: WorkbenchContext, run: WorkbenchRunRecord): Promise<void> {
	const runs = [...await readRuns(context), run].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	const health = {
		updatedAt: new Date().toISOString(),
		latestRun: run,
		failingTasks: Object.fromEntries(
			Array.from(new Set(runs.map((item) => item.taskId))).flatMap((taskId) => {
				const count = consecutiveFailures(taskId, runs);
				return count > 0 ? [[taskId, count]] : [];
			}),
		),
	};
	await writeFile(path.join(context.stateRoot, "health", "summary.json"), `${JSON.stringify(health, null, 2)}\n`);
}

async function readRuns(context: WorkbenchContext): Promise<WorkbenchRunRecord[]> {
	const dir = path.join(context.stateRoot, "runs");
	try {
		const entries = await readdir(dir);
		const runs: WorkbenchRunRecord[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) {
				continue;
			}
			try {
				const runPath = path.join(dir, entry);
				const parsed = parseJsonText(
					await readFile(runPath, "utf8"),
					runPath,
				) as WorkbenchRunRecord;
				if (parsed && typeof parsed.taskId === "string") {
					runs.push(parsed);
				}
			} catch {}
		}
		return runs;
	} catch {
		return [];
	}
}

async function createScheduledWorkbenchTaskIntent(
	context: WorkbenchContext,
	task: WorkbenchTask,
	now: Date,
): Promise<DeferredRunIntent | undefined> {
	try {
		return await createDeferredRunIntent(context, {
			id: scheduledDeferredRunId(task.id, now),
			runAt: now.toISOString(),
			target: {
				kind: "workbench-task",
				taskId: task.id,
			},
			createdBy: "workbench-schedule",
			reason: `Scheduled workbench task ${task.id}`,
			source: {
				kind: "workbench-task-schedule",
				taskId: task.id,
				schedule: task.schedule,
				date: now.toISOString().slice(0, 10),
			},
		});
	} catch (error) {
		if (isAlreadyExistsError(error)) {
			return undefined;
		}
		throw error;
	}
}

async function readDeferredRunIntent(
	context: WorkbenchContext,
	intentId: string,
): Promise<DeferredRunIntent> {
	const intentPath = deferredIntentPath(context, intentId);
	try {
		return normalizeDeferredRunIntent(parseJsonText(await readFile(intentPath, "utf8"), intentPath));
	} catch (error) {
		if (isNotFoundError(error)) {
			throw new Error(`Unknown deferred run: ${intentId}`);
		}
		throw error;
	}
}

async function readDeferredRunAttempts(
	context: WorkbenchContext,
	attemptIds: string[],
): Promise<DeferredRunAttempt[]> {
	const attempts: DeferredRunAttempt[] = [];
	for (const attemptId of attemptIds) {
		const attemptPath = deferredAttemptPath(context, attemptId);
		try {
			attempts.push(normalizeDeferredRunAttempt(
				parseJsonText(await readFile(attemptPath, "utf8"), attemptPath),
			));
		} catch {}
	}
	return attempts.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

async function readDeferredRunAttemptOutputs(
	attempts: DeferredRunAttempt[],
): Promise<DeferredRunAttemptOutput[]> {
	const outputs: DeferredRunAttemptOutput[] = [];
	for (const attempt of attempts) {
		if (!attempt.outputPath) {
			continue;
		}
		try {
			outputs.push({
				attemptId: attempt.id,
				outputPath: attempt.outputPath,
				output: parseJsonText(await readFile(attempt.outputPath, "utf8"), attempt.outputPath),
			});
		} catch (error) {
			outputs.push({
				attemptId: attempt.id,
				outputPath: attempt.outputPath,
				error: errorMessage(error),
			});
		}
	}
	return outputs;
}

async function readDeferredRunCollectCursor(
	context: WorkbenchContext,
	cursor: string,
): Promise<DeferredRunCollectCursor | undefined> {
	const file = deferredCollectCursorPath(context, cursor);
	try {
		return normalizeDeferredRunCollectCursor(parseJsonText(await readFile(file, "utf8"), file), cursor);
	} catch (error) {
		if (isNotFoundError(error)) {
			return undefined;
		}
		throw error;
	}
}

async function claimDeferredRunIntent(
	context: WorkbenchContext,
	intent: DeferredRunIntent,
	options: {
		now: Date;
		leaseMs: number;
	},
): Promise<{ intent: DeferredRunIntent; attempt: DeferredRunAttempt } | undefined> {
	const current = await readDeferredRunIntent(context, intent.id);
	if (!await isDeferredIntentDue(context, current, options.now)) {
		return undefined;
	}
	const claimPath = deferredClaimPath(context, current.id);
	const claimedAt = options.now.toISOString();
	const attemptId = deferredAttemptId(current.id, claimedAt);
	const leaseExpiresAt = new Date(options.now.getTime() + options.leaseMs).toISOString();
	const executorId = `${process.pid}:${randomUUID()}`;
	const claim = { intentId: current.id, attemptId, claimedAt, leaseExpiresAt, executorId };
	try {
		await writeNewJsonFile(claimPath, claim);
	} catch (error) {
		if (!isAlreadyExistsError(error)) {
			throw error;
		}
		const existing = await readClaimFile(claimPath);
		if (!existing || existing.leaseExpiresAt > options.now.toISOString()) {
			return undefined;
		}
		await rm(claimPath, { force: true });
		try {
			await writeNewJsonFile(claimPath, claim);
		} catch (retryError) {
			if (isAlreadyExistsError(retryError)) {
				return undefined;
			}
			throw retryError;
		}
	}
	const attempt: DeferredRunAttempt = {
		id: attemptId,
		intentId: current.id,
		status: "running",
		mode: context.mode,
		startedAt: claimedAt,
		executorId,
		leaseExpiresAt,
	};
	const running: DeferredRunIntent = {
		...current,
		status: "running",
		updatedAt: claimedAt,
		lease: {
			attemptId,
			claimedAt,
			expiresAt: leaseExpiresAt,
			executorId,
		},
	};
	await writeJsonFileAtomic(deferredIntentPath(context, current.id), running);
	return { intent: running, attempt };
}

async function releaseDeferredRunClaim(
	context: WorkbenchContext,
	intentId: string,
): Promise<void> {
	await rm(deferredClaimPath(context, intentId), { force: true });
}

async function readClaimFile(file: string): Promise<{ leaseExpiresAt: string } | undefined> {
	try {
		const parsed = parseJsonText(await readFile(file, "utf8"), file);
		return isRecord(parsed) && typeof parsed.leaseExpiresAt === "string"
			? { leaseExpiresAt: parsed.leaseExpiresAt }
			: undefined;
	} catch {
		return undefined;
	}
}

function parseDeferredRunCreateParams(value: unknown): DeferredRunCreateParams {
	const input = record(value);
	const runAt = optionalString(input.runAt);
	if (runAt && Number.isNaN(Date.parse(runAt))) {
		throw new Error(`Deferred run runAt must be an ISO-compatible date: ${runAt}`);
	}
	const target = parseDeferredRunTarget(input.target);
	const source = recordOrUndefined(input.source);
	return compactUndefined({
		id: optionalString(input.id),
		runAt,
		target,
		createdBy: optionalString(input.createdBy),
		reason: optionalString(input.reason),
		source,
		dependsOn: parseDeferredRunDependencies(input.dependsOn),
	});
}

function parsePromptQueueEnqueueParams(value: unknown): PromptQueueEnqueueParams {
	const input = record(value);
	const runAt = optionalString(input.runAt);
	if (runAt && Number.isNaN(Date.parse(runAt))) {
		throw new Error(`Prompt queue runAt must be an ISO-compatible date: ${runAt}`);
	}
	const afterStatus = deferredDependencyStatusValue(input.afterStatus, "prompt queue afterStatus");
	return compactUndefined({
		id: optionalString(input.id),
		runAt,
		prompt: requiredString(input.prompt, "prompt queue prompt"),
		title: optionalString(input.title),
		queue: optionalString(input.queue),
		labels: stringArray(input.labels),
		threadId: optionalString(input.threadId),
		cwd: optionalString(input.cwd),
		model: optionalString(input.model),
		serviceTier: optionalString(input.serviceTier),
		effort: reasoningEffortValue(input.effort, "prompt queue effort"),
		sandbox: sandboxValue(input.sandbox, "prompt queue sandbox"),
		approvalPolicy: approvalPolicyValue(input.approvalPolicy, "prompt queue approvalPolicy"),
		permissions: optionalString(input.permissions),
		responsesapiClientMetadata: stringRecord(input.responsesapiClientMetadata),
		outputSchema: input.outputSchema,
		afterIntentId: optionalString(input.afterIntentId),
		afterStatus,
		createdBy: optionalString(input.createdBy),
		reason: optionalString(input.reason),
		source: recordOrUndefined(input.source),
	});
}

function parseLocalHandoffEnqueueParams(value: unknown): LocalHandoffEnqueueParams {
	const input = record(value);
	const runAt = optionalString(input.runAt);
	if (runAt && Number.isNaN(Date.parse(runAt))) {
		throw new Error(`Local handoff runAt must be an ISO-compatible date: ${runAt}`);
	}
	const afterStatus = deferredDependencyStatusValue(input.afterStatus, "local handoff afterStatus");
	return compactUndefined({
		id: optionalString(input.id),
		runAt,
		prompt: requiredString(input.prompt, "local handoff prompt"),
		title: optionalString(input.title),
		queue: optionalString(input.queue),
		labels: stringArray(input.labels),
		targetHost: optionalString(input.targetHost),
		requiredCapabilities: stringArray(input.requiredCapabilities),
		requesterHost: optionalString(input.requesterHost),
		requesterThreadId: optionalString(input.requesterThreadId),
		threadId: optionalString(input.threadId),
		cwd: optionalString(input.cwd),
		model: optionalString(input.model),
		serviceTier: optionalString(input.serviceTier),
		effort: reasoningEffortValue(input.effort, "local handoff effort"),
		sandbox: sandboxValue(input.sandbox, "local handoff sandbox"),
		approvalPolicy: approvalPolicyValue(input.approvalPolicy, "local handoff approvalPolicy"),
		permissions: optionalString(input.permissions),
		responsesapiClientMetadata: stringRecord(input.responsesapiClientMetadata),
		outputSchema: input.outputSchema,
		afterIntentId: optionalString(input.afterIntentId),
		afterStatus,
		createdBy: optionalString(input.createdBy),
		reason: optionalString(input.reason),
		source: recordOrUndefined(input.source),
	});
}

function parseDeferredRunDependencies(value: unknown): DeferredRunDependency[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const dependencies = value.map(parseDeferredRunDependency);
	return dependencies.length > 0 ? dependencies : undefined;
}

function parseDeferredRunDependency(value: unknown): DeferredRunDependency {
	const input = record(value);
	const kind = requiredString(input.kind, "deferred run dependency kind");
	if (kind !== "deferred-run") {
		throw new Error(`Invalid deferred run dependency kind: ${kind}`);
	}
	return compactUndefined({
		kind: "deferred-run" as const,
		intentId: requiredString(input.intentId, "deferred run dependency intentId"),
		status: deferredDependencyStatusValue(input.status, "deferred run dependency status"),
	});
}

function parseDeferredRunRetryParams(value: unknown): DeferredRunRetryParams {
	const input = record(value);
	const runAt = optionalString(input.runAt);
	if (runAt && Number.isNaN(Date.parse(runAt))) {
		throw new Error(`Deferred run retry runAt must be an ISO-compatible date: ${runAt}`);
	}
	return compactUndefined({
		id: optionalString(input.id),
		runAt,
		createdBy: optionalString(input.createdBy),
		reason: optionalString(input.reason),
		source: recordOrUndefined(input.source),
	});
}

function retryDeferredRunSource(
	originalIntent: DeferredRunIntent,
	source: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const originalSource = recordOrUndefined(originalIntent.source) ?? {};
	return compactUndefined({
		...originalSource,
		kind: optionalString(originalSource.kind) ?? "deferred-retry",
		retry: compactUndefined({
			kind: "deferred-retry",
			originalIntentId: originalIntent.id,
			originalStatus: originalIntent.status,
			originalRunAt: originalIntent.runAt,
			originalUpdatedAt: originalIntent.updatedAt,
			details: source,
		}),
	});
}

function promptQueueSource(
	input: PromptQueueEnqueueParams,
	after: DeferredRunDependency | undefined,
): Record<string, unknown> {
	return compactUndefined({
		kind: "prompt-queue",
		queue: input.queue ?? "default",
		title: input.title,
		labels: input.labels,
		after,
		details: input.source,
	});
}

function localHandoffSource(
	input: LocalHandoffEnqueueParams,
	after: DeferredRunDependency | undefined,
): Record<string, unknown> {
	const requester = compactUndefined({
		host: input.requesterHost,
		threadId: input.requesterThreadId,
	});
	return compactUndefined({
		kind: "local-handoff",
		queue: input.queue ?? "local",
		title: input.title,
		labels: input.labels,
		targetHost: input.targetHost ?? "local-controller",
		requiredCapabilities: input.requiredCapabilities,
		requester: Object.keys(requester).length > 0 ? requester : undefined,
		after,
		details: input.source,
	});
}

function isPromptQueueIntent(intent: DeferredRunIntent, queue?: string): boolean {
	if (intent.target.kind !== "turn") {
		return false;
	}
	const source = recordOrUndefined(intent.source);
	if (source?.kind !== "prompt-queue") {
		return false;
	}
	return !queue || source.queue === queue;
}

function isLocalHandoffIntent(
	intent: DeferredRunIntent,
	options: {
		queue?: string;
		targetHost?: string;
		hostId?: string;
		capabilities?: string[];
	} = {},
): boolean {
	if (intent.target.kind !== "turn") {
		return false;
	}
	const source = recordOrUndefined(intent.source);
	if (source?.kind !== "local-handoff") {
		return false;
	}
	if (options.queue && source.queue !== options.queue) {
		return false;
	}
	const targetHost = optionalString(source.targetHost) ?? "local-controller";
	if (options.targetHost && targetHost !== options.targetHost) {
		return false;
	}
	if (options.hostId && targetHost !== "local-controller" && targetHost !== options.hostId) {
		return false;
	}
	if (options.capabilities) {
		const requiredCapabilities = stringArray(source.requiredCapabilities) ?? [];
		const availableCapabilities = new Set(options.capabilities);
		return requiredCapabilities.every((capability) => availableCapabilities.has(capability));
	}
	return true;
}

function parseDeferredRunTarget(value: unknown): DeferredRunTarget {
	const target = record(value);
	const kind = requiredString(target.kind, "deferred run target kind");
	if (kind === "workbench-task") {
		return {
			kind,
			taskId: requiredString(target.taskId, "deferred run workbench-task taskId"),
		};
	}
	if (kind === "automation") {
		return compactUndefined({
			kind,
			automation: requiredString(target.automation, "deferred run automation target automation"),
			event: recordOrUndefined(target.event),
			prompt: optionalString(target.prompt),
			cwd: optionalString(target.cwd),
			model: optionalString(target.model),
			sandbox: sandboxValue(target.sandbox, "deferred run automation target sandbox"),
			approvalPolicy: approvalPolicyValue(target.approvalPolicy, "deferred run automation target approvalPolicy"),
			permissions: optionalString(target.permissions),
		});
	}
	if (kind === "turn") {
		const prompt = requiredString(target.prompt, "deferred run turn target prompt");
		return compactUndefined({
			kind,
			prompt,
			threadId: optionalString(target.threadId),
			cwd: optionalString(target.cwd),
			model: optionalString(target.model),
			serviceTier: optionalString(target.serviceTier),
			effort: reasoningEffortValue(target.effort, "deferred run turn target effort"),
			sandbox: sandboxValue(target.sandbox, "deferred run turn target sandbox"),
			approvalPolicy: approvalPolicyValue(target.approvalPolicy, "deferred run turn target approvalPolicy"),
			permissions: optionalString(target.permissions),
			responsesapiClientMetadata: stringRecord(target.responsesapiClientMetadata),
			outputSchema: target.outputSchema,
		});
	}
	throw new Error(`Invalid deferred run target kind: ${kind}`);
}

function normalizeDeferredRunIntent(value: unknown): DeferredRunIntent {
	const input = record(value);
	return {
		id: requiredString(input.id, "deferred run id"),
		status: deferredRunStatus(input.status),
		mode: workbenchMode(input.mode),
		runAt: requiredString(input.runAt, "deferred run runAt"),
		target: parseDeferredRunTarget(input.target),
		createdAt: requiredString(input.createdAt, "deferred run createdAt"),
		updatedAt: requiredString(input.updatedAt, "deferred run updatedAt"),
		createdBy: optionalString(input.createdBy),
		reason: optionalString(input.reason),
		source: recordOrUndefined(input.source),
		dependsOn: parseDeferredRunDependencies(input.dependsOn),
		attemptIds: Array.isArray(input.attemptIds)
			? input.attemptIds.filter((entry): entry is string => typeof entry === "string")
			: [],
		lease: isRecord(input.lease)
			? {
				attemptId: requiredString(input.lease.attemptId, "deferred run lease attemptId"),
				claimedAt: requiredString(input.lease.claimedAt, "deferred run lease claimedAt"),
				expiresAt: requiredString(input.lease.expiresAt, "deferred run lease expiresAt"),
				executorId: requiredString(input.lease.executorId, "deferred run lease executorId"),
			}
			: undefined,
		completedAt: optionalString(input.completedAt),
		canceledAt: optionalString(input.canceledAt),
		error: optionalString(input.error),
	};
}

function normalizeDeferredRunAttempt(value: unknown): DeferredRunAttempt {
	const input = record(value);
	return {
		id: requiredString(input.id, "deferred run attempt id"),
		intentId: requiredString(input.intentId, "deferred run attempt intentId"),
		status: deferredAttemptStatus(input.status),
		mode: workbenchMode(input.mode),
		startedAt: requiredString(input.startedAt, "deferred run attempt startedAt"),
		finishedAt: optionalString(input.finishedAt),
		executorId: requiredString(input.executorId, "deferred run attempt executorId"),
		leaseExpiresAt: requiredString(input.leaseExpiresAt, "deferred run attempt leaseExpiresAt"),
		outputPath: optionalString(input.outputPath),
		error: optionalString(input.error),
	};
}

function normalizeDeferredRunCollectCursor(
	value: unknown,
	fallbackCursor: string,
): DeferredRunCollectCursor {
	const input = record(value);
	return compactUndefined({
		cursor: optionalString(input.cursor) ?? fallbackCursor,
		updatedAt: requiredString(input.updatedAt, "deferred run collect cursor updatedAt"),
		lastUpdatedAt: optionalString(input.lastUpdatedAt),
		lastIntentId: optionalString(input.lastIntentId),
	});
}

function dueTasks(
	tasks: WorkbenchTask[],
	runs: WorkbenchRunRecord[],
	now: Date,
	intents: DeferredRunIntent[] = [],
): WorkbenchTask[] {
	return tasks.filter((task) => {
		if (!task.enabled) {
			return false;
		}
		if (!task.schedule) {
			return false;
		}
		return isScheduleDue(task.schedule, now) &&
			!hasRunForDate(task.id, runs, now) &&
			!hasScheduledIntentForDate(task.id, intents, now);
	});
}

function isScheduleDue(schedule: string, now: Date): boolean {
	const parts = schedule.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(`Invalid workbench task schedule: ${schedule}`);
	}
	const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
	return cronPartMatches(minute, now.getUTCMinutes()) &&
		cronPartMatches(hour, now.getUTCHours()) &&
		cronPartMatches(dayOfMonth, now.getUTCDate()) &&
		cronPartMatches(month, now.getUTCMonth() + 1) &&
		cronPartMatches(dayOfWeek, now.getUTCDay());
}

function cronPartMatches(part: string | undefined, value: number): boolean {
	if (!part || part === "*") {
		return true;
	}
	return part.split(",").some((item) => Number.parseInt(item, 10) === value);
}

function hasRunForDate(taskId: string, runs: WorkbenchRunRecord[], now: Date): boolean {
	const today = now.toISOString().slice(0, 10);
	return runs.some((run) => run.taskId === taskId && run.startedAt.startsWith(today));
}

function hasScheduledIntentForDate(
	taskId: string,
	intents: DeferredRunIntent[],
	now: Date,
): boolean {
	const expected = scheduledDeferredRunId(taskId, now);
	return intents.some((intent) =>
		intent.id === expected ||
		(
			intent.target.kind === "workbench-task" &&
			intent.target.taskId === taskId &&
			intent.source?.kind === "workbench-task-schedule" &&
			intent.source.date === now.toISOString().slice(0, 10)
		)
	);
}

async function isDeferredIntentDue(
	context: WorkbenchContext,
	intent: DeferredRunIntent,
	now: Date,
): Promise<boolean> {
	if (intent.status === "pending") {
		return intent.runAt <= now.toISOString() &&
			await areDeferredRunDependenciesSatisfied(context, intent.dependsOn);
	}
	if (intent.status === "running" && intent.lease?.expiresAt) {
		return intent.lease.expiresAt <= now.toISOString();
	}
	return false;
}

async function areDeferredRunDependenciesSatisfied(
	context: WorkbenchContext,
	dependencies: DeferredRunDependency[] | undefined,
): Promise<boolean> {
	if (!dependencies || dependencies.length === 0) {
		return true;
	}
	for (const dependency of dependencies) {
		if (dependency.kind !== "deferred-run") {
			return false;
		}
		let intent: DeferredRunIntent;
		try {
			intent = await readDeferredRunIntent(context, dependency.intentId);
		} catch {
			return false;
		}
		const status = dependency.status ?? "completed";
		if (status === "terminal") {
			if (!isTerminalDeferredRunStatus(intent.status)) {
				return false;
			}
			continue;
		}
		if (intent.status !== status) {
			return false;
		}
	}
	return true;
}

function isTerminalDeferredRunStatus(
	status: DeferredRunIntentStatus,
): status is Extract<DeferredRunIntentStatus, "completed" | "failed" | "canceled"> {
	return status === "completed" || status === "failed" || status === "canceled";
}

function isAfterDeferredRunCollectCursor(
	intent: DeferredRunIntent,
	cursor: DeferredRunCollectCursor | undefined,
): boolean {
	if (!cursor?.lastUpdatedAt) {
		return true;
	}
	const updatedAtOrder = intent.updatedAt.localeCompare(cursor.lastUpdatedAt);
	if (updatedAtOrder !== 0) {
		return updatedAtOrder > 0;
	}
	return cursor.lastIntentId ? intent.id.localeCompare(cursor.lastIntentId) > 0 : true;
}

function isWorkbenchRunRecord(value: unknown): value is WorkbenchRunRecord {
	const input = record(value);
	return typeof input.id === "string" &&
		typeof input.taskId === "string" &&
		(input.status === "completed" || input.status === "failed" || input.status === "skipped");
}

function countFailingTasks(tasks: WorkbenchTask[], runs: WorkbenchRunRecord[]): number {
	return tasks.filter((task) => consecutiveFailures(task.id, runs) > 0).length;
}

function workbenchDoctorErrors(context: WorkbenchContext): string[] {
	if (
		context.mode === "actions" &&
		path.resolve(context.runtimeCodexHome) !== path.resolve(context.workbenchCodexHome)
	) {
		return [
			`Actions mode must use repo .codex as CODEX_HOME; got ${context.runtimeCodexHome}`,
		];
	}
	return [];
}

async function collectWorkbenchRunnerInfo(
	context: WorkbenchContext,
	tasks: WorkbenchTask[],
	deferredRuns: DeferredRunIntent[],
	probe: (args: string[]) => Promise<string>,
): Promise<WorkbenchRunnerInfo> {
	const workbenchRoot = path.resolve(context.repoRoot);
	const hasScheduledWork = tasks.some((task) => task.enabled && task.schedule);
	const hasPendingDeferredWork = deferredRuns.some((intent) =>
		intent.status === "pending" || intent.status === "running"
	);
	const hasRunnableWork = hasScheduledWork || hasPendingDeferredWork;
	const base: Pick<WorkbenchRunnerInfo, "kind" | "workbenchRoot" | "candidates"> = {
		kind: "systemd-user",
		workbenchRoot,
		candidates: [],
	};
	if (context.mode !== "local") {
		return {
			...base,
			status: "unsupported",
			warning: hasRunnableWork
				? "Runner visibility currently checks local systemd user timers only."
				: undefined,
		};
	}
	if (os.platform() !== "linux") {
		return {
			...base,
			status: "unsupported",
			warning: hasRunnableWork
				? "No local systemd user timer check is available on this platform."
				: undefined,
		};
	}
	try {
		const timerRows = parseSystemdTimerRows(
			await probe(["list-timers", "--all", "--no-legend", "--no-pager"]),
		);
		const candidates: WorkbenchRunnerCandidate[] = [];
		for (const row of timerRows) {
			const serviceShow = parseSystemdShow(await probe([
				"show",
				row.service,
				"--property=ExecStart",
				"--property=ActiveState",
				"--property=UnitFileState",
				"--no-pager",
			]));
			const command = normalizeSystemdCommand(serviceShow.ExecStart);
			if (!command.includes("codex-toys")) {
				continue;
			}
			const runsWorkbenchTick = /\bworkbench\s+tick\b/.test(command);
			const runsDeferredOnly = /\bworkbench\s+deferred\s+run-due\b/.test(command);
			if (!runsWorkbenchTick && !runsDeferredOnly) {
				continue;
			}
			const timerShow = parseSystemdShow(await probe([
				"show",
				row.timer,
				"--property=ActiveState",
				"--property=UnitFileState",
				"--property=NextElapseUSecRealtime",
				"--property=LastTriggerUSec",
				"--no-pager",
			]));
			const runnerWorkbenchRoot = extractWorkbenchRootFromCommand(command);
			const matchesWorkbench = runnerWorkbenchRoot
				? path.resolve(runnerWorkbenchRoot) === workbenchRoot
				: command.includes(workbenchRoot);
			candidates.push(compactUndefined({
				kind: "systemd-user",
				timer: row.timer,
				service: row.service,
				command,
				activeState: serviceShow.ActiveState,
				unitFileState: serviceShow.UnitFileState,
				timerActiveState: timerShow.ActiveState,
				timerUnitFileState: timerShow.UnitFileState,
				nextTrigger: timerShow.NextElapseUSecRealtime,
				lastTrigger: timerShow.LastTriggerUSec,
				workbenchRoot: runnerWorkbenchRoot,
				runsWorkbenchTick,
				runsDeferredOnly,
				matchesWorkbench,
			}));
		}
		const selected = candidates.find((candidate) =>
			candidate.matchesWorkbench &&
			candidate.runsWorkbenchTick &&
			candidate.timerActiveState === "active"
		) ?? candidates.find((candidate) =>
			candidate.matchesWorkbench &&
			candidate.timerActiveState === "active"
		) ?? candidates.find((candidate) =>
			candidate.matchesWorkbench &&
			candidate.runsWorkbenchTick
		) ?? candidates.find((candidate) => candidate.matchesWorkbench);
		if (!selected) {
			return {
				...base,
				status: "missing",
				candidates,
				warning: hasRunnableWork
					? "No matching local runner was found; due work needs a manual tick or another scheduler."
					: undefined,
			};
		}
		const status = selected.timerActiveState === "active" ? "active" : "inactive";
		return {
			...base,
			status,
			selected,
			candidates,
			warning: selected.runsDeferredOnly
				? "The matching runner only runs deferred work; scheduled tasks need workbench tick."
				: status === "inactive" && hasRunnableWork
					? "The matching local runner is not active; due work needs a manual tick or another scheduler."
					: undefined,
		};
	} catch (error) {
		return {
			...base,
			status: "unknown",
			error: error instanceof Error ? error.message : String(error),
			warning: hasRunnableWork
				? "Could not inspect local runner status; due work may need a manual tick or another scheduler."
				: undefined,
		};
	}
}

function parseSystemdTimerRows(output: string): Array<{ timer: string; service: string }> {
	const rows: Array<{ timer: string; service: string }> = [];
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const fields = trimmed.split(/\s+/);
		const timerIndex = fields.findIndex((field) => field.endsWith(".timer"));
		if (timerIndex < 0) {
			continue;
		}
		const timer = fields[timerIndex];
		const service = fields[timerIndex + 1];
		if (!timer || !service?.endsWith(".service")) {
			continue;
		}
		rows.push({ timer, service });
	}
	return rows;
}

function parseSystemdShow(output: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of output.split(/\r?\n/)) {
		const index = line.indexOf("=");
		if (index <= 0) {
			continue;
		}
		result[line.slice(0, index)] = line.slice(index + 1);
	}
	return result;
}

function normalizeSystemdCommand(value: string | undefined): string {
	return (value ?? "")
		.replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16))
		)
		.replace(/\s+/g, " ")
		.trim();
}

function extractWorkbenchRootFromCommand(command: string): string | undefined {
	const match = command.match(/--workbench-root(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;]+))/);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

function formatWorkbenchRunnerInfo(runner: WorkbenchRunnerInfo | undefined): string {
	if (!runner) {
		return "not checked";
	}
	if (runner.selected) {
		const command = runner.selected.runsWorkbenchTick ? "workbench tick" : "workbench deferred run-due";
		return `${runner.status} ${runner.selected.timer} -> ${runner.selected.service} (${command})`;
	}
	if (runner.status === "unsupported") {
		return "unsupported";
	}
	if (runner.status === "unknown") {
		return `unknown${runner.error ? ` (${runner.error})` : ""}`;
	}
	return `${runner.status}${runner.candidates.length > 0 ? ` (${runner.candidates.length} codex-toys runner candidates)` : ""}`;
}

function consecutiveFailures(taskId: string, runs: WorkbenchRunRecord[]): number {
	let count = 0;
	for (const run of runs.filter((item) => item.taskId === taskId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
		if (run.status !== "failed") {
			break;
		}
		count += 1;
	}
	return count;
}

function runRecord(
	context: WorkbenchContext,
	id: string,
	taskId: string,
	kind: WorkbenchRunRecord["kind"],
	startedAt: string,
	status: WorkbenchRunRecord["status"],
	outputPath?: string,
	error?: string,
): WorkbenchRunRecord {
	return {
		id,
		taskId,
		kind,
		status,
		startedAt,
		finishedAt: new Date().toISOString(),
		mode: context.mode,
		...(outputPath ? { outputPath } : {}),
		...(error ? { error } : {}),
	};
}

async function ensureStateDirs(context: WorkbenchContext): Promise<void> {
	for (const name of ["state", "runs", "outputs", "health"]) {
		await mkdir(path.join(context.stateRoot, name), { recursive: true });
	}
}

async function ensureDeferredRunDirs(context: WorkbenchContext): Promise<void> {
	for (const dir of [
		deferredIntentDir(context),
		deferredAttemptDir(context),
		deferredOutputDir(context),
		deferredClaimDir(context),
		deferredCollectCursorDir(context),
	]) {
		await mkdir(dir, { recursive: true });
	}
}

function deferredRoot(context: WorkbenchContext): string {
	return path.join(context.stateRoot, "deferred");
}

function deferredIntentDir(context: WorkbenchContext): string {
	return path.join(deferredRoot(context), "intents");
}

function deferredAttemptDir(context: WorkbenchContext): string {
	return path.join(deferredRoot(context), "attempts");
}

function deferredOutputDir(context: WorkbenchContext): string {
	return path.join(deferredRoot(context), "outputs");
}

function deferredClaimDir(context: WorkbenchContext): string {
	return path.join(deferredRoot(context), "claims");
}

function deferredCollectCursorDir(context: WorkbenchContext): string {
	return path.join(deferredRoot(context), "collect-cursors");
}

function deferredIntentPath(context: WorkbenchContext, intentId: string): string {
	return path.join(deferredIntentDir(context), `${safeFileSegment(intentId)}.json`);
}

function deferredAttemptPath(context: WorkbenchContext, attemptId: string): string {
	return path.join(deferredAttemptDir(context), `${safeFileSegment(attemptId)}.json`);
}

function deferredClaimPath(context: WorkbenchContext, intentId: string): string {
	return path.join(deferredClaimDir(context), `${safeFileSegment(intentId)}.json`);
}

function deferredCollectCursorPath(context: WorkbenchContext, cursor: string): string {
	return path.join(deferredCollectCursorDir(context), `${safeFileSegment(cursor)}.json`);
}

function deferredCollectCursorName(value: string | undefined, defaultCursor = "default"): string {
	const cursor = value?.trim() || defaultCursor;
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(cursor)) {
		throw new Error(`Invalid deferred collect cursor: ${cursor}`);
	}
	return cursor;
}

function deferredRunId(createdAt: string): string {
	return `deferred-${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function deferredRetryRunId(originalIntentId: string, createdAt: string): string {
	return `retry-${safeFileSegment(originalIntentId).slice(0, 40)}-${createdAt.replace(/[:.]/g, "-")}-${
		randomUUID().slice(0, 8)
	}`;
}

function deferredAttemptId(intentId: string, startedAt: string): string {
	return `${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}-${safeFileSegment(intentId).slice(0, 48)}`;
}

function scheduledDeferredRunId(taskId: string, now: Date): string {
	return `scheduled-${safeFileSegment(taskId)}-${now.toISOString().slice(0, 10)}`;
}

function safeFileSegment(value: string): string {
	const safe = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return safe.slice(0, 120) || "deferred-run";
}

async function writeNewJsonFile(file: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const handle = await open(file, "wx");
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
	} finally {
		await handle.close();
	}
}

async function writeJsonFileAtomic(file: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const tmpPath = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
	await rename(tmpPath, file);
}

async function writeScaffoldFile(
	workbenchRoot: string,
	relativePath: string,
	content: string,
	overwrite: boolean,
): Promise<ScaffoldActionsWorkbenchResult["files"][number]> {
	const file = path.join(workbenchRoot, relativePath);
	const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;
	if (await exists(file)) {
		const current = await readFile(file, "utf8");
		if (current === normalizedContent) {
			return { path: file, action: "unchanged" };
		}
		if (!overwrite) {
			return { path: file, action: "unchanged" };
		}
		await writeFile(file, normalizedContent);
		return { path: file, action: "updated" };
	}
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, normalizedContent);
	return { path: file, action: "created" };
}

async function appendGitignoreEntries(
	workbenchRoot: string,
	entries: string[],
	removeEntries: string[] = [],
): Promise<ScaffoldActionsWorkbenchResult["files"][number]> {
	const file = path.join(workbenchRoot, ".gitignore");
	let current = "";
	try {
		current = await readFile(file, "utf8");
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") {
			throw error;
		}
	}
	const removeSet = new Set(removeEntries);
	const currentLines = current.split(/\r?\n/).filter(Boolean);
	const keptLines = currentLines.filter((line) => !removeSet.has(line));
	const lines = new Set(keptLines);
	const missing = entries.filter((entry) => !lines.has(entry));
	const changed = missing.length > 0 || keptLines.length !== currentLines.length;
	if (!changed) {
		return { path: file, action: current ? "unchanged" : "created" };
	}
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${[...keptLines, ...missing].join("\n")}\n`);
	return { path: file, action: current ? "updated" : "created" };
}

function workbenchTomlTemplate(workbenchRoot: string): string {
	const lines = [
		"[workbench]",
		`name = ${tomlString(path.basename(workbenchRoot))}`,
		"",
	];
	return lines.join("\n");
}

function codexConfigTemplate(): string {
	return [
		"# Codex configuration for repository-scoped Actions runs.",
		"# Actions helpers set CODEX_HOME to this .codex directory at runtime.",
		"",
	].join("\n");
}

function actionsWorkflowTemplate(provider: "forgejo" | "github"): string {
	const checkout = provider === "github" ? "actions/checkout@v4" : "actions/checkout@v4";
	const setupNode = provider === "github" ? "actions/setup-node@v4" : "actions/setup-node@v4";
	return [
		"name: Codex Toys Actions",
		"",
		"on:",
		"  workflow_dispatch:",
		"  schedule:",
		"    - cron: '0 * * * *'",
		"",
		"jobs:",
		"  workbench:",
		"    runs-on: ubuntu-latest",
		"    permissions:",
		"      contents: write",
		"    steps:",
		`      - uses: ${checkout}`,
		`      - uses: ${setupNode}`,
		"        with:",
		"          node-version: 24",
		"      - run: npm install -g vite-plus",
		"      - run: vp dlx codex-toys actions prepare-auth",
		"        env:",
		"          CODEX_AUTH_JSON_B64: ${{ secrets.CODEX_AUTH_JSON_B64 }}",
		"          CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
		"          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}",
		"      - run: vp dlx codex-toys workbench tick --mode actions",
		"      - if: always()",
		"        run: vp dlx codex-toys actions cleanup",
		"      - if: always()",
		"        run: |",
		"          git add -- .codex/memories .codex/workbench/actions",
		"          if [ -d .codex/feed/actions ]; then",
		"            git add -- .codex/feed/actions",
		"          fi",
		"          if [ -d .codex/sessions ]; then",
		"            git add -A -f -- .codex/sessions",
		"          fi",
		"          git diff --cached --quiet && exit 0",
		"          git config user.name codex-toys-actions",
		"          git config user.email codex-toys-actions@users.noreply.github.com",
		"          git commit -m \"Update Codex workbench state\"",
		"          git push",
		"",
	].join("\n");
}

function actionsGitignoreEntries(): string[] {
	return [
		".codex/auth.json",
		".codex/install_id",
		".codex/install-id",
		".codex/installation_id",
		".codex/shell_snapshots/",
		".codex/shell-snapshots/",
		".codex/tmp/",
		".codex/temp/",
		".codex/workbench/local/",
		".codex/**/*.sqlite",
		".codex/**/*.sqlite3",
		".codex/**/*.db",
	];
}

function retiredActionsGitignoreEntries(): string[] {
	return [
		".codex/sessions/",
	];
}

function parseSurface(input: unknown): WorkbenchSurface {
	if (!isRecord(input)) {
		throw new Error("workbench.surfaces entries must be tables");
	}
	return {
		key: requiredString(input.key, "workbench surface key"),
		kind: stringValue(input.kind, "local"),
		homeChannelId: optionalString(input.home_channel_id),
		workbenchForumChannelId: optionalString(input.workbench_forum_channel_id),
		taskThreadsChannelId: optionalString(input.task_threads_channel_id),
	};
}

function parseTask(input: unknown): WorkbenchTask {
	if (!isRecord(input)) {
		throw new Error("workbench.tasks entries must be tables");
	}
	const id = requiredTaskId(input.id);
	const enabled = input.enabled === undefined ? true : booleanValue(input.enabled, `workbench task ${id} enabled`);
	const kind = requiredString(input.kind, `workbench task ${id} kind`);
	const schedule = optionalString(input.schedule);
	if (schedule) {
		isScheduleDue(schedule, new Date());
	}
	if (kind === "skill") {
		return { id, enabled, kind, skill: requiredString(input.skill, `workbench task ${id} skill`), schedule, var: optionalString(input.var) };
	}
	if (kind === "automation") {
		return {
			id,
			enabled,
			kind,
			automation: requiredString(input.automation, `workbench task ${id} automation`),
			schedule,
			event: isRecord(input.event) ? input.event : undefined,
			prompt: optionalString(input.prompt),
			cwd: optionalString(input.cwd),
		};
	}
	if (kind === "command") {
		if (!Array.isArray(input.command) || !input.command.every((item) => typeof item === "string")) {
			throw new Error(`workbench task ${id} command must be an array of strings`);
		}
		return { id, enabled, kind, command: input.command, schedule };
	}
	throw new Error(`Invalid workbench task kind for ${id}: ${kind}`);
}

function parseReactiveRule(input: unknown): WorkbenchReactiveRule {
	if (!isRecord(input)) {
		throw new Error("workbench.reactive entries must be tables");
	}
	const id = requiredTaskId(input.id);
	const kind = requiredString(input.kind, `workbench reactive ${id} kind`);
	if (kind !== "skill") {
		throw new Error(`Invalid workbench reactive kind for ${id}: ${kind}`);
	}
	return {
		id,
		enabled: input.enabled === undefined ? true : booleanValue(input.enabled, `workbench reactive ${id} enabled`),
		task: requiredString(input.task, `workbench reactive ${id} task`),
		consecutiveFailuresGte: positiveInteger(input.consecutive_failures_gte, `workbench reactive ${id} consecutive_failures_gte`),
		kind,
		skill: requiredString(input.skill, `workbench reactive ${id} skill`),
	};
}

function requiredTaskId(value: unknown): string {
	const id = requiredString(value, "workbench task id");
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) {
		throw new Error(`Invalid workbench task id: ${id}`);
	}
	return id;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function compactUndefined<T extends Record<string, unknown>>(value: T): T {
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			result[key] = entry;
		}
	}
	return result as T;
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function booleanValue(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a boolean`);
	}
	return value;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const entries = Object.entries(value).filter((entry): entry is [string, string] =>
		typeof entry[1] === "string"
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return entries.length > 0 ? entries : undefined;
}

function sandboxValue(
	value: unknown,
	label: string,
): "danger-full-access" | "read-only" | "workspace-write" | undefined {
	if (
		value === "danger-full-access" ||
		value === "read-only" ||
		value === "workspace-write"
	) {
		return value;
	}
	if (value !== undefined) {
		throw new Error(`${label} must be danger-full-access, workspace-write, or read-only`);
	}
	return undefined;
}

function approvalPolicyValue(
	value: unknown,
	label: string,
): "never" | "on-failure" | "on-request" | "untrusted" | undefined {
	if (
		value === "never" ||
		value === "on-failure" ||
		value === "on-request" ||
		value === "untrusted"
	) {
		return value;
	}
	if (value !== undefined) {
		throw new Error(`${label} must be never, on-failure, on-request, or untrusted`);
	}
	return undefined;
}

function reasoningEffortValue(
	value: unknown,
	label: string,
): DeferredReasoningEffort | undefined {
	if (
		value === "none" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	) {
		return value;
	}
	if (value !== undefined) {
		throw new Error(`${label} must be none, minimal, low, medium, high, or xhigh`);
	}
	return undefined;
}

function deferredDependencyStatusValue(
	value: unknown,
	label: string,
): DeferredRunDependency["status"] | undefined {
	if (
		value === "completed" ||
		value === "failed" ||
		value === "canceled" ||
		value === "terminal"
	) {
		return value;
	}
	if (value !== undefined) {
		throw new Error(`${label} must be completed, failed, canceled, or terminal`);
	}
	return undefined;
}

function deferredRunStatus(value: unknown): DeferredRunIntentStatus {
	if (
		value === "pending" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "canceled"
	) {
		return value;
	}
	throw new Error(`Invalid deferred run status: ${String(value)}`);
}

function deferredAttemptStatus(value: unknown): DeferredRunAttempt["status"] {
	if (value === "running" || value === "completed" || value === "failed") {
		return value;
	}
	throw new Error(`Invalid deferred run attempt status: ${String(value)}`);
}

function workbenchMode(value: unknown): WorkbenchMode {
	if (value === "local" || value === "actions") {
		return value;
	}
	throw new Error(`Invalid workbench mode: ${String(value)}`);
}

function positiveInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampLimit(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(1, Math.min(1_000, Math.trunc(value)));
}

function isNotFoundError(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
	return isRecord(error) && error.code === "EEXIST";
}

async function exists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
}

function defaultCodexHome(): string {
	return path.join(os.homedir(), ".codex");
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
