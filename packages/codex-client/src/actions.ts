import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import path from "node:path";

export type ActionsHelperEnv = Record<string, string | undefined>;

export type PrepareActionsCodexAuthOptions = {
	workspaceRoot: string;
	env?: ActionsHelperEnv;
};

export type PrepareActionsCodexAuthResult = {
	codexHome: string;
	authPath: string;
	source: "CODEX_AUTH_JSON_B64" | "CODEX_AUTH_JSON" | "OPENAI_API_KEY" | "none";
	wrote: boolean;
};

export type CleanupActionsCodexHomeOptions = {
	workspaceRoot: string;
};

export type CleanupActionsCodexHomeResult = {
	codexHome: string;
	removed: string[];
};

export type CreateActionsLocalFlowClientOptions = {
	workspaceRoot: string;
	env?: ActionsHelperEnv;
};

export type ActionsLocalFlowClient = {
	dispatchEvent(event: unknown, options?: Record<string, unknown>): Promise<unknown>;
	replayEvent(eventId: string, options?: Record<string, unknown>): Promise<unknown>;
	listEvents(options?: Record<string, unknown>): Promise<unknown>;
	getEvent(eventId: string): Promise<unknown>;
	listRuns(options?: Record<string, unknown>): Promise<unknown>;
	getRun(runId: string): Promise<unknown>;
};

export type DispatchActionsFlowEventOptions = {
	workspaceRoot: string;
	event: unknown;
	env?: ActionsHelperEnv;
};

export type DispatchActionsFlowEventResult = {
	eventPath: string;
	event: Record<string, unknown>;
	dispatch: unknown;
};

export type AssertActionsFlowRunOptions = {
	workspaceRoot: string;
	flowName: string;
	stepName: string;
	requireCompleted?: boolean;
	artifactText?: string;
	env?: ActionsHelperEnv;
};

export type AssertActionsFlowRunResult = {
	run: Record<string, unknown>;
};

const SQLITE_EXTENSIONS = [".sqlite", ".sqlite3", ".db"];
const ACTIONS_STATE_RELATIVE = path.join("workspace", "actions");

type LocalFlowClientFactory = (options: Record<string, unknown>) => ActionsLocalFlowClient;

export function repoCodexHome(workspaceRoot: string): string {
	return path.join(path.resolve(workspaceRoot), ".codex");
}

export async function prepareActionsCodexAuth(
	options: PrepareActionsCodexAuthOptions,
): Promise<PrepareActionsCodexAuthResult> {
	const env = options.env ?? process.env;
	const codexHome = repoCodexHome(options.workspaceRoot);
	const authPath = path.join(codexHome, "auth.json");
	const auth = authJsonFromEnv(env);
	if (!auth) {
		return { codexHome, authPath, source: "none", wrote: false };
	}
	await mkdir(codexHome, { recursive: true, mode: 0o700 });
	await writeFile(authPath, `${JSON.stringify(auth.value, null, 2)}\n`, {
		mode: 0o600,
	});
	await chmod(authPath, 0o600);
	return { codexHome, authPath, source: auth.source, wrote: true };
}

export async function cleanupActionsCodexHome(
	options: CleanupActionsCodexHomeOptions,
): Promise<CleanupActionsCodexHomeResult> {
	const codexHome = repoCodexHome(options.workspaceRoot);
	const protectedActionsState = path.join(codexHome, ACTIONS_STATE_RELATIVE);
	const removed: string[] = [];
	for (const relativePath of [
		"auth.json",
		"install_id",
		"install-id",
		"installation_id",
		"sessions",
		"shell_snapshots",
		"shell-snapshots",
		"tmp",
		"temp",
		path.join("memories", ".git"),
		"phase2_workspace_diff.md",
		path.join("memories", "phase2_workspace_diff.md"),
	]) {
		await removeIfExists(path.join(codexHome, relativePath), codexHome, removed, protectedActionsState);
	}
	for (const file of await listFiles(codexHome, { protectedRoot: protectedActionsState })) {
		if (isSqlitePath(file)) {
			await removeIfExists(path.join(codexHome, file), codexHome, removed, protectedActionsState);
		}
	}
	return { codexHome, removed: removed.sort() };
}

