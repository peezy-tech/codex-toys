import { spawn, type Serializable } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { v2 } from "@codex-toys/bridge/generated";
import type { ReasoningEffort } from "@codex-toys/bridge/generated/ReasoningEffort";
import type {
	WorkbenchDelegation,
	WorkbenchDelegationStatus,
} from "./delegation.ts";
import { parseJsonText } from "@codex-toys/bridge/json";

const MODULE_RESULT_PREFIX = "TURN_AUTOMATION_MODULE_RESULT ";
const DEFAULT_TURN_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TURN_WAIT_POLL_INTERVAL_MS = 1000;

export type TurnAutomationContext = {
	automation: {
		scriptPath: string;
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

export type TurnAutomationTurnStartParams = {
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

export type TurnAutomationProgramResult = Record<string, unknown>;

export type TurnAutomationResult = TurnAutomationProgramResult;

export type ParsedTurnAutomationResult = {
	result: TurnAutomationResult;
};

export type TurnAutomationRun = {
	context: TurnAutomationContext;
	result: TurnAutomationResult;
	stdout: string;
	stderr: string;
};

export type TurnAutomationHostCall = {
	method: string;
	params?: unknown;
};

export type TurnAutomationHostHandler = (
	call: TurnAutomationHostCall,
) => Promise<unknown> | unknown;

export type TurnAutomationBackendRequest = (
	method: string,
	params: unknown,
) => Promise<unknown>;

export type RunTurnAutomationScriptOptions = {
	scriptPath: string;
	automation?: LoadedTurnAutomation;
	event?: unknown;
	prompt?: string;
	cwd?: string;
	timeoutMs: number;
	env?: Record<string, string | undefined>;
	host?: TurnAutomationHostHandler;
};

export async function runTurnAutomationScript(
	options: RunTurnAutomationScriptOptions,
): Promise<TurnAutomationRun> {
	const scriptPath = path.resolve(options.scriptPath);
	const context = turnAutomationContext({ ...options, scriptPath });
	const command = nodeCommandPath(scriptPath);
	const subprocess = spawn(command[0] ?? process.execPath, command.slice(1), {
		cwd: options.automation?.root ?? process.cwd(),
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
		type: "turnAutomation.context",
		context,
	});
	const timer = setTimeout(() => subprocess.kill("SIGTERM"), options.timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(subprocess.stdout),
		collectText(subprocess.stderr),
		exitCodeFor(subprocess),
	]).finally(() => clearTimeout(timer));
	if (exitCode !== 0) {
		throw new Error(`Turn automation script failed:\n${stderr || stdout}`);
	}
	const parsed = parseTurnAutomationResult(stdout);
	return {
		context,
		...parsed,
		stdout,
		stderr,
	};
}

export function parseTurnAutomationResult(
	stdout: string,
): ParsedTurnAutomationResult {
	return normalizeTurnAutomationResult(parseModuleResult(stdout));
}

export function formatTurnAutomationRun(run: TurnAutomationRun & {
	turn?: TurnAutomationStartedTurn;
}): string {
	return [
		"automation action   result",
		`result              ${previewJson(run.result)}`,
		run.turn ? `turn surface        ${run.turn.via}` : undefined,
		run.turn ? `thread id           ${run.turn.threadId}` : undefined,
		run.turn ? `turn id             ${run.turn.turnId}` : undefined,
	].filter(Boolean).join("\n") + "\n";
}

export type TurnAutomationStartedTurn = {
	id?: string;
	via: "workbench" | "app-server";
	threadId: string;
	turnId: string;
	thread: unknown;
	turn: unknown;
};

export type TurnAutomationTurnSnapshot = TurnAutomationStartedTurn & {
	status: string;
	outputText: string;
	error?: unknown;
};

export type TurnAutomationStartedDelegation = {
	id?: string;
	delegation: WorkbenchDelegation;
	turnId?: string;
};

export type TurnAutomationDelegationSnapshot = TurnAutomationStartedDelegation & {
	status: WorkbenchDelegationStatus;
	latestTurnId?: string;
	latestStatus?: string;
	outputText: string;
	error?: unknown;
};

export type TurnAutomationHostTurnStartParams =
	& Partial<Omit<TurnAutomationTurnStartParams, "prompt">>
	& {
		id?: string;
		prompt?: string;
	};

export type TurnAutomationHostDelegationStartParams = {
	id?: string;
	cwd: string;
	prompt?: string;
	title?: string;
	groupId?: string;
	returnMode?: string;
	allowAbsoluteCwd?: boolean;
	model?: string;
	serviceTier?: string;
	effort?: ReasoningEffort;
	sandbox?: v2.SandboxMode;
	approvalPolicy?: v2.AskForApproval;
	permissions?: string;
};

export type TurnAutomationScriptContext = TurnAutomationContext & {
	app: {
		call(method: string, params?: unknown): Promise<unknown>;
	};
	workbench: {
		call(method: string, params?: unknown): Promise<unknown>;
	};
	turn: {
		start(params: TurnAutomationHostTurnStartParams): Promise<TurnAutomationStartedTurn>;
		read(
			turn: Pick<TurnAutomationStartedTurn, "id" | "threadId" | "turnId">,
		): Promise<TurnAutomationTurnSnapshot>;
		wait(
			turn: Pick<TurnAutomationStartedTurn, "id" | "threadId" | "turnId">,
			options?: {
				timeoutMs?: number;
				pollIntervalMs?: number;
				throwOnFailure?: boolean;
			},
		): Promise<TurnAutomationTurnSnapshot>;
		waitAll(
			turns: Array<Pick<TurnAutomationStartedTurn, "id" | "threadId" | "turnId">>,
			options?: {
				timeoutMs?: number;
				pollIntervalMs?: number;
				throwOnFailure?: boolean;
			},
		): Promise<TurnAutomationTurnSnapshot[]>;
	};
	delegate: {
		list(params?: Record<string, unknown>): Promise<unknown>;
		start(params: TurnAutomationHostDelegationStartParams): Promise<TurnAutomationStartedDelegation>;
		send(params: Record<string, unknown>): Promise<unknown>;
		read(
			delegation: Pick<TurnAutomationStartedDelegation, "id"> | Record<string, unknown>,
		): Promise<TurnAutomationDelegationSnapshot>;
		wait(
			delegation: Pick<TurnAutomationStartedDelegation, "id"> | Record<string, unknown>,
			options?: {
				timeoutMs?: number;
				pollIntervalMs?: number;
				throwOnFailure?: boolean;
			},
		): Promise<TurnAutomationDelegationSnapshot>;
	};
};

export type CreateTurnAutomationHostOptions = {
	via: TurnAutomationStartedTurn["via"];
	appRequest: TurnAutomationBackendRequest;
	workbenchRequest?: TurnAutomationBackendRequest;
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

export type TurnAutomationManifest = {
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

export type LoadedTurnAutomation = {
	name: string;
	root: string;
	workbenchRoot: string;
	manifestPath: string;
	manifest: TurnAutomationManifest;
	scriptPath: string;
	prompt?: string;
	cwd?: string;
	skills?: string[];
	timeoutMs?: number;
};

export type TurnAutomationRunTarget = {
	scriptPath: string;
	automation?: LoadedTurnAutomation;
	prompt?: string;
	cwd?: string;
	skills?: string[];
	timeoutMs?: number;
};

export type ListTurnAutomationsOptions = {
	cwd?: string;
	roots?: string[];
};

export function createTurnAutomationHost(
	options: CreateTurnAutomationHostOptions,
): TurnAutomationHostHandler {
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
				throw new Error("ctx.workbench.call is only available through a codex-toys toybox");
			}
			const params = record(call.params);
			return await options.workbenchRequest(
				requiredString(params.method, "ctx.workbench.call method"),
				params.params,
			);
		}
		if (call.method === "delegate.list") {
			return await workbenchHostRequest(options, "delegation.list", call.params ?? {});
		}
		if (call.method === "delegate.start") {
			const params = delegationStartParamsFromHostParams(
				record(call.params),
				options.defaults,
			);
			const started = await workbenchHostRequest<{
				delegation: WorkbenchDelegation;
				turnId?: string;
			}>(options, "delegation.start", params);
			return compactUndefined({
				id: optionalString(record(call.params).id),
				delegation: started.delegation,
				turnId: started.turnId,
			});
		}
		if (call.method === "delegate.send") {
			return await workbenchHostRequest(options, "delegation.send", call.params ?? {});
		}
		if (call.method === "delegate.read") {
			return await readAutomationDelegationWithRequest(
				options,
				delegationRefFromValue(call.params, "ctx.delegate.read"),
			);
		}
		if (call.method === "delegate.wait") {
			const params = record(call.params);
			return await waitAutomationDelegationWithRequest(
				options,
				delegationRefFromValue(params.delegation ?? call.params, "ctx.delegate.wait"),
				waitOptionsFromValue(params.options),
			);
		}
		if (call.method === "turn.start") {
			const params = record(call.params);
			const turn = turnStartParamsFromHostParams(params, options.defaults);
			return await startAutomationTurnWithRequest(
				options.via,
				turn,
				options.appRequest,
				optionalString(params.id),
			);
		}
		if (call.method === "turn.read") {
			return await readAutomationTurnWithRequest(
				options.via,
				options.appRequest,
				turnRefFromValue(call.params, "ctx.turn.read"),
			);
		}
		if (call.method === "turn.wait") {
			const params = record(call.params);
			return await waitAutomationTurnWithRequest(
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
				await waitAutomationTurnWithRequest(
					options.via,
					options.appRequest,
					turnRefFromValue(entry, "ctx.turn.waitAll"),
					waitOptions,
				)
			));
		}
		throw new Error(`Unknown turn automation host method: ${call.method}`);
	};
}

