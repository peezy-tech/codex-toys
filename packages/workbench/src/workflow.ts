import { spawn, type Serializable } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { v2 } from "@codex-toys/bridge/generated";
import { codexThreadUrl } from "@codex-toys/bridge";
import type { ReasoningEffort } from "@codex-toys/bridge/generated/ReasoningEffort";
import { parseJsonText } from "@codex-toys/bridge/json";

const MODULE_RESULT_PREFIX = "WORKFLOW_MODULE_RESULT ";
const DEFAULT_TURN_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TURN_WAIT_POLL_INTERVAL_MS = 1000;
const FAILURE_OUTPUT_PREVIEW_CHARS = 4000;

export type WorkflowContext = {
	workflow: {
		sourceKind: "saved" | "scriptPath" | "inline";
		scriptPath?: string;
		name?: string;
		manifestPath?: string;
		config?: Record<string, unknown>;
	};
	runtime: {
		startedAt: string;
	};
	event?: unknown;
	prompt?: string;
	cwd?: string;
	workbenchRoot?: string;
};

export type WorkflowTurnStartParams = {
	prompt: string;
	threadId?: string;
	cwd?: string;
	model?: string;
	serviceTier?: string;
	effort?: ReasoningEffort;
	sandbox?: v2.SandboxMode;
	approvalPolicy?: v2.AskForApproval;
	permissions?: string;
	responsesapiClientMetadata?: Record<string, string>;
	outputSchema?: unknown;
	skills?: string[];
};

export type WorkflowProgramResult = Record<string, unknown>;

export type WorkflowResult = WorkflowProgramResult;

export type ParsedWorkflowResult = {
	result: WorkflowResult;
};

export type WorkflowRun = {
	context: WorkflowContext;
	result: WorkflowResult;
	stdout: string;
	stderr: string;
};

export type WorkflowHostCall = {
	method: string;
	params?: unknown;
};

export type WorkflowHostHandler = (
	call: WorkflowHostCall,
) => Promise<unknown> | unknown;

export type WorkflowBackendRequest = (
	method: string,
	params: unknown,
) => Promise<unknown>;

export type RunWorkflowScriptOptions = {
	scriptPath?: string;
	script?: string;
	workflow?: LoadedWorkflow;
	event?: unknown;
	prompt?: string;
	cwd?: string;
	timeoutMs: number;
	env?: Record<string, string | undefined>;
	host?: WorkflowHostHandler;
};

