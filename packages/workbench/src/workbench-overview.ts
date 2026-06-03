import path from "node:path";
import { spawn } from "node:child_process";
import type { ToyboxMethodHandler } from "@codex-toys/toybox";
import type { ToyboxMethodMetadata } from "@codex-toys/toybox";
import {
	collectFetchInfo,
	type FetchInfo,
	type FetchThreadSummary,
	type FetchThreadsInfo,
	type FetchToyboxInfo,
} from "./fetch.ts";
import {
	collectWorkbenchDoctorInfo,
	createWorkbenchContext,
	listDeferredRunIntents,
	parseMode,
	readDeferredRun,
	type DeferredRunAttempt,
	type DeferredRunAttemptOutput,
	type DeferredRunIntent,
	type DeferredRunIntentStatus,
	type WorkbenchDoctorInfo,
	type WorkbenchModeInput,
} from "./workbench-runtime.ts";
import {
	listWorkflows,
	type LoadedWorkflow,
} from "./workflow.ts";
import {
	WorkbenchFunctionRuntime,
	type WorkbenchFunctionMetadata,
} from "./functions.ts";

export const WORKBENCH_OVERVIEW_METHOD = "workbench.overview";

const DEFAULT_INTENT_LIMIT = 10;
const DEFAULT_THREAD_LIMIT = 10;
const DEFAULT_OUTPUT_CHARS = 600;
const COMMAND_TIMEOUT_MS = 1_500;

export type WorkbenchOverviewParams = {
	mode?: WorkbenchModeInput;
	workbenchRoot?: string;
	limits?: {
		intents?: number;
		threads?: number;
		outputChars?: number;
	};
};

export type WorkbenchOverview = {
	ok: boolean;
	generatedAt: string;
	workbench: {
		cwd: string;
		repoRoot: string;
		mode: string;
		requestedMode: string;
		config: {
			path: string;
			exists: boolean;
			ok: boolean;
			error?: string;
		};
		runtimeCodexHome: string;
		workbenchCodexHome: string;
		stateRoot: string;
	};
	fetch: Pick<
		FetchInfo,
		| "package"
		| "version"
		| "runtime"
		| "node"
		| "platform"
		| "arch"
		| "shell"
		| "cwd"
		| "codexCommand"
		| "toyboxUrl"
		| "codexHome"
	> & {
		workbench?: WorkbenchDoctorInfo;
		toybox: FetchToyboxInfo;
	};
	health: {
		ok: boolean;
		checks: WorkbenchOverviewHealthCheck[];
	};
	deferred: {
		ok: boolean;
		summary: DeferredRunSummary;
		intents: DeferredRunIntentSummary[];
		latest?: LatestDeferredRunSummary;
		error?: string;
	};
	workflows: {
		ok: boolean;
		total: number;
		workflows: WorkbenchWorkflowSummary[];
		error?: string;
	};
	functions: {
		ok: boolean;
		total: number;
		functions: WorkbenchFunctionMetadata[];
		error?: string;
	};
	threads: (FetchThreadsInfo & {
		ok: boolean;
		error?: string;
	});
	git: WorkbenchGitSummary;
};

export type WorkbenchOverviewHealthCheck = {
	name: "node" | "codex-toys" | "codex" | "toybox" | "app-server" | "workbench-config";
	ok: boolean;
	status: "ok" | "warning" | "unavailable" | "error";
	detail?: string;
	error?: string;
};

export type DeferredRunSummary = {
	total: number;
	pending: number;
	running: number;
	completed: number;
	failed: number;
	canceled: number;
	due: number;
};

export type DeferredRunIntentSummary = {
	id: string;
	status: DeferredRunIntentStatus;
	mode: string;
	runAt: string;
	createdAt: string;
	updatedAt: string;
	target: string;
	attempts: number;
	error?: string;
};