async function workbenchHostRequest<T = unknown>(
	options: CreateTurnAutomationHostOptions,
	method: string,
	params: unknown,
): Promise<T> {
	if (!options.workbenchRequest) {
		throw new Error("context.delegate is only available through a codex-toys toybox");
	}
	return await options.workbenchRequest(method, params) as T;
}

export async function startAutomationTurnWithRequest(
	via: TurnAutomationStartedTurn["via"],
	turn: TurnAutomationTurnStartParams,
	request: TurnAutomationBackendRequest,
	id?: string,
): Promise<TurnAutomationStartedTurn> {
	validateTurnPermissionOptions(turn);
	let threadId = turn.threadId;
	let thread: unknown = null;
	const existingThread = Boolean(threadId);
	if (!threadId) {
		const threadResponse = await request(
			"thread/start",
			threadStartParamsFromAutomation(turn),
		);
		threadId = nestedId(threadResponse, "thread", "thread/start");
		thread = record(threadResponse).thread ?? threadResponse;
	}
	const turnResponse = await request(
		"turn/start",
		turnStartParamsFromAutomation(threadId, turn, {
			includeSandboxPolicy: existingThread,
		}),
	);
	return compactUndefined({
		id,
		via,
		threadId,
		turnId: nestedId(turnResponse, "turn", "turn/start"),
		thread,
		turn: record(turnResponse).turn ?? turnResponse,
	});
}

