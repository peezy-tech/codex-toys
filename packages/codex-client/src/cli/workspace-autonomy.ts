import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "bun";

export type WorkspaceModeInput = "auto" | "local" | "actions";
export type WorkspaceMode = "local" | "actions";

export type WorkspaceSurface = {
	key: string;
	kind: string;
	homeChannelId?: string;
	workspaceForumChannelId?: string;
	taskThreadsChannelId?: string;
};

export type WorkspaceTask =
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
			kind: "flow";
			flow: string;
			event?: Record<string, unknown>;
			schedule?: string;
	  }
	| {
			id: string;
			enabled: boolean;
			kind: "command";
			command: string[];
			schedule?: string;
	  };

export type WorkspaceReactiveRule = {
	id: string;
	enabled: boolean;
	task: string;
	consecutiveFailuresGte: number;
	kind: "skill";
	skill: string;
};

export type WorkspaceConfig = {
	name: string;
	surfaces: WorkspaceSurface[];
	tasks: WorkspaceTask[];
	reactive: WorkspaceReactiveRule[];
	path: string;
};

export type WorkspaceContext = {
	mode: WorkspaceMode;
	requestedMode: WorkspaceModeInput;
	repoRoot: string;
	configPath: string;
	workspaceCodexHome: string;
	runtimeCodexHome: string;
	stateRoot: string;
	localStateRoot: string;
	actionsStateRoot: string;
	globalCodexHome: string;
	actionsCommitPaths: string[];
};

export type WorkspaceRunRecord = {
	id: string;
	taskId: string;
	status: "completed" | "failed" | "skipped";
	kind: WorkspaceTask["kind"] | "reactive";
	startedAt: string;
	finishedAt: string;
	mode: WorkspaceMode;
	outputPath?: string;
	error?: string;
};

export type WorkspaceDoctorInfo = {
	mode: WorkspaceMode;
	requestedMode: WorkspaceModeInput;
	repoRoot: string;
	configPath: string;
	configExists: boolean;
	runtimeCodexHome: string;
	workspaceCodexHome: string;
	stateRoot: string;
	localStateRoot: string;
	actionsStateRoot: string;
	globalMemoryRoot: string;
	workspaceMemoryRoot: string;
	globalMemorySummaryExists: boolean;
	workspaceMemorySummaryExists: boolean;
	taskCount: number;
	dueCount: number;
	failingCount: number;
	latestRun?: WorkspaceRunRecord;
	surfaces: WorkspaceSurface[];
	errors: string[];
};

export type ScaffoldActionsWorkspaceOptions = {
	workspaceRoot?: string;
	forgejo?: boolean;
	github?: boolean;
	withSmoke?: boolean;
	withAgentTurn?: boolean;
	overwrite?: boolean;
};

export type ScaffoldActionsWorkspaceResult = {
	workspaceRoot: string;
	files: Array<{
		path: string;
		action: "created" | "updated" | "unchanged";
	}>;
};