export async function runWorkflowScript(
	options: RunWorkflowScriptOptions,
): Promise<WorkflowRun> {
	const source = await workflowScriptSource(options);
	try {
		const context = workflowContext({
			...options,
			scriptPath: source.contextScriptPath,
			sourceKind: source.sourceKind,
		});
		const command = nodeCommandPath(source.runtimeScriptPath);
		const subprocess = spawn(command[0] ?? process.execPath, command.slice(1), {
			cwd: options.workflow?.root ?? process.cwd(),
			env: {
				...process.env,
				...options.env,
			},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		subprocess.on("message", (message) => {
			void handleHostMessage(subprocess, options.host, message);
		});
		await sendChildMessage(subprocess, {
			type: "workflow.context",
			context,
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			subprocess.kill("SIGTERM");
		}, options.timeoutMs);
		const [stdout, stderr, exitStatus] = await Promise.all([
			collectText(subprocess.stdout),
			collectText(subprocess.stderr),
			exitStatusFor(subprocess),
		]).finally(() => clearTimeout(timer));
		if (exitStatus.code !== 0) {
			throw new Error(formatWorkflowScriptFailure({
				stdout,
				stderr,
				exitStatus,
				timedOut,
				timeoutMs: options.timeoutMs,
			}));
		}
		const parsed = parseWorkflowResult(stdout);
		return {
			context,
			...parsed,
			stdout,
			stderr,
		};
	} finally {
		if (source.tempRoot) {
			await rm(source.tempRoot, { recursive: true, force: true });
		}
	}
}

export function parseWorkflowResult(
	stdout: string,
): ParsedWorkflowResult {
	return normalizeWorkflowResult(parseModuleResult(stdout));
}

export function formatWorkflowRun(run: WorkflowRun & {
	turn?: WorkflowStartedTurn;
}): string {
	return [
		"workflow action   result",
		`result              ${previewJson(run.result)}`,
		run.turn ? `turn surface        ${run.turn.via}` : undefined,
		run.turn ? `thread id           ${run.turn.threadId}` : undefined,
		run.turn ? `open thread         [Codex](${run.turn.codexUrl})` : undefined,
		run.turn ? `turn id             ${run.turn.turnId}` : undefined,
	].filter(Boolean).join("\n") + "\n";
}

export type WorkflowStartedTurn = {
	id?: string;
	via: "workbench" | "app-server";
	threadId: string;
	codexUrl: string;
	turnId: string;
	thread: unknown;
	turn: unknown;
};

export type WorkflowTurnSnapshot = WorkflowStartedTurn & {
	status: string;
	outputText: string;
	error?: unknown;
};

export type WorkflowHostTurnStartParams =
	& Partial<Omit<WorkflowTurnStartParams, "prompt">>
	& {
		id?: string;
		prompt?: string;
	};

export type WorkflowScriptContext = WorkflowContext & {
	app: {
		call(method: string, params?: unknown): Promise<unknown>;
	};
	workbench: {
		call(method: string, params?: unknown): Promise<unknown>;
	};
	turn: {
		start(params: WorkflowHostTurnStartParams): Promise<WorkflowStartedTurn>;
		read(
			turn: Pick<WorkflowStartedTurn, "id" | "threadId" | "turnId">,
		): Promise<WorkflowTurnSnapshot>;
		wait(
			turn: Pick<WorkflowStartedTurn, "id" | "threadId" | "turnId">,
			options?: {
				timeoutMs?: number;
				pollIntervalMs?: number;
				throwOnFailure?: boolean;
			},
		): Promise<WorkflowTurnSnapshot>;
		waitAll(
			turns: Array<Pick<WorkflowStartedTurn, "id" | "threadId" | "turnId">>,
			options?: {
				timeoutMs?: number;
				pollIntervalMs?: number;
				throwOnFailure?: boolean;
			},
		): Promise<WorkflowTurnSnapshot[]>;
	};
};

export type CreateWorkflowHostOptions = {
	via: WorkflowStartedTurn["via"];
	appRequest: WorkflowBackendRequest;
	workbenchRequest?: WorkflowBackendRequest;
	defaults?: {
		prompt?: string;
		cwd?: string;
		skills?: string[];
		sandbox?: v2.SandboxMode;
		approvalPolicy?: v2.AskForApproval;
		permissions?: string;
		model?: string;
		effort?: ReasoningEffort;
	};
};

export type WorkflowManifest = {
	name?: string;
	description?: string;
	script: string;
	prompt?: string;
	promptFile?: string;
	cwd?: string;
	skills?: string[];
	timeoutMs?: number;
	config?: Record<string, unknown>;
};

export type LoadedWorkflow = {
	name: string;
	root: string;
	workbenchRoot: string;
	manifestPath: string;
	manifest: WorkflowManifest;
	scriptPath: string;
	prompt?: string;
	cwd?: string;
	skills?: string[];
	timeoutMs?: number;
};

export type WorkflowRunTarget = {
	scriptPath?: string;
	script?: string;
	workflow?: LoadedWorkflow;
	prompt?: string;
	cwd?: string;
	skills?: string[];
	timeoutMs?: number;
};

export type ListWorkflowsOptions = {
	cwd?: string;
	roots?: string[];
};

type WorkflowScriptSource = {
	runtimeScriptPath: string;
	contextScriptPath?: string;
	sourceKind: WorkflowContext["workflow"]["sourceKind"];
	tempRoot?: string;
};

async function workflowScriptSource(
	options: RunWorkflowScriptOptions,
): Promise<WorkflowScriptSource> {
	const sources = [
		options.scriptPath ? "scriptPath" : undefined,
		options.script !== undefined ? "script" : undefined,
	].filter(Boolean);
	if (sources.length !== 1) {
		throw new Error("Workflow run requires exactly one script source");
	}
	if (options.scriptPath) {
		const resolved = path.resolve(options.scriptPath);
		return {
			runtimeScriptPath: resolved,
			contextScriptPath: resolved,
			sourceKind: options.workflow ? "saved" : "scriptPath",
		};
	}
	const tempRoot = await mkdtemp(path.join(tmpdir(), "codex-toys-workflow-"));
	const runtimeScriptPath = path.join(tempRoot, "workflow.mts");
	await writeFile(runtimeScriptPath, options.script ?? "", "utf8");
	return {
		runtimeScriptPath,
		sourceKind: "inline",
		tempRoot,
	};
}

export function createWorkflowHost(
	options: CreateWorkflowHostOptions,
): WorkflowHostHandler {
	return async (call) => {
		if (call.method === "app.call") {
			const params = record(call.params);
			return await options.appRequest(
				requiredString(params.method, "ctx.app.call method"),
				params.params,
			);
		}
		if (call.method === "workbench.call") {
			if (!options.workbenchRequest) {
				throw new Error("ctx.workbench.call is only available through a codex-toys runtime");
			}
			const params = record(call.params);
			return await options.workbenchRequest(
				requiredString(params.method, "ctx.workbench.call method"),
				params.params,
			);
		}
		if (call.method === "turn.start") {
			const params = record(call.params);
			const turn = turnStartParamsFromHostParams(params, options.defaults);
			return await startWorkflowTurnWithRequest(
				options.via,
				turn,
				options.appRequest,
				optionalString(params.id),
			);
		}
		if (call.method === "turn.read") {
			return await readWorkflowTurnWithRequest(
				options.via,
				options.appRequest,
				turnRefFromValue(call.params, "ctx.turn.read"),
			);
		}
		if (call.method === "turn.wait") {
			const params = record(call.params);
			return await waitWorkflowTurnWithRequest(
				options.via,
				options.appRequest,
				turnRefFromValue(params.turn ?? call.params, "ctx.turn.wait"),
				waitOptionsFromValue(params.options),
			);
		}
		if (call.method === "turn.waitAll") {
			const params = record(call.params);
			if (!Array.isArray(params.turns)) {
				throw new Error("ctx.turn.waitAll requires an array of turns");
			}
			const waitOptions = waitOptionsFromValue(params.options);
			return await Promise.all(params.turns.map(async (entry) =>
				await waitWorkflowTurnWithRequest(
					options.via,
					options.appRequest,
					turnRefFromValue(entry, "ctx.turn.waitAll"),
					waitOptions,
				)
			));
		}
		throw new Error(`Unknown workflow host method: ${call.method}`);
	};
}

export async function startWorkflowTurnWithRequest(
	via: WorkflowStartedTurn["via"],
	turn: WorkflowTurnStartParams,
	request: WorkflowBackendRequest,
	id?: string,
): Promise<WorkflowStartedTurn> {
	validateTurnPermissionOptions(turn);
	let threadId = turn.threadId;
	let thread: unknown = null;
	const existingThread = Boolean(threadId);
	if (!threadId) {
		const threadResponse = await request(
			"thread/start",
			threadStartParamsFromWorkflow(turn),
		);
		threadId = nestedId(threadResponse, "thread", "thread/start");
		thread = record(threadResponse).thread ?? threadResponse;
	}
	const turnResponse = await request(
		"turn/start",
		turnStartParamsFromWorkflow(threadId, turn, {
			includeSandboxPolicy: existingThread,
		}),
	);
	return compactUndefined({
		id,
		via,
		threadId,
		codexUrl: codexThreadUrl(threadId),
		turnId: nestedId(turnResponse, "turn", "turn/start"),
		thread,
		turn: record(turnResponse).turn ?? turnResponse,
	});
}

export async function readWorkflowTurnWithRequest(
	via: WorkflowStartedTurn["via"],
	request: WorkflowBackendRequest,
	ref: Pick<WorkflowStartedTurn, "id" | "threadId" | "turnId">,
): Promise<WorkflowTurnSnapshot> {
	const threadResponse = await request("thread/read", {
		threadId: ref.threadId,
		includeTurns: true,
	});
	const thread = record(threadResponse).thread ?? threadResponse;
	const turn = array(record(thread).turns)
		.map(record)
		.find((candidate) => candidate.id === ref.turnId);
	if (!turn) {
		throw new Error(`thread/read did not return turn ${ref.turnId}`);
	}
	return compactUndefined({
		id: ref.id,
		via,
		threadId: ref.threadId,
		codexUrl: codexThreadUrl(ref.threadId),
		turnId: ref.turnId,
		status: optionalString(turn.status) ?? "unknown",
		outputText: finalTextFromTurn(turn),
		error: turn.error,
		thread,
		turn,
	});
}

export async function waitWorkflowTurnWithRequest(
	via: WorkflowStartedTurn["via"],
	request: WorkflowBackendRequest,
	ref: Pick<WorkflowStartedTurn, "id" | "threadId" | "turnId">,
	options: {
		timeoutMs?: number;
		pollIntervalMs?: number;
		throwOnFailure?: boolean;
	} = {},
): Promise<WorkflowTurnSnapshot> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TURN_WAIT_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_TURN_WAIT_POLL_INTERVAL_MS;
	const startedAt = Date.now();
	while (true) {
		let snapshot: WorkflowTurnSnapshot;
		try {
			snapshot = await readWorkflowTurnWithRequest(via, request, ref);
		} catch (error) {
			if (!isTransientThreadReadError(error) || Date.now() - startedAt >= timeoutMs) {
				throw error;
			}
			await delay(Math.min(pollIntervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt))));
			continue;
		}
		if (snapshot.status !== "inProgress") {
			if (
				isFailureTurnStatus(snapshot.status) &&
				options.throwOnFailure !== false
			) {
				throw new Error(workflowTurnFailureMessage(snapshot));
			}
			return snapshot;
		}
		if (Date.now() - startedAt >= timeoutMs) {
			throw new Error(`Timed out after ${timeoutMs}ms waiting for turn ${ref.turnId} on thread ${ref.threadId}`);
		}
		await delay(Math.min(pollIntervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt))));
	}
}