export async function readAutomationTurnWithRequest(
	via: TurnAutomationStartedTurn["via"],
	request: TurnAutomationBackendRequest,
	ref: Pick<TurnAutomationStartedTurn, "id" | "threadId" | "turnId">,
): Promise<TurnAutomationTurnSnapshot> {
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
		turnId: ref.turnId,
		status: optionalString(turn.status) ?? "unknown",
		outputText: finalTextFromTurn(turn),
		error: turn.error,
		thread,
		turn,
	});
}

export async function waitAutomationTurnWithRequest(
	via: TurnAutomationStartedTurn["via"],
	request: TurnAutomationBackendRequest,
	ref: Pick<TurnAutomationStartedTurn, "id" | "threadId" | "turnId">,
	options: {
		timeoutMs?: number;
		pollIntervalMs?: number;
		throwOnFailure?: boolean;
	} = {},
): Promise<TurnAutomationTurnSnapshot> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TURN_WAIT_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_TURN_WAIT_POLL_INTERVAL_MS;
	const startedAt = Date.now();
	while (true) {
		const snapshot = await readAutomationTurnWithRequest(via, request, ref);
		if (snapshot.status !== "inProgress") {
			if (
				snapshot.status === "failed" &&
				options.throwOnFailure !== false
			) {
				throw new Error(`Turn ${ref.turnId} failed`);
			}
			return snapshot;
		}
		if (Date.now() - startedAt >= timeoutMs) {
			throw new Error(`Timed out waiting for turn ${ref.turnId}`);
		}
		await delay(Math.min(pollIntervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt))));
	}
}

