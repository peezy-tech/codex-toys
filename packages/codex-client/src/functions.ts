import { access, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import type { WorkspaceBackendMethodHandler } from "./workspace-backend/server.ts";

export const WORKSPACE_FUNCTIONS_LIST_METHOD = "functions.list";
export const WORKSPACE_FUNCTIONS_DESCRIBE_METHOD = "functions.describe";
export const WORKSPACE_FUNCTIONS_CALL_METHOD = "functions.call";

export type WorkspaceFunctionSideEffects =
	| "none"
	| "read-only"
	| "writes-local"
	| "external-write";

export type WorkspaceFunctionMetadata = {
	name: string;
	description: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
	examples?: unknown;
	tags?: string[];
	sideEffects: WorkspaceFunctionSideEffects;
	timeoutMs?: number;
};

export type WorkspaceFunctionContext = {
	cwd: string;
	name: string;
};

export type WorkspaceFunctionHandler = (
	params: unknown,
	context: WorkspaceFunctionContext,
) => unknown | Promise<unknown>;

export type WorkspaceFunctionDefinition =
	| WorkspaceFunctionHandler
	| {
			description?: string;
			inputSchema?: unknown;
			outputSchema?: unknown;
			examples?: unknown;
			tags?: string[];
			sideEffects?: WorkspaceFunctionSideEffects;
			timeoutMs?: number;
			handler: WorkspaceFunctionHandler;
	  };

export type WorkspaceFunctionDefinitions = Record<string, WorkspaceFunctionDefinition>;

export type WorkspaceFunctionsModule = unknown;

export type WorkspaceFunctionsListResponse = {
	functions: WorkspaceFunctionMetadata[];
};

export type WorkspaceFunctionsDescribeParams = {
	name: string;
};

export type WorkspaceFunctionsDescribeResponse = {
	function: WorkspaceFunctionMetadata;
};

export type WorkspaceFunctionsCallParams = {
	name: string;
	params?: unknown;
};

export type WorkspaceFunctionsCallResponse = {
	result: unknown;
};

export type WorkspaceFunctionRuntimeOptions = {
	cwd?: string;
	now?: () => number;
};

export function defineFunctions(
	functions: WorkspaceFunctionDefinitions,
): WorkspaceFunctionDefinitions {
	return functions;
}

type LoadedWorkspaceFunctionDefinition = {
	handler: WorkspaceFunctionHandler;
	description?: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
	examples?: unknown;
	tags?: string[];
	sideEffects: WorkspaceFunctionSideEffects;
	timeoutMs?: number;
};

export function createWorkspaceFunctionMethods(
	options: WorkspaceFunctionRuntimeOptions = {},
): Record<string, WorkspaceBackendMethodHandler> {
	const runtime = new WorkspaceFunctionRuntime(options);
	return {
		[WORKSPACE_FUNCTIONS_LIST_METHOD]: async () => await runtime.list(),
		[WORKSPACE_FUNCTIONS_DESCRIBE_METHOD]: async (params) =>
			await runtime.describe(describeParams(params).name),
		[WORKSPACE_FUNCTIONS_CALL_METHOD]: async (params) => {
			const call = callParams(params);
			return await runtime.call(call.name, call.params);
		},
	};
}

export class WorkspaceFunctionRuntime {
	#cwd: string;
	#now: () => number;

	constructor(options: WorkspaceFunctionRuntimeOptions = {}) {
		this.#cwd = path.resolve(options.cwd ?? process.cwd());
		this.#now = options.now ?? Date.now;
	}

	async list(): Promise<WorkspaceFunctionsListResponse> {
		const loaded = await this.#load();
		return {
			functions: [...loaded.entries()]
				.map(([name, definition]) => metadataFor(name, definition))
				.sort((left, right) => left.name.localeCompare(right.name)),
		};
	}

	async describe(name: string): Promise<WorkspaceFunctionsDescribeResponse> {
		const definition = (await this.#load()).get(name);
		if (!definition) {
			throw new Error(`Workspace function not found: ${name}`);
		}
		return { function: metadataFor(name, definition) };
	}

	async call(name: string, params?: unknown): Promise<WorkspaceFunctionsCallResponse> {
		const definition = (await this.#load()).get(name);
		if (!definition) {
			throw new Error(`Workspace function not found: ${name}`);
		}
		const result = await definition.handler(params, { cwd: this.#cwd, name });
		return { result: jsonRoundTrip(result, `Workspace function returned non-JSON data: ${name}`) };
	}

	async #load(): Promise<Map<string, LoadedWorkspaceFunctionDefinition>> {
		const manifestPath = await findFunctionsManifest(this.#cwd);
		if (!manifestPath) {
			return new Map();
		}
		const module = await importFunctionsModule(manifestPath, this.#now());
		return validateFunctionsManifest(manifestPath, module);
	}
}

export async function findFunctionsManifest(cwd: string): Promise<string | undefined> {
	const root = path.resolve(cwd);
	for (const name of ["functions.ts", "functions.js", "functions.mjs"]) {
		const candidate = path.join(root, ".codex", name);
		if (await exists(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

async function importFunctionsModule(
	manifestPath: string,
	cacheBust: number,
): Promise<WorkspaceFunctionsModule> {
	const url = pathToFileURL(manifestPath).href;
	const version = encodeURIComponent(String((await stat(manifestPath)).mtimeMs || cacheBust));
	try {
		if (manifestPath.endsWith(".ts")) {
			return await tsImport(`${url}?v=${version}`, import.meta.url) as WorkspaceFunctionsModule;
		}
		return await import(`${url}?v=${version}`) as WorkspaceFunctionsModule;
	} catch (error) {
		throw new Error(
			`Failed to load workspace functions manifest ${manifestPath}: ${errorMessage(error)}`,
		);
	}
}

function validateFunctionsManifest(
	manifestPath: string,
	module: WorkspaceFunctionsModule,
): Map<string, LoadedWorkspaceFunctionDefinition> {
	const value = exportedManifestValue(module);
	if (!isRecord(value)) {
		throw manifestError(
			manifestPath,
			"expected default export to be an object of function definitions",
		);
	}
	const loaded = new Map<string, LoadedWorkspaceFunctionDefinition>();
	for (const [name, definition] of Object.entries(value)) {
		if (!isFunctionName(name)) {
			throw manifestError(manifestPath, `invalid function name "${name}"`);
		}
		loaded.set(name, validateFunctionDefinition(manifestPath, name, definition));
	}
	return loaded;
}

function exportedManifestValue(module: WorkspaceFunctionsModule): unknown {
	return unwrapModuleValue(module);
}

function unwrapModuleValue(
	value: unknown,
	depth = 0,
): unknown {
	if (depth > 5) {
		return value;
	}
	if (!isRecord(value)) {
		return value;
	}
	const input = value as {
		default?: unknown;
		functions?: unknown;
		"module.exports"?: unknown;
	};
	const keys = Object.keys(value);
	if (
		"default" in input &&
		(isModuleNamespace(value) || keys.length === 1 ||
			(keys.length === 2 && keys.includes("module.exports")))
	) {
		return unwrapModuleValue(input.default, depth + 1);
	}
	if ("module.exports" in input && (isModuleNamespace(value) || keys.length === 1)) {
		return unwrapModuleValue(input["module.exports"], depth + 1);
	}
	if ("functions" in input && isModuleNamespace(value)) {
		return unwrapModuleValue(input.functions, depth + 1);
	}
	return value;
}

function metadataFor(
	name: string,
	definition: LoadedWorkspaceFunctionDefinition,
): WorkspaceFunctionMetadata {
	return {
		name,
		description: definition.description ?? "",
		...(definition.inputSchema !== undefined ? { inputSchema: definition.inputSchema } : {}),
		...(definition.outputSchema !== undefined ? { outputSchema: definition.outputSchema } : {}),
		...(definition.examples !== undefined ? { examples: definition.examples } : {}),
		...(definition.tags !== undefined ? { tags: definition.tags } : {}),
		sideEffects: definition.sideEffects ?? "read-only",
		...(definition.timeoutMs !== undefined ? { timeoutMs: definition.timeoutMs } : {}),
	};
}

function validateFunctionDefinition(
	manifestPath: string,
	name: string,
	value: unknown,
): LoadedWorkspaceFunctionDefinition {
	if (typeof value === "function") {
		return {
			handler: value as WorkspaceFunctionHandler,
			sideEffects: "read-only",
		};
	}
	if (!isRecord(value)) {
		throw functionError(manifestPath, name, "must be an object with a handler function");
	}
	const input = value as {
		description?: unknown;
		inputSchema?: unknown;
		outputSchema?: unknown;
		examples?: unknown;
		tags?: unknown;
		sideEffects?: unknown;
		timeoutMs?: unknown;
		handler?: unknown;
	};
	if (typeof input.handler !== "function") {
		throw functionError(manifestPath, name, "handler must be a function");
	}
	if (input.description !== undefined && typeof input.description !== "string") {
		throw functionError(manifestPath, name, "description must be a string");
	}
	if (input.sideEffects !== undefined && !isSideEffects(input.sideEffects)) {
		throw functionError(
			manifestPath,
			name,
			"sideEffects must be one of: none, read-only, writes-local, external-write",
		);
	}
	if (
		input.tags !== undefined &&
		(!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string"))
	) {
		throw functionError(manifestPath, name, "tags must be an array of strings");
	}
	if (input.timeoutMs !== undefined && typeof input.timeoutMs !== "number") {
		throw functionError(manifestPath, name, "timeoutMs must be a number");
	}
	return {
		handler: input.handler as WorkspaceFunctionHandler,
		...(input.description !== undefined ? { description: input.description } : {}),
		...(input.inputSchema !== undefined ? { inputSchema: input.inputSchema } : {}),
		...(input.outputSchema !== undefined ? { outputSchema: input.outputSchema } : {}),
		...(input.examples !== undefined ? { examples: input.examples } : {}),
		...(input.tags !== undefined ? { tags: input.tags } : {}),
		sideEffects: input.sideEffects ?? "read-only",
		...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
	};
}

function isSideEffects(value: unknown): value is WorkspaceFunctionSideEffects {
	return value === "none" ||
		value === "read-only" ||
		value === "writes-local" ||
		value === "external-write";
}

function isFunctionName(value: string): boolean {
	return /^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(value);
}

function describeParams(value: unknown): WorkspaceFunctionsDescribeParams {
	const input = record(value);
	const name = stringValue(input.name);
	if (!name) {
		throw new Error("functions.describe requires name");
	}
	return { name };
}

function callParams(value: unknown): WorkspaceFunctionsCallParams {
	const input = record(value);
	const name = stringValue(input.name);
	if (!name) {
		throw new Error("functions.call requires name");
	}
	return { name, params: input.params };
}

function jsonRoundTrip(value: unknown, message: string): unknown {
	if (value === undefined) {
		throw new Error(message);
	}
	try {
		const text = JSON.stringify(value);
		if (text === undefined) {
			throw new Error("JSON.stringify returned undefined");
		}
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`${message}: ${errorMessage(error)}`);
	}
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModuleNamespace(value: Record<string, unknown>): boolean {
	return Object.prototype.toString.call(value) === "[object Module]";
}

function manifestError(manifestPath: string, message: string): Error {
	return new Error(`Invalid workspace functions manifest ${manifestPath}: ${message}`);
}

function functionError(manifestPath: string, name: string, message: string): Error {
	return manifestError(manifestPath, `function "${name}" ${message}`);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