export type LatestDeferredRunSummary = DeferredRunIntentSummary & {
	attempt?: {
		id: string;
		status: string;
		startedAt: string;
		finishedAt?: string;
		outputPath?: string;
		error?: string;
	};
	output?: {
		attemptId: string;
		outputPath: string;
		kind: "missing" | "error" | "json";
		keys?: string[];
		workbenchRun?: {
			id?: string;
			taskId?: string;
			status?: string;
			startedAt?: string;
			finishedAt?: string;
			error?: string;
		};
		preview?: string;
		error?: string;
	};
};

export type WorkbenchWorkflowSummary = {
	name: string;
	description?: string;
	manifestPath: string;
	scriptPath: string;
	cwd?: string;
	skills?: string[];
};

export type WorkbenchGitSummary = {
	ok: boolean;
	isRepo: boolean;
	root?: string;
	branch?: string;
	commit?: string;
	dirty?: boolean;
	ahead?: number;
	behind?: number;
	changedFiles?: number;
	error?: string;
};

export type WorkbenchOverviewRuntimeOptions = {
	workbenchRoot?: string;
	mode?: WorkbenchModeInput;
	env?: Record<string, string | undefined>;
	appRequest?: (method: string, params: unknown) => Promise<unknown>;
	toybox?: FetchToyboxInfo;
	toyboxStatus?: unknown;
	toyboxUrl?: string;
	now?: () => Date;
};

export const workbenchOverviewMethodMetadata: ToyboxMethodMetadata[] = [
	{
		name: WORKBENCH_OVERVIEW_METHOD,
		description: "Read a bounded dashboard-friendly summary for the current workbench.",
		sideEffects: "read-only",
		category: "workbench",
	},
];

export function createWorkbenchOverviewMethods(
	options: WorkbenchOverviewRuntimeOptions = {},
): Record<string, ToyboxMethodHandler> {
	return {
		[WORKBENCH_OVERVIEW_METHOD]: async (params) => {
			const input = overviewParams(params);
			return await collectWorkbenchOverview({
				...options,
				workbenchRoot: input.workbenchRoot ?? options.workbenchRoot,
				mode: input.mode ?? options.mode,
			}, input);
		},
	};
}

