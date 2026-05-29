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

export type WorkspaceFunctionsModule =
	| WorkspaceFunctionDefinitions
	| {
			default?: WorkspaceFunctionDefinitions;
			functions?: WorkspaceFunctionDefinitions;
	  };

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
		const result = await handlerFor(definition)(params, { cwd: this.#cwd, name });
		return { result: jsonRoundTrip(result, `Workspace function returned non-JSON data: ${name}`) };
	}

	async #load(): Promise<Map<string, WorkspaceFunctionDefinition>> {
		const manifestPath = await findFunctionsManifest(this.#cwd);
		if (!manifestPath) {
			return new Map();
		}
		const module = await importFunctionsModule(manifestPath, this.#now());
		const definitions = definitionsFromModule(module);
		return new Map(Object.entries(definitions).map(([name, definition]) => {
			if (!isFunctionName(name)) {
				throw new Error(`Invalid workspace function name: ${name}`);
			}
			if (!isWorkspaceFunctionDefinition(definition)) {
				throw new Error(`Invalid workspace function definition: ${name}`);
			}
			return [name, definition];
		}));
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
	if (manifestPath.endsWith(".ts")) {
		return await tsImport(`${url}?v=${version}`, import.meta.url) as WorkspaceFunctionsModule;
	}
	return await import(`${url}?v=${version}`) as WorkspaceFunctionsModule;
}

function definitionsFromModule(module: WorkspaceFunctionsModule): WorkspaceFunctionDefinitions {
	const definitions = resolveDefinitions(module);
	if (definitions) {
		return definitions;
	}
	throw new Error("Workspace functions manifest must export default functions or named functions");
}

function resolveDefinitions(
	value: unknown,
	depth = 0,
): WorkspaceFunctionDefinitions | undefined {
	if (depth > 5) {
		return undefined;
	}
	if (isWorkspaceFunctionDefinitions(value)) {
		return value;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const input = value as {
		default?: unknown;
		functions?: unknown;
		"module.exports"?: unknown;
	};
	return resolveDefinitions(input.default, depth + 1) ??
		resolveDefinitions(input.functions, depth + 1) ??
		resolveDefinitions(input["module.exports"], depth + 1);
}

function isWorkspaceFunctionDefinitions(
	value: unknown,
): value is WorkspaceFunctionDefinitions {
	return Boolean(
		value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.values(value).every(isWorkspaceFunctionDefinition),
	);
}

function metadataFor(
	name: string,
	definition: WorkspaceFunctionDefinition,
): WorkspaceFunctionMetadata {
	if (typeof definition === "function") {
		return {
			name,
			description: "",
			sideEffects: "read-only",
		};
	}
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

function handlerFor(definition: WorkspaceFunctionDefinition): WorkspaceFunctionHandler {
	return typeof definition === "function" ? definition : definition.handler;
}

function isWorkspaceFunctionDefinition(
	value: unknown,
): value is WorkspaceFunctionDefinition {
	if (typeof value === "function") {
		return true;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const input = value as { handler?: unknown; sideEffects?: unknown; tags?: unknown };
	return typeof input.handler === "function" &&
		(input.sideEffects === undefined || isSideEffects(input.sideEffects)) &&
		(input.tags === undefined ||
			(Array.isArray(input.tags) && input.tags.every((tag) => typeof tag === "string")));
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