function isTransientThreadReadError(error: unknown): boolean {
	const message = errorMessage(error);
	return message.includes("failed to read thread") &&
		message.includes("rollout at ") &&
		message.includes(" is empty");
}

function isFailureTurnStatus(status: string): boolean {
	return status === "failed" || status === "interrupted";
}

export async function listWorkflows(
	options: ListWorkflowsOptions = {},
): Promise<LoadedWorkflow[]> {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const roots = options.roots?.map((root) => path.resolve(cwd, root)) ??
		[
			path.join(cwd, ".codex", "workflows"),
			path.join(cwd, "workflows"),
		];
	const loaded: LoadedWorkflow[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		for (const manifestPath of await workflowManifestPaths(root)) {
			const workflow = await loadWorkflowManifest(manifestPath, cwd);
			if (seen.has(workflow.name)) {
				continue;
			}
			seen.add(workflow.name);
			loaded.push(workflow);
		}
	}
	return loaded.sort((left, right) => left.name.localeCompare(right.name));
}

export async function resolveWorkflowTarget(
	target: string,
	options: ListWorkflowsOptions = {},
): Promise<WorkflowRunTarget> {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	if (target.includes("/") || target.includes("\\") || target.endsWith(".ts") || target.endsWith(".js")) {
		throw new Error(`Workflow target must be a named workflow, got ${JSON.stringify(target)}`);
	}
	const workflows = await listWorkflows({ ...options, cwd });
	const workflow = workflows.find((entry) => entry.name === target);
	if (!workflow) {
		throw new Error(`No workflow named ${JSON.stringify(target)} was found`);
	}
	return targetFromWorkflow(workflow);
}