export async function discoverWorkspaceRoot(start = process.cwd()): Promise<string> {
	let current = path.resolve(start);
	let firstDotCodexRoot: string | undefined;
	while (true) {
		try {
			const workspaceConfig = path.join(current, ".codex", "workspace.toml");
			if ((await stat(workspaceConfig)).isFile()) {
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

export function resolveWorkspaceMode(
	input: WorkspaceModeInput | undefined,
	env: Record<string, string | undefined> = process.env,
): { requestedMode: WorkspaceModeInput; mode: WorkspaceMode } {
	const requestedMode = input ?? parseMode(env.CODEX_WORKSPACE_MODE) ?? "auto";
	if (requestedMode === "actions") {
		return { requestedMode, mode: "actions" };
	}
	if (requestedMode === "local") {
		return { requestedMode, mode: "local" };
	}
	return { requestedMode, mode: env.GITHUB_ACTIONS === "true" ? "actions" : "local" };
}

export function parseMode(value: string | undefined): WorkspaceModeInput | undefined {
	if (value === undefined || value === "") {
		return undefined;
	}
	if (value === "auto" || value === "local" || value === "actions") {
		return value;
	}
	throw new Error(`Invalid workspace mode: ${value}`);
}

export async function createWorkspaceContext(options: {
	workspaceRoot?: string;
	mode?: WorkspaceModeInput;
	env?: Record<string, string | undefined>;
} = {}): Promise<WorkspaceContext> {
	const env = options.env ?? process.env;
	const repoRoot = path.resolve(options.workspaceRoot ?? await discoverWorkspaceRoot());
	const resolved = resolveWorkspaceMode(options.mode, env);
	const workspaceCodexHome = path.join(repoRoot, ".codex");
	const globalCodexHome = env.CODEX_HOME ?? defaultCodexHome();
	return {
		mode: resolved.mode,
		requestedMode: resolved.requestedMode,
		repoRoot,
		configPath: path.join(workspaceCodexHome, "workspace.toml"),
		workspaceCodexHome,
		runtimeCodexHome: resolved.mode === "actions" ? workspaceCodexHome : globalCodexHome,
		stateRoot: path.join(workspaceCodexHome, "workspace", resolved.mode),
		localStateRoot: path.join(workspaceCodexHome, "workspace", "local"),
		actionsStateRoot: path.join(workspaceCodexHome, "workspace", "actions"),
		globalCodexHome,
		actionsCommitPaths: [
			path.join(workspaceCodexHome, "memories"),
			path.join(workspaceCodexHome, "workspace", "actions"),
		],
	};
}

export async function loadWorkspaceConfig(context: WorkspaceContext): Promise<WorkspaceConfig> {
	const text = await readFile(context.configPath, "utf8");
	const parsed = Bun.TOML.parse(text) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`workspace.toml must contain a table: ${context.configPath}`);
	}
	const workspace = isRecord(parsed.workspace) ? parsed.workspace : undefined;
	const legacySurfaces = isRecord(parsed.discord) &&
		isRecord(parsed.discord.gateway) &&
		Array.isArray(parsed.discord.gateway.surfaces)
		? parsed.discord.gateway.surfaces
		: undefined;
	const surfacesInput = Array.isArray(workspace?.surfaces)
		? workspace.surfaces
		: legacySurfaces ?? [];
	const tasksInput = Array.isArray(workspace?.tasks) ? workspace.tasks : [];
	const reactiveInput = Array.isArray(workspace?.reactive) ? workspace.reactive : [];
	const tasks = tasksInput.map(parseTask);
	const ids = new Set<string>();
	for (const task of tasks) {
		if (ids.has(task.id)) {
			throw new Error(`Duplicate workspace task id: ${task.id}`);
		}
		ids.add(task.id);
	}
	return {
		name: stringValue(workspace?.name, path.basename(context.repoRoot)),
		surfaces: surfacesInput.map(parseSurface),
		tasks,
		reactive: reactiveInput.map(parseReactiveRule),
		path: context.configPath,
	};
}

export async function migrateWorkspaceConfig(context: WorkspaceContext): Promise<boolean> {
	const text = await readFile(context.configPath, "utf8");
	if (!text.includes("[[discord.gateway.surfaces]]") || text.includes("[workspace]")) {
		return false;
	}
	const parsed = Bun.TOML.parse(text) as unknown;
	if (!isRecord(parsed) || !isRecord(parsed.discord) || !isRecord(parsed.discord.gateway) ||
		!Array.isArray(parsed.discord.gateway.surfaces)) {
		return false;
	}
	const lines = [`[workspace]`, `name = ${tomlString(path.basename(context.repoRoot))}`, ""];
	for (const surface of parsed.discord.gateway.surfaces) {
		if (!isRecord(surface)) {
			continue;
		}
		lines.push("[[workspace.surfaces]]");
		lines.push(`key = ${tomlString(stringValue(surface.key, "default"))}`);
		lines.push(`kind = "discord"`);
		for (const [source, target] of [
			["home_channel_id", "home_channel_id"],
			["workspace_forum_channel_id", "workspace_forum_channel_id"],
			["task_threads_channel_id", "task_threads_channel_id"],
		] as const) {
			const value = surface[source];
			if (typeof value === "string") {
				lines.push(`${target} = ${tomlString(value)}`);
			}
		}
		lines.push("");
	}
	await writeFile(context.configPath, `${lines.join("\n").trimEnd()}\n`);
	return true;
}

export async function collectWorkspaceDoctorInfo(context: WorkspaceContext): Promise<WorkspaceDoctorInfo> {
	let config: WorkspaceConfig | undefined;
	let configExists = true;
	try {
		config = await loadWorkspaceConfig(context);
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
	const failingCount = countFailingTasks(config?.tasks ?? [], runs);
	return {
		mode: context.mode,
		requestedMode: context.requestedMode,
		repoRoot: context.repoRoot,
		configPath: context.configPath,
		configExists,
		runtimeCodexHome: context.runtimeCodexHome,
		workspaceCodexHome: context.workspaceCodexHome,
		stateRoot: context.stateRoot,
		localStateRoot: context.localStateRoot,
		actionsStateRoot: context.actionsStateRoot,
		globalMemoryRoot: path.join(context.globalCodexHome, "memories"),
		workspaceMemoryRoot: path.join(context.workspaceCodexHome, "memories"),
		globalMemorySummaryExists: await exists(path.join(context.globalCodexHome, "memories", "memory_summary.md")),
		workspaceMemorySummaryExists: await exists(path.join(context.workspaceCodexHome, "memories", "memory_summary.md")),
		taskCount: config?.tasks.length ?? 0,
		dueCount: dueTasks(config?.tasks ?? [], runs, new Date()).length,
		failingCount,
		latestRun,
		surfaces: config?.surfaces ?? [],
		errors: workspaceDoctorErrors(context),
	};
}

export function formatWorkspaceDoctorInfo(info: WorkspaceDoctorInfo): string {
	const rows: Array<[string, string]> = [
		["mode", info.requestedMode === info.mode ? info.mode : `${info.mode} (${info.requestedMode})`],
		["repo root", info.repoRoot],
		["config", `${info.configPath}${info.configExists ? "" : " (missing)"}`],
		["runtime CODEX_HOME", info.runtimeCodexHome],
		["workspace CODEX_HOME", info.workspaceCodexHome],
		["state root", info.stateRoot],
		["local state", info.localStateRoot],
		["actions state", info.actionsStateRoot],
		["global memories", `${info.globalMemoryRoot}${info.globalMemorySummaryExists ? " (summary)" : ""}`],
		["workspace memories", `${info.workspaceMemoryRoot}${info.workspaceMemorySummaryExists ? " (summary)" : ""}`],
		["tasks", `${info.taskCount} configured, ${info.dueCount} due, ${info.failingCount} failing`],
		["latest run", info.latestRun ? `${info.latestRun.status} ${info.latestRun.taskId} ${info.latestRun.finishedAt}` : "none"],
	];
	for (const error of info.errors) {
		rows.push(["error", error]);
	}
	return `${rows.map(([label, value]) => `${label.padEnd(19)} ${value}`).join("\n")}\n`;
}

export async function scaffoldActionsWorkspace(
	options: ScaffoldActionsWorkspaceOptions = {},
): Promise<ScaffoldActionsWorkspaceResult> {
	const workspaceRoot = path.resolve(options.workspaceRoot ?? await discoverWorkspaceRoot());
	const files: ScaffoldActionsWorkspaceResult["files"] = [];
	const write = async (relativePath: string, content: string): Promise<void> => {
		files.push(await writeScaffoldFile(workspaceRoot, relativePath, content, options.overwrite === true));
	};

	await write(".codex/workspace.toml", workspaceTomlTemplate(workspaceRoot, options));
	await write(".codex/config.toml", codexConfigTemplate());
	if (options.forgejo) {
		await write(".forgejo/workflows/codex-flows-actions.yml", actionsWorkflowTemplate("forgejo"));
	}
	if (options.github || !options.forgejo) {
		await write(".github/workflows/codex-flows-actions.yml", actionsWorkflowTemplate("github"));
	}
	if (options.withSmoke) {
		await write(".codex/flows/actions-smoke/flow.toml", smokeFlowToml());
		await write(".codex/flows/actions-smoke/exec/smoke.ts", smokeFlowScript());
	}
	if (options.withAgentTurn) {
		await write(".codex/flows/actions-agent-turn/flow.toml", agentTurnFlowToml());
		await write(".codex/flows/actions-agent-turn/exec/agent-turn.ts", agentTurnFlowScript());
	}
	files.push(await appendGitignoreEntries(workspaceRoot, actionsGitignoreEntries()));
	return { workspaceRoot, files };
}

export async function tickWorkspace(
	context: WorkspaceContext,
	options: { callWorkspaceBackend: (method: string, params: unknown) => Promise<unknown> },
): Promise<{ mode: WorkspaceMode; due: string[]; runs: WorkspaceRunRecord[] }> {
	await ensureStateDirs(context);
	const config = await loadWorkspaceConfig(context);
	const previousRuns = await readRuns(context);
	const due = dueTasks(config.tasks, previousRuns, new Date());
	const runs: WorkspaceRunRecord[] = [];
	for (const task of due) {
		runs.push(await runWorkspaceTask(context, config, task, options));
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

export async function runWorkspaceTaskById(
	context: WorkspaceContext,
	taskId: string,
	options: { callWorkspaceBackend: (method: string, params: unknown) => Promise<unknown> },
): Promise<WorkspaceRunRecord> {
	await ensureStateDirs(context);
	const config = await loadWorkspaceConfig(context);
	const task = config.tasks.find((item) => item.id === taskId);
	if (!task) {
		throw new Error(`Unknown workspace task: ${taskId}`);
	}
	return await runWorkspaceTask(context, config, task, options);
}

export async function commitActionsWorkspaceState(
	context: WorkspaceContext,
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
	await runGit(context.repoRoot, ["add", "--", ...relativePaths]);
	const staged = await runGit(context.repoRoot, ["diff", "--cached", "--name-only", "--", ...relativePaths]);
	if (!staged.stdout.trim()) {
		return { attempted: true, committed: false, paths: context.actionsCommitPaths };
	}
	const commit = await runGit(context.repoRoot, [
		"commit",
		"-m",
		options.message ?? "Update Codex workspace state",
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

async function runWorkspaceTask(
	context: WorkspaceContext,
	config: WorkspaceConfig,
	task: WorkspaceTask,
	options: { callWorkspaceBackend: (method: string, params: unknown) => Promise<unknown> },
): Promise<WorkspaceRunRecord> {
	const startedAt = new Date().toISOString();
	const runId = workspaceRunId(task.id, startedAt);
	const outputPath = path.join(context.stateRoot, "outputs", `${runId}.json`);
	try {
		let result: unknown;
		if (!task.enabled) {
			result = { skipped: "disabled" };
			const run = runRecord(context, runId, task.id, task.kind, startedAt, "skipped", outputPath);
			await persistRun(context, run, result);
			return run;
		}
		if (task.kind === "flow") {
			result = await options.callWorkspaceBackend("flow.dispatch", {
				event: workspaceFlowEvent(config, task, runId, startedAt),
			});
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

function workspaceRunId(taskId: string, startedAt: string): string {
	return `${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}-${taskId}`;
}

function workspaceFlowEvent(
	config: WorkspaceConfig,
	task: Extract<WorkspaceTask, { kind: "flow" }>,
	runId: string,
	startedAt: string,
): Record<string, unknown> {
	const event = task.event ?? {};
	const payload = isRecord(event.payload) ? event.payload : {};
	return {
		...event,
		id: `workspace:${config.name}:${task.id}:${runId}`,
		type: stringValue(event.type, task.flow),
		source: stringValue(event.source, config.name),
		occurredAt: startedAt,
		receivedAt: startedAt,
		payload: {
			taskId: task.id,
			...payload,
		},
	};
}

async function runReactiveRule(
	context: WorkspaceContext,
	rule: WorkspaceReactiveRule,
): Promise<WorkspaceRunRecord> {
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

async function runSkill(task: Extract<WorkspaceTask, { kind: "skill" }>, context: WorkspaceContext) {
	const skillPath = path.join(context.runtimeCodexHome, "skills", task.skill, "SKILL.md");
	if (!await exists(skillPath)) {
		throw new Error(`Skill not found: ${skillPath}`);
	}
	return await runCommand([
		process.env.CODEX_APP_SERVER_CODEX_COMMAND ?? "codex",
		"exec",
		"--cwd",
		context.repoRoot,
		`Use the ${task.skill} skill for this workspace task.${task.var ? `\n\nInput: ${task.var}` : ""}`,
	], context);
}

async function runCommand(command: string[], context: WorkspaceContext) {
	if (command.length === 0) {
		throw new Error("command task requires at least one command element");
	}
	const [cmd, ...args] = command;
	if (!cmd) {
		throw new Error("command task requires command executable");
	}
	const env = {
		...process.env,
		CODEX_WORKSPACE_MODE: context.mode,
		CODEX_HOME: context.runtimeCodexHome,
	};
	const proc = spawn({
		cmd: [cmd, ...args],
		cwd: context.repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`Command failed (${exitCode}): ${stderr || stdout}`);
	}
	return { exitCode, stdout, stderr };
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	const proc = spawn({
		cmd: ["git", ...args],
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
	}
	return { stdout, stderr };
}

async function persistRun(context: WorkspaceContext, run: WorkspaceRunRecord, output: unknown): Promise<void> {
	await ensureStateDirs(context);
	if (run.outputPath) {
		await writeFile(run.outputPath, `${JSON.stringify(output, null, 2)}\n`);
	}
	await writeFile(path.join(context.stateRoot, "runs", `${run.id}.json`), `${JSON.stringify(run, null, 2)}\n`);
	await writeHealth(context, run);
}

async function writeHealth(context: WorkspaceContext, run: WorkspaceRunRecord): Promise<void> {
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

async function readRuns(context: WorkspaceContext): Promise<WorkspaceRunRecord[]> {
	const dir = path.join(context.stateRoot, "runs");
	try {
		const entries = await readdir(dir);
		const runs: WorkspaceRunRecord[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) {
				continue;
			}
			try {
				const parsed = JSON.parse(await readFile(path.join(dir, entry), "utf8")) as WorkspaceRunRecord;
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

function dueTasks(tasks: WorkspaceTask[], runs: WorkspaceRunRecord[], now: Date): WorkspaceTask[] {
	return tasks.filter((task) => {
		if (!task.enabled) {
			return false;
		}
		if (!task.schedule) {
			return false;
		}
		return isScheduleDue(task.schedule, now) && !hasRunForDate(task.id, runs, now);
	});
}

function isScheduleDue(schedule: string, now: Date): boolean {
	const parts = schedule.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(`Invalid workspace task schedule: ${schedule}`);
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

function hasRunForDate(taskId: string, runs: WorkspaceRunRecord[], now: Date): boolean {
	const today = now.toISOString().slice(0, 10);
	return runs.some((run) => run.taskId === taskId && run.startedAt.startsWith(today));
}

function countFailingTasks(tasks: WorkspaceTask[], runs: WorkspaceRunRecord[]): number {
	return tasks.filter((task) => consecutiveFailures(task.id, runs) > 0).length;
}

function workspaceDoctorErrors(context: WorkspaceContext): string[] {
	if (
		context.mode === "actions" &&
		path.resolve(context.runtimeCodexHome) !== path.resolve(context.workspaceCodexHome)
	) {
		return [
			`Actions mode must use repo .codex as CODEX_HOME; got ${context.runtimeCodexHome}`,
		];
	}
	return [];
}

function consecutiveFailures(taskId: string, runs: WorkspaceRunRecord[]): number {
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
	context: WorkspaceContext,
	id: string,
	taskId: string,
	kind: WorkspaceRunRecord["kind"],
	startedAt: string,
	status: WorkspaceRunRecord["status"],
	outputPath?: string,
	error?: string,
): WorkspaceRunRecord {
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

async function ensureStateDirs(context: WorkspaceContext): Promise<void> {
	for (const name of ["state", "runs", "outputs", "health"]) {
		await mkdir(path.join(context.stateRoot, name), { recursive: true });
	}
}

async function writeScaffoldFile(
	workspaceRoot: string,
	relativePath: string,
	content: string,
	overwrite: boolean,
): Promise<ScaffoldActionsWorkspaceResult["files"][number]> {
	const file = path.join(workspaceRoot, relativePath);
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
	workspaceRoot: string,
	entries: string[],
): Promise<ScaffoldActionsWorkspaceResult["files"][number]> {
	const file = path.join(workspaceRoot, ".gitignore");
	let current = "";
	try {
		current = await readFile(file, "utf8");
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") {
			throw error;
		}
	}
	const lines = new Set(current.split(/\r?\n/).filter(Boolean));
	const missing = entries.filter((entry) => !lines.has(entry));
	if (missing.length === 0) {
		return { path: file, action: current ? "unchanged" : "created" };
	}
	await mkdir(path.dirname(file), { recursive: true });
	const prefix = current && !current.endsWith("\n") ? "\n" : "";
	const separator = current && !current.endsWith("\n\n") ? "\n" : "";
	await writeFile(file, `${current}${prefix}${separator}${missing.join("\n")}\n`);
	return { path: file, action: current ? "updated" : "created" };
}

function workspaceTomlTemplate(
	workspaceRoot: string,
	options: ScaffoldActionsWorkspaceOptions,
): string {
	const lines = [
		"[workspace]",
		`name = ${tomlString(path.basename(workspaceRoot))}`,
		"",
	];
	if (options.withSmoke) {
		lines.push(
			"[[workspace.tasks]]",
			'id = "actions-smoke"',
			"enabled = true",
			'kind = "flow"',
			'flow = "workspace.smoke"',
			"",
			"[workspace.tasks.event]",
			'type = "workspace.smoke"',
			"",
		);
	}
	if (options.withAgentTurn) {
		lines.push(
			"[[workspace.tasks]]",
			'id = "actions-agent-turn"',
			"enabled = true",
			'kind = "flow"',
			'flow = "workspace.agent_turn"',
			"",
			"[workspace.tasks.event]",
			'type = "workspace.agent_turn"',
			"",
		);
	}
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
	const setupBun = provider === "github" ? "oven-sh/setup-bun@v2" : "oven-sh/setup-bun@v2";
	return [
		"name: Codex Flows Actions",
		"",
		"on:",
		"  workflow_dispatch:",
		"  schedule:",
		"    - cron: '0 * * * *'",
		"",
		"jobs:",
		"  workspace:",
		"    runs-on: ubuntu-latest",
		"    permissions:",
		"      contents: write",
		"    steps:",
		`      - uses: ${checkout}`,
		`      - uses: ${setupBun}`,
		"      - run: bunx @peezy.tech/codex-flows actions prepare-auth",
		"        env:",
		"          CODEX_AUTH_JSON_B64: ${{ secrets.CODEX_AUTH_JSON_B64 }}",
		"          CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}",
		"          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}",
		"      - run: bunx @peezy.tech/codex-flows workspace tick --mode actions",
		"      - if: always()",
		"        run: bunx @peezy.tech/codex-flows actions cleanup",
		"      - if: always()",
		"        run: |",
		"          git add .codex/memories .codex/workspace/actions",
		"          git diff --cached --quiet && exit 0",
		"          git config user.name codex-flows-actions",
		"          git config user.email codex-flows-actions@users.noreply.github.com",
		"          git commit -m \"Update Codex workspace state\"",
		"          git push",
		"",
	].join("\n");
}

function smokeFlowToml(): string {
	return [
		'name = "actions-smoke"',
		"version = 1",
		'description = "Verify file-backed Actions flow dispatch."',
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
	].join("\n");
}

function smokeFlowScript(): string {
	return [
		"const context = JSON.parse(await Bun.stdin.text());",
		"console.log('FLOW_RESULT ' + JSON.stringify({",
		"  status: 'completed',",
		"  message: 'actions smoke completed',",
		"  artifacts: {",
		"    eventId: context.runtime.eventId,",
		"    codexHome: process.env.CODEX_HOME,",
		"    workspaceMode: process.env.CODEX_WORKSPACE_MODE,",
		"  },",
		"}));",
		"",
	].join("\n");
}

function agentTurnFlowToml(): string {
	return [
		'name = "actions-agent-turn"',
		"version = 1",
		'description = "Run one Codex agent turn from a Bun flow step."',
		"",
		"[[steps]]",
		'name = "agent-turn"',
		'runner = "bun"',
		'script = "exec/agent-turn.ts"',
		"cwd = \"../../..\"",
		"timeout_ms = 900000",
		"",
		"[steps.trigger]",
		'type = "workspace.agent_turn"',
		"",
	].join("\n");
}

function agentTurnFlowScript(): string {
	return [
		'import { readFlowContext } from "@peezy.tech/codex-flows/flow-runtime/bun";',
		'import { runCodexAgentTurnFromFlow } from "@peezy.tech/codex-flows/flows";',
		"",
		"const context = await readFlowContext();",
		"const result = await runCodexAgentTurnFromFlow(context, {",
		"  cwd: process.cwd(),",
		"  prompt: 'Run the configured workspace agent task and summarize the result.',",
		"  approvalPolicy: 'never',",
		"  sandbox: 'danger-full-access',",
		"  wait: { timeoutMs: 900000, throwOnFailure: true },",
		"  exportThreadJson: '.codex/workspace/actions/agent-turn-thread.json',",
		"});",
		"console.log('FLOW_RESULT ' + JSON.stringify({",
		"  status: 'completed',",
		"  message: 'agent turn completed',",
		"  artifacts: result.artifacts,",
		"}));",
		"",
	].join("\n");
}

function actionsGitignoreEntries(): string[] {
	return [
		".codex/auth.json",
		".codex/install_id",
		".codex/install-id",
		".codex/installation_id",
		".codex/sessions/",
		".codex/shell_snapshots/",
		".codex/shell-snapshots/",
		".codex/tmp/",
		".codex/temp/",
		".codex/workspace/local/",
		".codex/**/*.sqlite",
		".codex/**/*.sqlite3",
		".codex/**/*.db",
	];
}

function parseSurface(input: unknown): WorkspaceSurface {
	if (!isRecord(input)) {
		throw new Error("workspace.surfaces entries must be tables");
	}
	return {
		key: requiredString(input.key, "workspace surface key"),
		kind: stringValue(input.kind, "discord"),
		homeChannelId: optionalString(input.home_channel_id),
		workspaceForumChannelId: optionalString(input.workspace_forum_channel_id),
		taskThreadsChannelId: optionalString(input.task_threads_channel_id),
	};
}

function parseTask(input: unknown): WorkspaceTask {
	if (!isRecord(input)) {
		throw new Error("workspace.tasks entries must be tables");
	}
	const id = requiredTaskId(input.id);
	const enabled = input.enabled === undefined ? true : booleanValue(input.enabled, `workspace task ${id} enabled`);
	const kind = requiredString(input.kind, `workspace task ${id} kind`);
	const schedule = optionalString(input.schedule);
	if (schedule) {
		isScheduleDue(schedule, new Date());
	}
	if (kind === "skill") {
		return { id, enabled, kind, skill: requiredString(input.skill, `workspace task ${id} skill`), schedule, var: optionalString(input.var) };
	}
	if (kind === "flow") {
		return { id, enabled, kind, flow: requiredString(input.flow, `workspace task ${id} flow`), schedule, event: isRecord(input.event) ? input.event : undefined };
	}
	if (kind === "command") {
		if (!Array.isArray(input.command) || !input.command.every((item) => typeof item === "string")) {
			throw new Error(`workspace task ${id} command must be an array of strings`);
		}
		return { id, enabled, kind, command: input.command, schedule };
	}
	throw new Error(`Invalid workspace task kind for ${id}: ${kind}`);
}

function parseReactiveRule(input: unknown): WorkspaceReactiveRule {
	if (!isRecord(input)) {
		throw new Error("workspace.reactive entries must be tables");
	}
	const id = requiredTaskId(input.id);
	const kind = requiredString(input.kind, `workspace reactive ${id} kind`);
	if (kind !== "skill") {
		throw new Error(`Invalid workspace reactive kind for ${id}: ${kind}`);
	}
	return {
		id,
		enabled: input.enabled === undefined ? true : booleanValue(input.enabled, `workspace reactive ${id} enabled`),
		task: requiredString(input.task, `workspace reactive ${id} task`),
		consecutiveFailuresGte: positiveInteger(input.consecutive_failures_gte, `workspace reactive ${id} consecutive_failures_gte`),
		kind,
		skill: requiredString(input.skill, `workspace reactive ${id} skill`),
	};
}

function requiredTaskId(value: unknown): string {
	const id = requiredString(value, "workspace task id");
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) {
		throw new Error(`Invalid workspace task id: ${id}`);
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

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function booleanValue(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a boolean`);
	}
	return value;
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