export function createActionsLocalFlowClient(
	options: CreateActionsLocalFlowClientOptions,
): ActionsLocalFlowClient {
	const workspaceRoot = path.resolve(options.workspaceRoot);
	const codexHome = repoCodexHome(workspaceRoot);
	const env: ActionsHelperEnv = {
		...process.env,
		...(options.env ?? {}),
		CODEX_HOME: codexHome,
		CODEX_WORKSPACE_MODE: "actions",
	};
	let clientPromise: Promise<ActionsLocalFlowClient> | undefined;
	const client = async (): Promise<ActionsLocalFlowClient> => {
		clientPromise ??= loadLocalFlowClientFactory().then((createLocalFlowClient) =>
			createLocalFlowClient({
				cwd: workspaceRoot,
				env,
				state: {
					kind: "file",
					dataDir: path.join(codexHome, "workspace", "actions", "flow-client"),
				},
				codex: {
					mode: "stdio",
					command: env.CODEX_APP_SERVER_CODEX_COMMAND,
					codexHome,
					stream: env.CODEX_FLOW_STREAM === "0" ? false : true,
				},
			})
		);
		return await clientPromise;
	};
	return {
		dispatchEvent: async (event, dispatchOptions) =>
			await (await client()).dispatchEvent(event, dispatchOptions),
		replayEvent: async (eventId, replayOptions) =>
			await (await client()).replayEvent(eventId, replayOptions),
		listEvents: async (listOptions) =>
			await (await client()).listEvents(listOptions),
		getEvent: async (eventId) => await (await client()).getEvent(eventId),
		listRuns: async (listOptions) => await (await client()).listRuns(listOptions),
		getRun: async (runId) => await (await client()).getRun(runId),
	};
}

export async function dispatchActionsFlowEvent(
	options: DispatchActionsFlowEventOptions,
): Promise<DispatchActionsFlowEventResult> {
	const workspaceRoot = path.resolve(options.workspaceRoot);
	const codexHome = repoCodexHome(workspaceRoot);
	const event = normalizeFlowEvent(options.event);
	const eventsRoot = path.join(codexHome, "workspace", "actions", "events");
	await mkdir(eventsRoot, { recursive: true });
	const eventPath = path.join(eventsRoot, `${eventFileStem(event)}.json`);
	await writeFile(eventPath, `${JSON.stringify(event, null, 2)}\n`);
	const client = createActionsLocalFlowClient({
		workspaceRoot,
		env: options.env,
	});
	const dispatch = await client.dispatchEvent(event);
	return { eventPath, event, dispatch };
}

export async function assertActionsFlowRun(
	options: AssertActionsFlowRunOptions,
): Promise<AssertActionsFlowRunResult> {
	const client = createActionsLocalFlowClient({
		workspaceRoot: options.workspaceRoot,
		env: options.env,
	});
	const listed = record(await client.listRuns({ limit: 100 }));
	const runs = Array.isArray(listed.runs) ? listed.runs.filter(isRecord) : [];
	const run = runs.find((candidate) =>
		candidate.flowName === options.flowName && candidate.stepName === options.stepName
	);
	if (!run) {
		throw new Error(`No Actions flow run found for ${options.flowName}/${options.stepName}`);
	}
	if (options.requireCompleted === true && !isCompletedRun(run)) {
		throw new Error(
			`Latest Actions flow run for ${options.flowName}/${options.stepName} is ${String(run.status ?? run.processStatus ?? "unknown")}`,
		);
	}
	if (options.artifactText !== undefined && !JSON.stringify(run).includes(options.artifactText)) {
		throw new Error(
			`Latest Actions flow run for ${options.flowName}/${options.stepName} does not contain artifact text ${JSON.stringify(options.artifactText)}`,
		);
	}
	return { run };
}