export function formatWorkflowList(
	workflows: LoadedWorkflow[],
): string {
	if (workflows.length === 0) {
		return "No workflows found.\n";
	}
	return workflows.map((workflow) => {
		const description = workflow.manifest.description
			? ` - ${workflow.manifest.description}`
			: "";
		return `${workflow.name}${description}`;
	}).join("\n") + "\n";
}

function workflowContext(
	options: RunWorkflowScriptOptions & {
		sourceKind: WorkflowContext["workflow"]["sourceKind"];
		scriptPath?: string;
		workflow?: LoadedWorkflow;
	},
): WorkflowContext {
	return compactUndefined({
		workflow: {
			sourceKind: options.sourceKind,
			scriptPath: options.scriptPath,
			name: options.workflow?.name,
			manifestPath: options.workflow?.manifestPath,
			config: options.workflow?.manifest.config,
		},
		runtime: {
			startedAt: new Date().toISOString(),
		},
		event: options.event,
		prompt: options.prompt,
		cwd: options.cwd,
		workbenchRoot: options.workflow?.workbenchRoot,
	});
}

async function workflowManifestPaths(root: string): Promise<string[]> {
	if (!await isDirectory(root)) {
		return [];
	}
	const entries = await readdir(root, { withFileTypes: true });
	const manifests: string[] = [];
	for (const entry of entries) {
		if (entry.isDirectory()) {
			const manifestPath = path.join(root, entry.name, "workflow.json");
			if (await isFile(manifestPath)) {
				manifests.push(manifestPath);
			}
		}
	}
	return manifests.sort();
}

