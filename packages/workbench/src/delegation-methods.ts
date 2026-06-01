import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { v2 } from "@codex-toys/bridge/generated";
import type { ToyboxMethodHandler, ToyboxMethodMetadata } from "@codex-toys/toybox";
import {
	WorkbenchDelegationCapability,
	type WorkbenchDelegation,
	type WorkbenchDelegationAppServer,
	type WorkbenchDelegationState,
	type WorkbenchPendingWake,
} from "./delegation.ts";

export const WORKBENCH_DELEGATION_LIST_METHOD = "delegation.list";
export const WORKBENCH_DELEGATION_START_METHOD = "delegation.start";
export const WORKBENCH_DELEGATION_RESUME_METHOD = "delegation.resume";
export const WORKBENCH_DELEGATION_SEND_METHOD = "delegation.send";
export const WORKBENCH_DELEGATION_READ_METHOD = "delegation.read";
export const WORKBENCH_DELEGATION_SET_POLICY_METHOD = "delegation.setPolicy";
export const WORKBENCH_DELEGATION_FLUSH_RESULTS_METHOD = "delegation.flushResults";
export const WORKBENCH_DELEGATION_LIST_GROUPS_METHOD = "delegation.listGroups";

export const workbenchDelegationMethodMetadata: ToyboxMethodMetadata[] = [
	{
		name: WORKBENCH_DELEGATION_LIST_METHOD,
		description: "List delegated Codex threads recorded for this workbench.",
		sideEffects: "read-only",
		category: "delegation",
	},
	{
		name: WORKBENCH_DELEGATION_START_METHOD,
		description: "Start a delegated Codex thread in a workbench-relative cwd.",
		sideEffects: "writes-local",
		category: "delegation",
	},
	{
		name: WORKBENCH_DELEGATION_RESUME_METHOD,
		description: "Resume an existing delegated thread.",
		sideEffects: "writes-local",
		category: "delegation",
	},
	{
		name: WORKBENCH_DELEGATION_SEND_METHOD,
		description: "Send a follow-up turn to a delegated thread.",
		sideEffects: "writes-local",
		category: "delegation",
	},
	{
		name: WORKBENCH_DELEGATION_READ_METHOD,
		description: "Read the latest state for a delegated thread.",
		sideEffects: "writes-local",
		category: "delegation",
	},
	{
		name: WORKBENCH_DELEGATION_SET_POLICY_METHOD,
		description: "Set return policy metadata for a delegation.",
		sideEffects: "writes-local",
		category: "delegation",
	},
	{
		name: WORKBENCH_DELEGATION_FLUSH_RESULTS_METHOD,
		description: "Collect completed delegation results for return handling.",
		sideEffects: "writes-local",
		category: "delegation",
	},
	{
		name: WORKBENCH_DELEGATION_LIST_GROUPS_METHOD,
		description: "List delegation groups and their current status.",
		sideEffects: "read-only",
		category: "delegation",
	},
];

export type WorkbenchDelegationTarget = {
	id: string;
	cwd: string;
	label: string;
	kind: "workbench" | "repo" | "recent";
	source: "discovered" | "recent";
	exists: boolean;
};

export type WorkbenchDelegationListResponse = {
	delegations: WorkbenchDelegation[];
	targets?: WorkbenchDelegationTarget[];
};

export type WorkbenchDelegationRuntimeOptions = {
	appServer: {
		request<T = unknown>(method: string, params?: unknown): Promise<T>;
	};
	workbenchRoot?: string;
	statePath?: string;
	env?: Record<string, string | undefined>;
	now?: () => Date;
};

type DelegationStateFile = {
	delegations?: unknown;
	pendingWakes?: unknown;
};

type NormalizedDelegationArgs = Record<string, unknown> & {
	cwd?: string;
	requestedCwd?: string;
};