export async function readAutomationDelegationWithRequest(
	options: CreateTurnAutomationHostOptions,
	ref: Record<string, unknown>,
): Promise<TurnAutomationDelegationSnapshot> {
	const response = await workbenchHostRequest<{
		delegation: WorkbenchDelegation;
		latestTurnId?: string;
		latestStatus?: string;
		lastFinal?: { text: string };
	}>(options, "delegation.read", ref);
	return compactUndefined({
		id: optionalString(ref.id),
		delegation: response.delegation,
		turnId: response.delegation.lastTurnId,
		status: response.delegation.status,
		latestTurnId: response.latestTurnId,
		latestStatus: response.latestStatus,
		outputText: response.lastFinal?.text ?? response.delegation.lastFinal ?? "",
		error: response.delegation.status === "failed"
			? response.delegation.lastStatus
			: undefined,
	});
}

export async function waitAutomationDelegationWithRequest(
	options: CreateTurnAutomationHostOptions,
	ref: Record<string, unknown>,
	waitOptions: {
		timeoutMs?: number;
		pollIntervalMs?: number;
		throwOnFailure?: boolean;
	} = {},
): Promise<TurnAutomationDelegationSnapshot> {
	const timeoutMs = waitOptions.timeoutMs ?? DEFAULT_TURN_WAIT_TIMEOUT_MS;
	const pollIntervalMs = waitOptions.pollIntervalMs ?? DEFAULT_TURN_WAIT_POLL_INTERVAL_MS;
	const startedAt = Date.now();
	while (true) {
		const snapshot = await readAutomationDelegationWithRequest(options, ref);
		if (snapshot.status !== "active" && snapshot.status !== "idle") {
			if (snapshot.status === "failed" && waitOptions.throwOnFailure !== false) {
				throw new Error(`Delegation ${snapshot.delegation.id} failed`);
			}
			return snapshot;
		}
		if (Date.now() - startedAt >= timeoutMs) {
			throw new Error(`Timed out waiting for delegation ${optionalString(ref.delegationId) ?? optionalString(ref.id) ?? optionalString(ref.threadId) ?? "unknown"}`);
		}
		await delay(Math.min(pollIntervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt))));
	}
}

export async function listTurnAutomations(
	options: ListTurnAutomationsOptions = {},
): Promise<LoadedTurnAutomation[]> {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const roots = options.roots?.map((root) => path.resolve(cwd, root)) ??
		[
			path.join(cwd, ".codex", "automations"),
			path.join(cwd, "automations"),
		];
	const loaded: LoadedTurnAutomation[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		for (const manifestPath of await automationManifestPaths(root)) {
			const automation = await loadTurnAutomationManifest(manifestPath, cwd);
			if (seen.has(automation.name)) {
				continue;
			}
			seen.add(automation.name);
			loaded.push(automation);
		}
	}
	return loaded.sort((left, right) => left.name.localeCompare(right.name));
}

export async function resolveTurnAutomationTarget(
	target: string,
	options: ListTurnAutomationsOptions = {},
): Promise<TurnAutomationRunTarget> {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	if (target.includes("/") || target.includes("\\") || target.endsWith(".ts") || target.endsWith(".js")) {
		throw new Error(`Turn automation target must be a named automation, got ${JSON.stringify(target)}`);
	}
	const automations = await listTurnAutomations({ ...options, cwd });
	const automation = automations.find((entry) => entry.name === target);
	if (!automation) {
		throw new Error(`No turn automation named ${JSON.stringify(target)} was found`);
	}
	return targetFromAutomation(automation);
}