async function loadWorkflowManifest(
	manifestPath: string,
	workbenchRoot: string,
): Promise<LoadedWorkflow> {
	const root = path.dirname(manifestPath);
	const resolvedWorkbenchRoot = path.resolve(workbenchRoot);
	const parsed = parseJsonText(await readFile(manifestPath, "utf8"), manifestPath);
	if (!isRecord(parsed)) {
		throw new Error(`Workflow manifest must be an object: ${manifestPath}`);
	}
	const script = optionalString(parsed.script);
	if (!script) {
		throw new Error(`Workflow manifest requires script: ${manifestPath}`);
	}
	const name = optionalString(parsed.name) ?? path.basename(root);
	const manifest = compactUndefined({
		name,
		description: optionalString(parsed.description),
		script,
		prompt: optionalString(parsed.prompt),
		promptFile: optionalString(parsed.promptFile),
		cwd: optionalString(parsed.cwd),
		skills: stringArray(parsed.skills),
		timeoutMs: optionalPositiveNumber(parsed.timeoutMs, "workflow timeoutMs"),
		config: recordOrUndefined(parsed.config),
	});
	const prompt = manifest.promptFile
		? await readFile(path.resolve(root, manifest.promptFile), "utf8")
		: manifest.prompt;
	return compactUndefined({
		name,
		root,
		workbenchRoot: resolvedWorkbenchRoot,
		manifestPath,
		manifest,
		scriptPath: path.resolve(root, script),
		prompt,
		cwd: manifest.cwd ? resolveWorkflowPath({
			workflowRoot: root,
			workbenchRoot: resolvedWorkbenchRoot,
			value: manifest.cwd,
			label: "cwd",
		}) : undefined,
		skills: manifest.skills,
		timeoutMs: manifest.timeoutMs,
	});
}

function targetFromWorkflow(
	workflow: LoadedWorkflow,
): WorkflowRunTarget {
	return compactUndefined({
		scriptPath: workflow.scriptPath,
		workflow,
		prompt: workflow.prompt,
		cwd: workflow.cwd,
		skills: workflow.skills,
		timeoutMs: workflow.timeoutMs,
	});
}

async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}

async function isDirectory(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isDirectory();
	} catch {
		return false;
	}
}

function resolveWorkflowPath(options: {
	workflowRoot: string;
	workbenchRoot: string;
	value: string;
	label: string;
}): string {
	const { workflowRoot, workbenchRoot, value, label } = options;
	if (value === "@") {
		return workbenchRoot;
	}
	if (value.startsWith("@/") || value.startsWith("@\\")) {
		const resolved = path.resolve(workbenchRoot, value.slice(2));
		if (!isPathInsideOrEqual(workbenchRoot, resolved)) {
			throw new Error(`Workflow manifest ${label} must stay inside workbench root when using @/: ${value}`);
		}
		return resolved;
	}
	return path.isAbsolute(value) ? value : path.resolve(workflowRoot, value);
}