export function createWorkbenchDelegationMethods(
	options: WorkbenchDelegationRuntimeOptions,
): Record<string, ToyboxMethodHandler> {
	const workbenchRoot = path.resolve(options.workbenchRoot ?? process.cwd());
	const statePath = options.statePath ??
		path.join(workbenchRoot, ".codex", "workbench", "local", "delegations.json");
	const env = options.env ?? process.env;
	const state: WorkbenchDelegationState = { delegations: [] };
	const store = new WorkbenchDelegationStore(statePath);
	const capability = new WorkbenchDelegationCapability({
		client: appServerAdapter(options.appServer),
		state,
		now: options.now,
		threadStartParams: ({ cwd, args }) => threadStartParams(cwd, args),
		threadResumeParams: ({ threadId, cwd, args }) =>
			threadResumeParams(threadId, cwd, args),
		turnStartParams: ({ threadId, prompt, cwd, args }) =>
			turnStartParams(threadId, prompt, cwd, args),
		metadataFromArgs: (args) => metadataFromArgs(args, workbenchRoot),
		surfaceKeyForCwd: (cwd) => workbenchKeyForCwd(workbenchRoot, cwd),
	});

	const load = async (): Promise<void> => {
		const loaded = await store.read();
		state.delegations = loaded.delegations;
		state.pendingWakes = loaded.pendingWakes;
	};
	const mutate = async <T>(callback: () => T | Promise<T>): Promise<T> => {
		await load();
		const result = await callback();
		await store.write(state);
		return result;
	};

	return {
		[WORKBENCH_DELEGATION_LIST_METHOD]: async (params) => {
			await load();
			const args = record(params);
			const response: WorkbenchDelegationListResponse = capability.list();
			if (booleanValue(args.includeTargets, true)) {
				response.targets = await listDelegationTargets(workbenchRoot, state);
			}
			return response;
		},
		[WORKBENCH_DELEGATION_START_METHOD]: async (params) =>
			await mutate(async () => {
				const args = await normalizeStartArgs(params, {
					workbenchRoot,
					env,
				});
				return await capability.start(args);
			}),
		[WORKBENCH_DELEGATION_RESUME_METHOD]: async (params) =>
			await mutate(async () => {
				const args = await normalizeOptionalCwdArgs(params, {
					workbenchRoot,
					env,
				});
				return await capability.resume(args);
			}),
		[WORKBENCH_DELEGATION_SEND_METHOD]: async (params) =>
			await mutate(async () => await capability.send(record(params))),
		[WORKBENCH_DELEGATION_READ_METHOD]: async (params) =>
			await mutate(async () => await capability.read(record(params))),
		[WORKBENCH_DELEGATION_SET_POLICY_METHOD]: async (params) =>
			await mutate(() => capability.setPolicy(record(params))),
		[WORKBENCH_DELEGATION_FLUSH_RESULTS_METHOD]: async (params) =>
			await mutate(async () => await capability.flushResults(record(params))),
		[WORKBENCH_DELEGATION_LIST_GROUPS_METHOD]: async () => {
			await load();
			return { groups: capability.listGroups() };
		},
	};
}

export async function resolveDelegationCwd(
	value: string,
	options: {
		workbenchRoot: string;
		allowAbsoluteCwd?: boolean;
		env?: Record<string, string | undefined>;
		mustExist?: boolean;
	} = { workbenchRoot: process.cwd() },
): Promise<string> {
	const workbenchRoot = path.resolve(options.workbenchRoot);
	const allowAbsoluteCwd = options.allowAbsoluteCwd === true ||
		truthy(options.env?.CODEX_TOYS_DELEGATION_ALLOW_ABSOLUTE_CWD);
	let resolved: string;
	if (value === "@") {
		resolved = workbenchRoot;
	} else if (value.startsWith("@/") || value.startsWith("@\\")) {
		resolved = path.resolve(workbenchRoot, value.slice(2));
		assertInsideWorkbench(workbenchRoot, resolved, value);
	} else if (path.isAbsolute(value)) {
		if (!allowAbsoluteCwd) {
			throw new Error(
				"Absolute delegation cwd requires allowAbsoluteCwd=true or CODEX_TOYS_DELEGATION_ALLOW_ABSOLUTE_CWD=1",
			);
		}
		resolved = path.resolve(value);
	} else {
		resolved = path.resolve(workbenchRoot, value);
		assertInsideWorkbench(workbenchRoot, resolved, value);
	}
	if (options.mustExist !== false) {
		await assertDirectory(resolved, value);
	}
	return resolved;
}

async function normalizeStartArgs(
	params: unknown,
	options: {
		workbenchRoot: string;
		env: Record<string, string | undefined>;
	},
): Promise<NormalizedDelegationArgs> {
	const args = record(params);
	const requestedCwd = requiredString(args.cwd, "cwd");
	const cwd = await resolveDelegationCwd(requestedCwd, {
		workbenchRoot: options.workbenchRoot,
		allowAbsoluteCwd: booleanValue(args.allowAbsoluteCwd, false),
		env: options.env,
	});
	validateTurnPermissionOptions(args);
	return { ...args, cwd, requestedCwd };
}