export async function collectWorkbenchOverview(
	options: WorkbenchOverviewRuntimeOptions = {},
	params: WorkbenchOverviewParams = {},
): Promise<WorkbenchOverview> {
	const now = options.now?.() ?? new Date();
	const limits = normalizedLimits(params.limits);
	const context = await createWorkbenchContext({
		workbenchRoot: params.workbenchRoot ?? options.workbenchRoot,
		mode: params.mode ?? options.mode,
		env: options.env,
	});
	const cwd = context.repoRoot;
	const toybox = options.toybox ?? {
		transport: "local",
		status: options.appRequest ? "connected" : "unavailable",
		url: options.toyboxUrl ?? "toybox://local",
		error: options.appRequest ? undefined : "No toybox request surface was provided",
	} satisfies FetchToyboxInfo;

	const [
		fetch,
		deferred,
		workflows,
		functions,
		threads,
		git,
		codex,
	] = await Promise.all([
		collectOverviewFetch(cwd, toybox, options),
		collectDeferred(context, now, limits.intents, limits.outputChars),
		collectWorkflows(cwd),
		collectFunctions(cwd),
		collectThreads(cwd, limits.threads, options.appRequest),
		collectGit(cwd),
		commandVersion(options.env?.CODEX_APP_SERVER_CODEX_COMMAND ?? "codex", ["--version"]),
	]);

	const workbenchConfigError = fetch.workbench?.errors?.[0];
	const checks: WorkbenchOverviewHealthCheck[] = [
		{
			name: "node",
			ok: true,
			status: "ok",
			detail: process.version,
		},
		{
			name: "codex-toys",
			ok: true,
			status: "ok",
			detail: `${fetch.package}@${fetch.version}`,
		},
		codex.ok
			? {
					name: "codex",
					ok: true,
					status: "ok",
					detail: codex.output,
				}
			: {
					name: "codex",
					ok: false,
					status: "unavailable",
					error: codex.error,
				},
		{
			name: "toybox",
			ok: toybox.status === "connected",
			status: toybox.status === "connected" ? "ok" : "unavailable",
			detail: toybox.status === "connected"
				? `${toybox.transport}${toybox.server ? ` ${toybox.server.name}@${toybox.server.version}` : ""}`
				: undefined,
			error: toybox.error,
		},
		{
			name: "app-server",
			ok: threads.ok,
			status: threads.ok ? "ok" : "unavailable",
			detail: threads.ok ? `${threads.total} recent cwd threads` : undefined,
			error: threads.error,
		},
		{
			name: "workbench-config",
			ok: Boolean(fetch.workbench?.configExists) && !workbenchConfigError,
			status: !fetch.workbench?.configExists
				? "warning"
				: workbenchConfigError ? "error" : "ok",
			detail: fetch.workbench?.configPath,
			error: workbenchConfigError,
		},
	];

	const ok = checks.every((check) => check.ok || check.status === "warning") &&
		deferred.ok &&
		workflows.ok &&
		functions.ok &&
		git.ok;

	return {
		ok,
		generatedAt: now.toISOString(),
		workbench: {
			cwd,
			repoRoot: context.repoRoot,
			mode: context.mode,
			requestedMode: context.requestedMode,
			config: {
				path: context.configPath,
				exists: fetch.workbench?.configExists ?? false,
				ok: Boolean(fetch.workbench?.configExists) && !workbenchConfigError,
				...(workbenchConfigError ? { error: workbenchConfigError } : {}),
			},
			runtimeCodexHome: context.runtimeCodexHome,
			workbenchCodexHome: context.workbenchCodexHome,
			stateRoot: context.stateRoot,
		},
		fetch,
		health: {
			ok: checks.every((check) => check.ok || check.status === "warning"),
			checks,
		},
		deferred,
		workflows,
		functions,
		threads,
		git,
	};
}

async function collectOverviewFetch(
	cwd: string,
	toybox: FetchToyboxInfo,
	options: WorkbenchOverviewRuntimeOptions,
): Promise<WorkbenchOverview["fetch"]> {
	const info = await collectFetchInfo({
		cwd,
		appUrl: options.toyboxUrl ?? "toybox://local",
		workbenchUrl: options.toyboxUrl ?? "toybox://local",
		toybox,
		env: options.env,
	});
	return {
		package: info.package,
		version: info.version,
		runtime: info.runtime,
		node: info.node,
		platform: info.platform,
		arch: info.arch,
		...(info.shell ? { shell: info.shell } : {}),
		cwd: info.cwd,
		codexCommand: info.codexCommand,
		toyboxUrl: info.toyboxUrl,
		codexHome: info.codexHome,
		...(info.workbench ? { workbench: info.workbench } : {}),
		toybox: info.toybox,
	};
}

async function collectDeferred(
	context: Awaited<ReturnType<typeof createWorkbenchContext>>,
	now: Date,
	limit: number,
	outputChars: number,
): Promise<WorkbenchOverview["deferred"]> {
	try {
		const intents = await listDeferredRunIntents(context);
		const latest = intents
			.toSorted((left, right) => bFirst(left.updatedAt, right.updatedAt))
			[0];
		const latestRead = latest
			? await readDeferredRun(context, latest.id, { includeOutput: true }).catch(() => undefined)
			: undefined;
		return {
			ok: true,
			summary: summarizeDeferred(intents, now),
			intents: intents
				.toSorted((left, right) => bFirst(left.updatedAt, right.updatedAt))
				.slice(0, limit)
				.map(summarizeIntent),
			...(latest ? {
				latest: summarizeLatestDeferred(
					latest,
					latestRead?.attempts ?? [],
					latestRead?.outputs ?? [],
					outputChars,
				),
			} : {}),
		};
	} catch (error) {
		return {
			ok: false,
			summary: {
				total: 0,
				pending: 0,
				running: 0,
				completed: 0,
				failed: 0,
				canceled: 0,
				due: 0,
			},
			intents: [],
			error: errorMessage(error),
		};
	}
}