function isPathInsideOrEqual(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseModuleResult(stdout: string): unknown {
	for (const line of stdout.split(/\r?\n/).reverse()) {
		const index = line.indexOf(MODULE_RESULT_PREFIX);
		if (index === -1) {
			continue;
		}
		return parseJsonText(
			line.slice(index + MODULE_RESULT_PREFIX.length).trim(),
			"workflow module result",
		);
	}
	throw new Error("Workflow module did not return a result");
}

function normalizeWorkflowResult(value: unknown): ParsedWorkflowResult {
	if (!isRecord(value)) {
		throw new Error("Workflow result must be a JSON object");
	}
	return { result: value };
}

function turnStartParamsFromHostParams(
	params: Record<string, unknown>,
	defaults: CreateWorkflowHostOptions["defaults"] = {},
): WorkflowTurnStartParams {
	const prompt = optionalString(params.prompt) ?? defaults.prompt;
	if (!prompt) {
		throw new Error("ctx.turn.start requires a prompt or workflow prompt default");
	}
	return compactUndefined({
		prompt,
		threadId: optionalString(params.threadId),
		cwd: optionalString(params.cwd) ?? defaults.cwd,
		model: optionalString(params.model) ?? defaults.model,
		serviceTier: optionalString(params.serviceTier),
		effort: reasoningEffortValue(params.effort) ?? defaults.effort,
		sandbox: sandboxModeValue(params.sandbox) ?? defaults.sandbox,
		approvalPolicy: approvalPolicyValue(params.approvalPolicy) ??
			defaults.approvalPolicy,
		permissions: optionalString(params.permissions) ?? defaults.permissions,
		responsesapiClientMetadata: stringRecord(params.responsesapiClientMetadata),
		outputSchema: params.outputSchema,
		skills: stringArray(params.skills) ?? defaults.skills,
	});
}

function turnRefFromValue(
	value: unknown,
	label: string,
): Pick<WorkflowStartedTurn, "id" | "threadId" | "turnId"> {
	const params = record(value);
	return compactUndefined({
		id: optionalString(params.id),
		threadId: requiredString(params.threadId, `${label} threadId`),
		turnId: requiredString(params.turnId, `${label} turnId`),
	});
}

function waitOptionsFromValue(value: unknown): {
	timeoutMs?: number;
	pollIntervalMs?: number;
	throwOnFailure?: boolean;
} {
	const params = record(value);
	return compactUndefined({
		timeoutMs: optionalNumber(params.timeoutMs),
		pollIntervalMs: optionalNumber(params.pollIntervalMs),
		throwOnFailure: optionalBoolean(params.throwOnFailure),
	});
}

function threadStartParamsFromWorkflow(
	turn: WorkflowTurnStartParams,
): v2.ThreadStartParams {
	return compactUndefined({
		cwd: turn.cwd,
		model: turn.model,
		serviceTier: turn.serviceTier,
		sandbox: turn.sandbox,
		approvalPolicy: turn.approvalPolicy,
		permissions: turn.permissions,
		experimentalRawEvents: false,
	});
}

function turnStartParamsFromWorkflow(
	threadId: string,
	turn: WorkflowTurnStartParams,
	flags: {
		includeSandboxPolicy?: boolean;
	} = {},
): v2.TurnStartParams {
	return compactUndefined({
		threadId,
		input: [
				{
					type: "text",
					text: turn.prompt,
					text_elements: [],
				},
			],
		cwd: turn.cwd,
		model: turn.model,
		serviceTier: turn.serviceTier,
		effort: turn.effort,
		approvalPolicy: turn.approvalPolicy,
		sandboxPolicy: flags.includeSandboxPolicy
			? sandboxPolicyFromMode(turn.sandbox)
			: undefined,
		permissions: turn.permissions,
		responsesapiClientMetadata: turn.responsesapiClientMetadata,
		outputSchema: turn.outputSchema as v2.TurnStartParams["outputSchema"],
	});
}

function validateTurnPermissionOptions(turn: WorkflowTurnStartParams): void {
	if (turn.sandbox && turn.permissions) {
		throw new Error("ctx.turn.start cannot combine sandbox and permissions");
	}
}

function sandboxModeValue(value: unknown): v2.SandboxMode | undefined {
	if (
		value === "danger-full-access" ||
		value === "read-only" ||
		value === "workspace-write"
	) {
		return value;
	}
	if (value !== undefined) {
		throw new Error("ctx.turn.start sandbox must be danger-full-access, workspace-write, or read-only");
	}
	return undefined;
}

function approvalPolicyValue(value: unknown): v2.AskForApproval | undefined {
	if (
		value === "never" ||
		value === "on-failure" ||
		value === "on-request" ||
		value === "untrusted"
	) {
		return value;
	}
	if (value !== undefined) {
		throw new Error("ctx.turn.start approvalPolicy must be never, on-failure, on-request, or untrusted");
	}
	return undefined;
}

function reasoningEffortValue(value: unknown): ReasoningEffort | undefined {
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
		throw new Error("ctx.turn.start effort must be none, minimal, low, medium, high, or xhigh");
	}
	return undefined;
}