async function normalizeOptionalCwdArgs(
	params: unknown,
	options: {
		workbenchRoot: string;
		env: Record<string, string | undefined>;
	},
): Promise<NormalizedDelegationArgs> {
	const args = record(params);
	const requestedCwd = stringValue(args.cwd);
	if (!requestedCwd) {
		validateTurnPermissionOptions(args);
		return args;
	}
	const cwd = await resolveDelegationCwd(requestedCwd, {
		workbenchRoot: options.workbenchRoot,
		allowAbsoluteCwd: booleanValue(args.allowAbsoluteCwd, false),
		env: options.env,
	});
	validateTurnPermissionOptions(args);
	return { ...args, cwd, requestedCwd };
}

function appServerAdapter(appServer: {
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
}): WorkbenchDelegationAppServer {
	return {
		startThread: async (params) => await appServer.request("thread/start", params),
		resumeThread: async (params) => await appServer.request("thread/resume", params),
		setThreadName: async (params) => await appServer.request("thread/name/set", params),
		startTurn: async (params) => await appServer.request("turn/start", params),
		readThread: async (params) => await appServer.request("thread/read", params),
	};
}

function threadStartParams(
	cwd: string,
	args: Record<string, unknown>,
): v2.ThreadStartParams {
	return compactUndefined({
		cwd,
		model: stringValue(args.model),
		serviceTier: stringValue(args.serviceTier),
		sandbox: sandboxModeValue(args.sandbox),
		approvalPolicy: approvalPolicyValue(args.approvalPolicy),
		permissions: stringValue(args.permissions),
		runtimeWorkbenchRoots: stringArray(args.runtimeWorkbenchRoots),
		experimentalRawEvents: false,
		persistExtendedHistory: false,
	});
}

function threadResumeParams(
	threadId: string,
	cwd: string | undefined,
	args: Record<string, unknown>,
): v2.ThreadResumeParams {
	return compactUndefined({
		threadId,
		cwd,
		model: stringValue(args.model),
		serviceTier: stringValue(args.serviceTier),
		sandbox: sandboxModeValue(args.sandbox),
		approvalPolicy: approvalPolicyValue(args.approvalPolicy),
		permissions: stringValue(args.permissions),
		runtimeWorkbenchRoots: stringArray(args.runtimeWorkbenchRoots),
		excludeTurns: true,
		persistExtendedHistory: false,
	});
}

function turnStartParams(
	threadId: string,
	prompt: string,
	cwd: string | null | undefined,
	args: Record<string, unknown>,
): v2.TurnStartParams {
	return compactUndefined({
		threadId,
		input: [
			{
				type: "text",
				text: prompt,
				text_elements: [],
			},
		],
		cwd,
		model: stringValue(args.model),
		serviceTier: stringValue(args.serviceTier),
		approvalPolicy: approvalPolicyValue(args.approvalPolicy),
		permissions: stringValue(args.permissions),
		runtimeWorkbenchRoots: stringArray(args.runtimeWorkbenchRoots),
		responsesapiClientMetadata: stringRecord(args.responsesapiClientMetadata),
		sandboxPolicy: sandboxPolicyFromMode(sandboxModeValue(args.sandbox)),
	});
}

async function listDelegationTargets(
	workbenchRoot: string,
	state: WorkbenchDelegationState,
): Promise<WorkbenchDelegationTarget[]> {
	const targets = new Map<string, WorkbenchDelegationTarget>();
	for (const collection of [
		{ dirname: "workbenches", kind: "workbench" as const },
		{ dirname: "repos", kind: "repo" as const },
	]) {
		const parent = path.join(workbenchRoot, collection.dirname);
		for (const entry of await directoryEntries(parent)) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) {
				continue;
			}
			const id = `@/${collection.dirname}/${entry.name}`;
			targets.set(id, {
				id,
				cwd: path.join(parent, entry.name),
				label: entry.name,
				kind: collection.kind,
				source: "discovered",
				exists: true,
			});
		}
	}
	for (const delegation of state.delegations) {
		if (!delegation.cwd) {
			continue;
		}
		const id = cwdAlias(workbenchRoot, delegation.cwd);
		if (targets.has(id)) {
			continue;
		}
		targets.set(id, {
			id,
			cwd: delegation.cwd,
			label: path.basename(delegation.cwd),
			kind: "recent",
			source: "recent",
			exists: await isDirectory(delegation.cwd),
		});
	}
	return [...targets.values()].sort((left, right) => left.id.localeCompare(right.id));
}