function summarizeDeferred(
	intents: DeferredRunIntent[],
	now: Date,
): DeferredRunSummary {
	const summary: DeferredRunSummary = {
		total: intents.length,
		pending: 0,
		running: 0,
		completed: 0,
		failed: 0,
		canceled: 0,
		due: 0,
	};
	for (const intent of intents) {
		summary[intent.status] += 1;
		if (
			(intent.status === "pending" || intent.status === "running") &&
			new Date(intent.runAt).getTime() <= now.getTime()
		) {
			summary.due += 1;
		}
	}
	return summary;
}

function summarizeIntent(intent: DeferredRunIntent): DeferredRunIntentSummary {
	return {
		id: intent.id,
		status: intent.status,
		mode: intent.mode,
		runAt: intent.runAt,
		createdAt: intent.createdAt,
		updatedAt: intent.updatedAt,
		target: targetLabel(intent.target),
		attempts: intent.attemptIds.length,
		...(intent.error ? { error: intent.error } : {}),
	};
}

function summarizeLatestDeferred(
	intent: DeferredRunIntent,
	attempts: DeferredRunAttempt[],
	outputs: DeferredRunAttemptOutput[],
	outputChars: number,
): LatestDeferredRunSummary {
	const latestAttempt = attempts
		.toSorted((left, right) => bFirst(left.startedAt, right.startedAt))
		[0];
	const latestOutput = latestAttempt
		? outputs.find((output) => output.attemptId === latestAttempt.id) ?? outputs.at(-1)
		: outputs.at(-1);
	return {
		...summarizeIntent(intent),
		...(latestAttempt ? {
			attempt: {
				id: latestAttempt.id,
				status: latestAttempt.status,
				startedAt: latestAttempt.startedAt,
				...(latestAttempt.finishedAt ? { finishedAt: latestAttempt.finishedAt } : {}),
				...(latestAttempt.outputPath ? { outputPath: latestAttempt.outputPath } : {}),
				...(latestAttempt.error ? { error: latestAttempt.error } : {}),
			},
		} : {}),
		...(latestOutput ? { output: summarizeOutput(latestOutput, outputChars) } : {}),
	};
}

function summarizeOutput(
	output: DeferredRunAttemptOutput,
	outputChars: number,
): LatestDeferredRunSummary["output"] {
	if (output.error) {
		return {
			attemptId: output.attemptId,
			outputPath: output.outputPath,
			kind: "error",
			error: output.error,
		};
	}
	const value = output.output;
	const input = record(value);
	const workbenchRun = record(input.workbenchRun);
	const text = previewJson(value, outputChars);
	return {
		attemptId: output.attemptId,
		outputPath: output.outputPath,
		kind: value === undefined ? "missing" : "json",
		...(Object.keys(input).length > 0 ? { keys: Object.keys(input).slice(0, 12) } : {}),
		...(Object.keys(workbenchRun).length > 0 ? {
			workbenchRun: {
				...(stringValue(workbenchRun.id) ? { id: stringValue(workbenchRun.id) } : {}),
				...(stringValue(workbenchRun.taskId) ? { taskId: stringValue(workbenchRun.taskId) } : {}),
				...(stringValue(workbenchRun.status) ? { status: stringValue(workbenchRun.status) } : {}),
				...(stringValue(workbenchRun.startedAt) ? { startedAt: stringValue(workbenchRun.startedAt) } : {}),
				...(stringValue(workbenchRun.finishedAt) ? { finishedAt: stringValue(workbenchRun.finishedAt) } : {}),
				...(stringValue(workbenchRun.error) ? { error: stringValue(workbenchRun.error) } : {}),
			},
		} : {}),
		...(text ? { preview: text } : {}),
	};
}