function sandboxPolicyFromMode(
	mode: v2.SandboxMode | undefined,
): v2.SandboxPolicy | undefined {
	if (mode === "danger-full-access") {
		return { type: "dangerFullAccess" };
	}
	if (mode === "read-only") {
		return { type: "readOnly", networkAccess: false };
	}
	if (mode === "workspace-write") {
		return {
			type: "workspaceWrite",
			writableRoots: [],
			networkAccess: false,
			excludeTmpdirEnvVar: false,
			excludeSlashTmp: false,
		};
	}
	return undefined;
}

function nestedId(response: unknown, key: string, label: string): string {
	const id = optionalString(record(record(response)[key]).id);
	if (!id) {
		throw new Error(`${label} did not return ${key}.id`);
	}
	return id;
}

function finalTextFromTurn(turn: Record<string, unknown>): string {
	const items = array(turn.items);
	const agentMessages = items
		.map(record)
		.filter((item) => item.type === "agentMessage");
	const finalMessages = agentMessages.filter((item) => item.phase === "final_answer");
	const selected = finalMessages.length > 0 ? finalMessages : agentMessages;
	return selected
		.map((item) => optionalString(item.text) ?? "")
		.filter(Boolean)
		.join("\n\n");
}

async function handleHostMessage(
	subprocess: ReturnType<typeof spawn>,
	host: WorkflowHostHandler | undefined,
	message: unknown,
): Promise<void> {
	if (!isHostRequestMessage(message)) {
		return;
	}
	try {
		if (!host) {
			throw new Error("Workflow host API is not available");
		}
		const result = await host({
			method: message.method,
			params: message.params,
		});
		await sendChildMessage(subprocess, {
			type: "workflow.hostResponse",
			id: message.id,
			result,
		}).catch(() => undefined);
	} catch (error) {
		await sendChildMessage(subprocess, {
			type: "workflow.hostResponse",
			id: message.id,
			error: {
				message: errorMessage(error),
				stack: error instanceof Error ? error.stack : undefined,
			},
		}).catch(() => undefined);
	}
}

function isHostRequestMessage(value: unknown): value is {
	type: "workflow.hostRequest";
	id: number;
	method: string;
	params?: unknown;
} {
	const message = record(value);
	return message.type === "workflow.hostRequest" &&
		typeof message.id === "number" &&
		typeof message.method === "string";
}