export function formatTurnAutomationList(
	automations: LoadedTurnAutomation[],
): string {
	if (automations.length === 0) {
		return "No turn automations found.\n";
	}
	return automations.map((automation) => {
		const description = automation.manifest.description
			? ` - ${automation.manifest.description}`
			: "";
		return `${automation.name}${description}`;
	}).join("\n") + "\n";
}

function turnAutomationContext(
	options: RunTurnAutomationScriptOptions & {
		scriptPath: string;
		automation?: LoadedTurnAutomation;
	},
): TurnAutomationContext {
	return compactUndefined({
		automation: {
			scriptPath: options.scriptPath,
			name: options.automation?.name,
			manifestPath: options.automation?.manifestPath,
			config: options.automation?.manifest.config,
		},
		runtime: {
			startedAt: new Date().toISOString(),
		},
		event: options.event,
		prompt: options.prompt,
		cwd: options.cwd,
		workbenchRoot: options.automation?.workbenchRoot,
	});
}

async function automationManifestPaths(root: string): Promise<string[]> {
	if (!await isDirectory(root)) {
		return [];
	}
	const entries = await readdir(root, { withFileTypes: true });
	const manifests: string[] = [];
	for (const entry of entries) {
		if (entry.isDirectory()) {
			const manifestPath = path.join(root, entry.name, "automation.json");
			if (await isFile(manifestPath)) {
				manifests.push(manifestPath);
			}
		}
	}
	return manifests.sort();
}

async function loadTurnAutomationManifest(
	manifestPath: string,
	workbenchRoot: string,
): Promise<LoadedTurnAutomation> {
	const root = path.dirname(manifestPath);
	const resolvedWorkbenchRoot = path.resolve(workbenchRoot);
	const parsed = parseJsonText(await readFile(manifestPath, "utf8"), manifestPath);
	if (!isRecord(parsed)) {
		throw new Error(`Turn automation manifest must be an object: ${manifestPath}`);
	}
	const script = optionalString(parsed.script);
	if (!script) {
		throw new Error(`Turn automation manifest requires script: ${manifestPath}`);
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
		timeoutMs: optionalPositiveNumber(parsed.timeoutMs, "turn automation timeoutMs"),
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
		cwd: manifest.cwd ? resolveAutomationPath({
			automationRoot: root,
			workbenchRoot: resolvedWorkbenchRoot,
			value: manifest.cwd,
			label: "cwd",
		}) : undefined,
		skills: manifest.skills,
		timeoutMs: manifest.timeoutMs,
	});
}