async function collectWorkflows(cwd: string): Promise<WorkbenchOverview["workflows"]> {
	try {
		const workflows = await listWorkflows({ cwd });
		return {
			ok: true,
			total: workflows.length,
			workflows: workflows.map(summarizeWorkflow),
		};
	} catch (error) {
		return {
			ok: false,
			total: 0,
			workflows: [],
			error: errorMessage(error),
		};
	}
}

function summarizeWorkflow(workflow: LoadedWorkflow): WorkbenchWorkflowSummary {
	return {
		name: workflow.name,
		...(workflow.manifest.description ? { description: workflow.manifest.description } : {}),
		manifestPath: workflow.manifestPath,
		scriptPath: workflow.scriptPath,
		...(workflow.cwd ? { cwd: workflow.cwd } : {}),
		...(workflow.skills?.length ? { skills: workflow.skills } : {}),
	};
}

async function collectFunctions(cwd: string): Promise<WorkbenchOverview["functions"]> {
	try {
		const response = await new WorkbenchFunctionRuntime({ cwd }).list();
		return {
			ok: true,
			total: response.functions.length,
			functions: response.functions,
		};
	} catch (error) {
		return {
			ok: false,
			total: 0,
			functions: [],
			error: errorMessage(error),
		};
	}
}

async function collectThreads(
	cwd: string,
	limit: number,
	appRequest: WorkbenchOverviewRuntimeOptions["appRequest"],
): Promise<WorkbenchOverview["threads"]> {
	if (!appRequest) {
		return {
			ok: false,
			total: 0,
			active: 0,
			idle: 0,
			other: 0,
			latest: [],
			error: "No app-server request surface was provided",
		};
	}
	try {
		const response = await appRequest("thread/list", {
			limit,
			sortKey: "updated_at",
			sortDirection: "desc",
			archived: false,
			cwd,
			useStateDbOnly: true,
		});
		const summarized = summarizeThreads(response);
		return {
			ok: true,
			...summarized,
		};
	} catch (error) {
		return {
			ok: false,
			total: 0,
			active: 0,
			idle: 0,
			other: 0,
			latest: [],
			error: errorMessage(error),
		};
	}
}

function summarizeThreads(value: unknown): FetchThreadsInfo {
	const threads = arrayValue(record(value).data);
	let active = 0;
	let idle = 0;
	let other = 0;
	const latest: FetchThreadSummary[] = [];
	for (const thread of threads) {
		const input = record(thread);
		const status = stringValue(record(input.status).type) ?? "unknown";
		if (status === "active") {
			active += 1;
		} else if (status === "idle" || status === "notLoaded") {
			idle += 1;
		} else {
			other += 1;
		}
		const id = stringValue(input.id) ?? "unknown";
		latest.push({
			id,
			label: threadLabel(input),
			status,
			...(stringValue(input.cwd) ? { cwd: stringValue(input.cwd) } : {}),
			...(typeof input.updatedAt === "number"
				? { updatedAt: new Date(input.updatedAt * 1000).toISOString() }
				: {}),
		});
	}
	return {
		total: threads.length,
		active,
		idle,
		other,
		latest,
	};
}