function sendChildMessage(
	subprocess: ReturnType<typeof spawn>,
	message: unknown,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!subprocess.connected || typeof subprocess.send !== "function") {
			reject(new Error("Workflow runner IPC channel is closed"));
			return;
		}
		subprocess.send(message as Serializable, (error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function nodeCommandPath(scriptPath: string): string[] {
	const tsxLoader = import.meta.resolve("tsx");
	return [
		nodeRuntimeCommand(),
		"--import",
		tsxLoader,
		siblingRuntimePath("workflow-module-runner"),
		scriptPath,
	];
}

function nodeRuntimeCommand(): string {
	return isBunRuntime() ? "node" : process.execPath;
}

function isBunRuntime(): boolean {
	return typeof process.versions.bun === "string";
}

function siblingRuntimePath(basename: string): string {
	const currentPath = fileURLToPath(import.meta.url);
	const extension = path.extname(currentPath) || ".ts";
	return path.join(path.dirname(currentPath), `${basename}${extension}`);
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

type WorkflowExitStatus = {
	code: number | null;
	signal: NodeJS.Signals | null;
};

function exitStatusFor(subprocess: ReturnType<typeof spawn>): Promise<WorkflowExitStatus> {
	return new Promise((resolve, reject) => {
		subprocess.once("error", reject);
		subprocess.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

function formatWorkflowScriptFailure(options: {
	stdout: string;
	stderr: string;
	exitStatus: WorkflowExitStatus;
	timedOut: boolean;
	timeoutMs: number;
}): string {
	const lines = ["Workflow script failed:"];
	if (options.timedOut) {
		lines.push(`timed out after ${options.timeoutMs}ms`);
	}
	if (options.exitStatus.signal) {
		lines.push(`terminated by signal ${options.exitStatus.signal}`);
	} else if (options.exitStatus.code !== null) {
		lines.push(`exit code ${options.exitStatus.code}`);
	} else {
		lines.push("exit status unavailable");
	}
	appendCapturedOutput(lines, "stderr", options.stderr);
	appendCapturedOutput(lines, "stdout", options.stdout);
	if (!options.stderr.trim() && !options.stdout.trim()) {
		lines.push("no stdout or stderr captured");
	}
	return lines.join("\n");
}

function workflowTurnFailureMessage(snapshot: WorkflowTurnSnapshot): string {
	const lines = [
		`Turn ${snapshot.turnId} on thread ${snapshot.threadId} ended with status ${snapshot.status}`,
		`status ${snapshot.status}`,
	];
	if (snapshot.id) {
		lines.push(`workflow turn id ${snapshot.id}`);
	}
	appendUnknownDetail(lines, "turn error", snapshot.error);
	appendCapturedOutput(lines, "turn output", snapshot.outputText);
	return lines.join("\n");
}

function appendUnknownDetail(lines: string[], label: string, value: unknown): void {
	const detail = unknownFailureDetail(value);
	if (detail) {
		lines.push(`${label}:\n${previewLong(detail)}`);
	}
}

function appendCapturedOutput(lines: string[], label: string, value: string): void {
	const output = value.trim();
	if (output) {
		lines.push(`${label}:\n${previewLong(output)}`);
	}
}

function unknownFailureDetail(value: unknown): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (value instanceof Error) {
		return value.stack ?? value.message;
	}
	if (typeof value === "string") {
		return value.length > 0 ? value : undefined;
	}
	const json = JSON.stringify(value, null, 2);
	return json && json !== "{}" ? json : undefined;
}

function previewLong(value: string): string {
	return value.length > FAILURE_OUTPUT_PREVIEW_CHARS
		? `${value.slice(0, FAILURE_OUTPUT_PREVIEW_CHARS)}\n... truncated ...`
		: value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, label: string): string {
	const result = optionalString(value);
	if (!result) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return result;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalPositiveNumber(value: unknown, label: string): number | undefined {
	const result = optionalNumber(value);
	if (result === undefined) {
		return undefined;
	}
	if (result <= 0) {
		throw new Error(`${label} must be greater than 0`);
	}
	return result;
}

function optionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
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
	const entries = value.filter((entry): entry is string =>
		typeof entry === "string" && entry.length > 0
	);
	return entries.length > 0 ? entries : undefined;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function preview(value: string): string {
	return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function previewJson(value: unknown): string {
	const json = JSON.stringify(value);
	return preview(json ?? "null");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