async function loadLocalFlowClientFactory(): Promise<LocalFlowClientFactory> {
	const moduleUrl = new URL(
		import.meta.url.endsWith(".ts")
			? "../../flow-runtime/src/local-client.ts"
			: "./flow-runtime/local-client.js",
		import.meta.url,
	);
	const module = await import(moduleUrl.href) as {
		createLocalFlowClient?: unknown;
	};
	if (typeof module.createLocalFlowClient !== "function") {
		throw new Error("Unable to load createLocalFlowClient");
	}
	return module.createLocalFlowClient as LocalFlowClientFactory;
}

function authJsonFromEnv(
	env: ActionsHelperEnv,
): { source: PrepareActionsCodexAuthResult["source"]; value: unknown } | undefined {
	if (env.CODEX_AUTH_JSON_B64) {
		return {
			source: "CODEX_AUTH_JSON_B64",
			value: parseAuthJson(
				Buffer.from(env.CODEX_AUTH_JSON_B64, "base64").toString("utf8"),
				"CODEX_AUTH_JSON_B64",
			),
		};
	}
	if (env.CODEX_AUTH_JSON) {
		return {
			source: "CODEX_AUTH_JSON",
			value: parseAuthJson(env.CODEX_AUTH_JSON, "CODEX_AUTH_JSON"),
		};
	}
	if (env.OPENAI_API_KEY) {
		return {
			source: "OPENAI_API_KEY",
			value: { OPENAI_API_KEY: env.OPENAI_API_KEY },
		};
	}
	return undefined;
}

function parseAuthJson(text: string, source: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`${source} must contain JSON: ${errorMessage(error)}`);
	}
}

function normalizeFlowEvent(event: unknown): Record<string, unknown> {
	if (!isRecord(event) || typeof event.id !== "string" || typeof event.type !== "string") {
		throw new Error("Actions flow event requires string id and type");
	}
	return {
		receivedAt: new Date().toISOString(),
		payload: {},
		...event,
	};
}

function eventFileStem(event: Record<string, unknown>): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `${timestamp}-${safePathPart(String(event.id))}`;
}

function safePathPart(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "event";
}

async function listFiles(
	root: string,
	options: { prefix?: string; protectedRoot?: string } = {},
): Promise<string[]> {
	const prefix = options.prefix ?? "";
	const current = path.join(root, prefix);
	if (isInsideProtectedRoot(current, options.protectedRoot)) {
		return [];
	}
	let entries;
	try {
		entries = await readdir(current, { withFileTypes: true });
	} catch (error) {
		if (isErrno(error, "ENOENT")) {
			return [];
		}
		throw error;
	}
	const files: string[] = [];
	for (const entry of entries) {
		const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
		const fullPath = path.join(root, relativePath);
		if (isInsideProtectedRoot(fullPath, options.protectedRoot)) {
			continue;
		}
		if (entry.isDirectory()) {
			files.push(...await listFiles(root, {
				prefix: relativePath,
				protectedRoot: options.protectedRoot,
			}));
		} else if (entry.isFile()) {
			files.push(relativePath);
		}
	}
	return files;
}

async function removeIfExists(
	file: string,
	root: string,
	removed: string[],
	protectedRoot?: string,
): Promise<void> {
	if (isInsideProtectedRoot(file, protectedRoot)) {
		return;
	}
	try {
		await stat(file);
	} catch (error) {
		if (isErrno(error, "ENOENT")) {
			return;
		}
		throw error;
	}
	await rm(file, { recursive: true, force: true });
	removed.push(toPosixPath(path.relative(root, file)));
}

function isInsideProtectedRoot(file: string, protectedRoot: string | undefined): boolean {
	if (!protectedRoot) {
		return false;
	}
	const relative = path.relative(protectedRoot, file);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSqlitePath(file: string): boolean {
	const lower = file.toLowerCase();
	return SQLITE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function isCompletedRun(run: Record<string, unknown>): boolean {
	return run.processStatus === "completed" &&
		(run.effectiveStatus === undefined || run.effectiveStatus === "completed");
}

function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