async function collectGit(cwd: string): Promise<WorkbenchGitSummary> {
	const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (!inside.ok) {
		return {
			ok: false,
			isRepo: false,
			error: inside.error,
		};
	}
	if (inside.output.trim() !== "true") {
		return {
			ok: true,
			isRepo: false,
		};
	}
	const [root, branch, commit, status, counts] = await Promise.all([
		git(cwd, ["rev-parse", "--show-toplevel"]),
		git(cwd, ["branch", "--show-current"]),
		git(cwd, ["rev-parse", "--short", "HEAD"]),
		git(cwd, ["status", "--porcelain=v1"]),
		git(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
	]);
	const result: WorkbenchGitSummary = {
		ok: root.ok && branch.ok && commit.ok && status.ok,
		isRepo: true,
		...(root.ok ? { root: root.output.trim() } : {}),
		...(branch.ok ? { branch: branch.output.trim() || "detached" } : {}),
		...(commit.ok ? { commit: commit.output.trim() } : {}),
		...(status.ok ? {
			dirty: status.output.trim().length > 0,
			changedFiles: status.output.trim()
				? status.output.trim().split(/\r?\n/).length
				: 0,
		} : {}),
	};
	if (counts.ok) {
		const [ahead, behind] = counts.output.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
		if (Number.isFinite(ahead)) {
			result.ahead = ahead;
		}
		if (Number.isFinite(behind)) {
			result.behind = behind;
		}
	}
	if (!result.ok) {
		result.error = [root, branch, commit, status]
			.filter((item) => !item.ok)
			.map((item) => item.error)
			.join("; ");
	}
	return result;
}

async function git(cwd: string, args: string[]) {
	return await commandVersion("git", args, { cwd });
}

async function commandVersion(
	command: string,
	args: string[],
	options: { cwd?: string } = {},
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
	return await new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			resolve({ ok: false, error: `${command} ${args.join(" ")} timed out` });
		}, COMMAND_TIMEOUT_MS);
		proc.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		proc.on("error", (error) => {
			clearTimeout(timer);
			resolve({ ok: false, error: error.message });
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve({ ok: true, output: (stdout || stderr).trim() });
				return;
			}
			resolve({
				ok: false,
				error: (stderr || stdout || `${command} ${args.join(" ")} exited ${code}`).trim(),
			});
		});
	});
}

function overviewParams(value: unknown): WorkbenchOverviewParams {
	const input = record(value);
	return {
		...(modeValue(input.mode) ? { mode: modeValue(input.mode) } : {}),
		...(stringValue(input.workbenchRoot) ? { workbenchRoot: stringValue(input.workbenchRoot) } : {}),
		...(isRecord(input.limits) ? {
			limits: {
				...(positiveIntegerValue(input.limits.intents) ? { intents: positiveIntegerValue(input.limits.intents) } : {}),
				...(positiveIntegerValue(input.limits.threads) ? { threads: positiveIntegerValue(input.limits.threads) } : {}),
				...(positiveIntegerValue(input.limits.outputChars) ? { outputChars: positiveIntegerValue(input.limits.outputChars) } : {}),
			},
		} : {}),
	};
}

function normalizedLimits(limits: WorkbenchOverviewParams["limits"]): {
	intents: number;
	threads: number;
	outputChars: number;
} {
	return {
		intents: clamp(limits?.intents ?? DEFAULT_INTENT_LIMIT, 1, 50),
		threads: clamp(limits?.threads ?? DEFAULT_THREAD_LIMIT, 1, 50),
		outputChars: clamp(limits?.outputChars ?? DEFAULT_OUTPUT_CHARS, 80, 4_000),
	};
}

function modeValue(value: unknown): WorkbenchModeInput | undefined {
	return typeof value === "string" && value.length > 0 ? parseMode(value) : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function bFirst(left: string, right: string): number {
	return right.localeCompare(left);
}

function targetLabel(target: DeferredRunIntent["target"]): string {
	if (target.kind === "workbench-task") {
		return `workbench-task:${target.taskId}`;
	}
	if (target.kind === "workflow") {
		return `workflow:${target.workflow}`;
	}
	return "turn";
}

function threadLabel(thread: Record<string, unknown>): string {
	const name = stringValue(thread.name);
	if (name) {
		return truncate(name, 80);
	}
	const preview = stringValue(thread.preview);
	if (preview) {
		return truncate(preview.replace(/\s+/g, " "), 80);
	}
	return "untitled";
}

function previewJson(value: unknown, maxLength: number): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return truncate(text.replace(/\s+/g, " "), maxLength);
}

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