class WorkbenchDelegationStore {
	#statePath: string;

	constructor(statePath: string) {
		this.#statePath = statePath;
	}

	async read(): Promise<WorkbenchDelegationState> {
		try {
			const parsed = JSON.parse(await readFile(this.#statePath, "utf8")) as DelegationStateFile;
			return {
				delegations: Array.isArray(parsed.delegations)
					? parsed.delegations.map((item) => item as WorkbenchDelegation)
					: [],
				pendingWakes: Array.isArray(parsed.pendingWakes)
					? parsed.pendingWakes.map((item) => item as WorkbenchPendingWake)
					: undefined,
			};
		} catch (error) {
			if (isNotFoundError(error)) {
				return { delegations: [] };
			}
			throw error;
		}
	}

	async write(state: WorkbenchDelegationState): Promise<void> {
		await mkdir(path.dirname(this.#statePath), { recursive: true });
		const tmpPath = `${this.#statePath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tmpPath, `${JSON.stringify({
			delegations: state.delegations,
			pendingWakes: state.pendingWakes,
		}, null, 2)}\n`);
		await rename(tmpPath, this.#statePath);
	}
}

function metadataFromArgs(
	args: Record<string, unknown>,
	workbenchRoot: string,
): Record<string, unknown> | undefined {
	const metadata = record(args.metadata);
	const requestedCwd = stringValue(args.requestedCwd);
	return compactUndefined({
		...metadata,
		workbenchRoot,
		requestedCwd,
	});
}

function workbenchKeyForCwd(workbenchRoot: string, cwd?: string): string | undefined {
	if (!cwd) {
		return undefined;
	}
	const alias = cwdAlias(workbenchRoot, cwd);
	return alias.startsWith("@/") ? alias : undefined;
}

function cwdAlias(workbenchRoot: string, cwd: string): string {
	const resolvedRoot = path.resolve(workbenchRoot);
	const resolvedCwd = path.resolve(cwd);
	if (resolvedRoot === resolvedCwd) {
		return "@";
	}
	const relative = path.relative(resolvedRoot, resolvedCwd);
	if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
		return `@/${relative.split(path.sep).join("/")}`;
	}
	return resolvedCwd;
}

function assertInsideWorkbench(workbenchRoot: string, resolved: string, original: string): void {
	const relative = path.relative(workbenchRoot, resolved);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
		return;
	}
	throw new Error(`Delegation cwd must stay inside workbench root when using @/ or a relative path: ${original}`);
}

async function assertDirectory(resolved: string, original: string): Promise<void> {
	try {
		const info = await stat(resolved);
		if (info.isDirectory()) {
			return;
		}
	} catch {}
	throw new Error(`Delegation cwd is not a directory: ${original}`);
}

async function directoryEntries(dir: string): Promise<Dirent[]> {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

async function isDirectory(dir: string): Promise<boolean> {
	try {
		return (await stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

function validateTurnPermissionOptions(args: Record<string, unknown>): void {
	if (args.sandbox !== undefined && args.permissions !== undefined) {
		throw new Error("Delegation cannot combine sandbox and permissions");
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
		throw new Error("Delegation sandbox must be danger-full-access, workspace-write, or read-only");
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
		throw new Error("Delegation approvalPolicy must be never, on-failure, on-request, or untrusted");
	}
	return undefined;
}

function sandboxPolicyFromMode(mode: v2.SandboxMode | undefined): v2.SandboxPolicy | undefined {
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

function requiredString(value: unknown, name: string): string {
	const result = stringValue(value);
	if (!result) {
		throw new Error(`Missing required argument: ${name}`);
	}
	return result;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return truthy(value);
	}
	return fallback;
}

function truthy(value: unknown): boolean {
	return value === true ||
		value === "1" ||
		value === "true" ||
		value === "yes" ||
		value === "on";
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

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const entries = Object.entries(value).filter((entry): entry is [string, string] =>
		typeof entry[1] === "string"
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
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

function isNotFoundError(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}