function targetFromAutomation(
	automation: LoadedTurnAutomation,
): TurnAutomationRunTarget {
	return compactUndefined({
		scriptPath: automation.scriptPath,
		automation,
		prompt: automation.prompt,
		cwd: automation.cwd,
		skills: automation.skills,
		timeoutMs: automation.timeoutMs,
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

function resolveAutomationPath(options: {
	automationRoot: string;
	workbenchRoot: string;
	value: string;
	label: string;
}): string {
	const { automationRoot, workbenchRoot, value, label } = options;
	if (value === "@") {
		return workbenchRoot;
	}
	if (value.startsWith("@/") || value.startsWith("@\\")) {
		const resolved = path.resolve(workbenchRoot, value.slice(2));
		if (!isPathInsideOrEqual(workbenchRoot, resolved)) {
			throw new Error(`Turn automation manifest ${label} must stay inside workbench root when using @/: ${value}`);
		}
		return resolved;
	}
	return path.isAbsolute(value) ? value : path.resolve(automationRoot, value);
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
				"turn automation module result",
			);
	}
	throw new Error("Turn automation module did not return a result");
}

function normalizeTurnAutomationResult(value: unknown): ParsedTurnAutomationResult {
	if (!isRecord(value)) {
		throw new Error("Turn automation result must be a JSON object");
	}
	return { result: value };
}

function turnStartParamsFromHostParams(
	params: Record<string, unknown>,
	defaults: CreateTurnAutomationHostOptions["defaults"] = {},
): TurnAutomationTurnStartParams {
	const prompt = optionalString(params.prompt) ?? defaults.prompt;
	if (!prompt) {
		throw new Error("ctx.turn.start requires a prompt or automation prompt default");
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

function delegationStartParamsFromHostParams(
	params: Record<string, unknown>,
	defaults: CreateTurnAutomationHostOptions["defaults"] = {},
): TurnAutomationHostDelegationStartParams {
	const prompt = optionalString(params.prompt) ?? defaults.prompt;
	return compactUndefined({
		id: optionalString(params.id),
		cwd: requiredString(params.cwd ?? defaults.cwd, "ctx.delegate.start cwd"),
		prompt,
		title: optionalString(params.title),
		groupId: optionalString(params.groupId),
		returnMode: optionalString(params.returnMode),
		allowAbsoluteCwd: optionalBoolean(params.allowAbsoluteCwd),
		model: optionalString(params.model) ?? defaults.model,
		serviceTier: optionalString(params.serviceTier),
		effort: reasoningEffortValue(params.effort) ?? defaults.effort,
		sandbox: sandboxModeValue(params.sandbox) ?? defaults.sandbox,
		approvalPolicy: approvalPolicyValue(params.approvalPolicy) ??
			defaults.approvalPolicy,
		permissions: optionalString(params.permissions) ?? defaults.permissions,
	});
}

function delegationRefFromValue(
	value: unknown,
	label: string,
): Record<string, unknown> {
	const params = record(value);
	const delegation = record(params.delegation);
	const id = optionalString(params.delegationId) ??
		optionalString(params.id) ??
		optionalString(delegation.id);
	const threadId = optionalString(params.threadId) ??
		optionalString(delegation.codexThreadId);
	if (!id && !threadId) {
		throw new Error(`${label} requires delegationId, id, or threadId`);
	}
	return compactUndefined({
		id: optionalString(params.id),
		delegationId: id,
		threadId,
	});
}

function turnRefFromValue(
	value: unknown,
	label: string,
): Pick<TurnAutomationStartedTurn, "id" | "threadId" | "turnId"> {
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

function threadStartParamsFromAutomation(
	turn: TurnAutomationTurnStartParams,
): v2.ThreadStartParams {
	return compactUndefined({
			cwd: turn.cwd,
			model: turn.model,
			serviceTier: turn.serviceTier,
			sandbox: turn.sandbox,
			approvalPolicy: turn.approvalPolicy,
			permissions: turn.permissions,
		experimentalRawEvents: false,
		persistExtendedHistory: false,
	});
}

function turnStartParamsFromAutomation(
	threadId: string,
	turn: TurnAutomationTurnStartParams,
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

function validateTurnPermissionOptions(turn: TurnAutomationTurnStartParams): void {
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
	host: TurnAutomationHostHandler | undefined,
	message: unknown,
): Promise<void> {
	if (!isHostRequestMessage(message)) {
		return;
	}
	try {
		if (!host) {
			throw new Error("Turn automation host API is not available");
		}
		const result = await host({
			method: message.method,
			params: message.params,
		});
		await sendChildMessage(subprocess, {
			type: "turnAutomation.hostResponse",
			id: message.id,
			result,
		}).catch(() => undefined);
	} catch (error) {
		await sendChildMessage(subprocess, {
			type: "turnAutomation.hostResponse",
			id: message.id,
			error: {
				message: errorMessage(error),
				stack: error instanceof Error ? error.stack : undefined,
			},
		}).catch(() => undefined);
	}
}

function isHostRequestMessage(value: unknown): value is {
	type: "turnAutomation.hostRequest";
	id: number;
	method: string;
	params?: unknown;
} {
	const message = record(value);
	return message.type === "turnAutomation.hostRequest" &&
		typeof message.id === "number" &&
		typeof message.method === "string";
}

function sendChildMessage(
	subprocess: ReturnType<typeof spawn>,
	message: unknown,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!subprocess.connected || typeof subprocess.send !== "function") {
			reject(new Error("Turn automation runner IPC channel is closed"));
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
		siblingRuntimePath("turn-automation-module-runner"),
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

function exitCodeFor(subprocess: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		subprocess.once("error", reject);
		subprocess.once("exit", (code) => resolve(code));
	});
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
