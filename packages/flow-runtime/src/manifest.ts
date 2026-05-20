import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { FlowManifest, FlowStep, LoadedFlow } from "./types.ts";

export type DiscoverFlowsOptions = {
	cwd: string;
	roots?: string[];
};

export async function loadFlow(root: string): Promise<LoadedFlow> {
	const manifestPath = path.join(root, "flow.toml");
	const parsed = parseToml(await readFile(manifestPath, "utf8")) as unknown;
	const manifest = normalizeManifest(parsed, manifestPath);
	return { root, manifestPath, manifest };
}

export async function discoverFlows(options: DiscoverFlowsOptions): Promise<LoadedFlow[]> {
	const roots = options.roots ?? [
		path.join(options.cwd, ".codex", "flows"),
		path.join(options.cwd, "flows"),
	];
	const flows: LoadedFlow[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		for (const directory of await childDirectories(root)) {
			const manifestPath = path.join(directory, "flow.toml");
			if (!(await exists(manifestPath))) {
				continue;
			}
			const flow = await loadFlow(directory);
			if (seen.has(flow.manifest.name)) {
				continue;
			}
			seen.add(flow.manifest.name);
			flows.push(flow);
		}
	}
	return flows;
}

export function stepScriptPath(flow: LoadedFlow, step: FlowStep): string {
	return path.resolve(flow.root, step.script);
}

export function stepSchemaPath(flow: LoadedFlow, step: FlowStep): string | undefined {
	return step.trigger?.schema ? path.resolve(flow.root, step.trigger.schema) : undefined;
}

async function childDirectories(root: string): Promise<string[]> {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(root, entry.name))
			.sort();
	} catch (error) {
		if (isErrno(error, "ENOENT")) {
			return [];
		}
		throw error;
	}
}

function normalizeManifest(value: unknown, manifestPath: string): FlowManifest {
	if (!isRecord(value)) {
		throw new Error(`flow.toml must contain a table: ${manifestPath}`);
	}
	const name = requiredString(value.name, "name", manifestPath);
	const version = requiredNumber(value.version, "version", manifestPath);
	const rawSteps = Array.isArray(value.steps) ? value.steps : undefined;
	if (!rawSteps || rawSteps.length === 0) {
		throw new Error(`flow.toml requires at least one [[steps]] entry: ${manifestPath}`);
	}
	return {
		name,
		version,
		...(typeof value.description === "string" ? { description: value.description } : {}),
		...(isRecord(value.config) ? { config: value.config } : {}),
		...(isRecord(value.guidance) ? { guidance: normalizeGuidance(value.guidance) } : {}),
		steps: rawSteps.map((step, index) => normalizeStep(step, index, manifestPath)),
	};
}

function normalizeGuidance(value: Record<string, unknown>): FlowManifest["guidance"] {
	return {
		...(Array.isArray(value.skills)
			? { skills: value.skills.filter((entry): entry is string => typeof entry === "string") }
			: {}),
	};
}

function normalizeStep(value: unknown, index: number, manifestPath: string): FlowStep {
	if (!isRecord(value)) {
		throw new Error(`steps[${index}] must be a table: ${manifestPath}`);
	}
	const runner = requiredString(value.runner, `steps[${index}].runner`, manifestPath);
	if (runner !== "node" && runner !== "code-mode") {
		throw new Error(`steps[${index}].runner must be node or code-mode: ${manifestPath}`);
	}
	return {
		name: requiredString(value.name, `steps[${index}].name`, manifestPath),
		runner,
		script: requiredString(value.script, `steps[${index}].script`, manifestPath),
		timeoutMs: typeof value.timeout_ms === "number" ? value.timeout_ms : 300_000,
		...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
		...(isRecord(value.trigger) ? { trigger: normalizeTrigger(value.trigger, index, manifestPath) } : {}),
	};
}

function normalizeTrigger(value: Record<string, unknown>, index: number, manifestPath: string): FlowStep["trigger"] {
	return {
		type: requiredString(value.type, `steps[${index}].trigger.type`, manifestPath),
		...(typeof value.schema === "string" ? { schema: value.schema } : {}),
	};
}

function requiredString(value: unknown, name: string, pathValue: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`flow.toml requires ${name}: ${pathValue}`);
	}
	return value;
}

function requiredNumber(value: unknown, name: string, pathValue: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`flow.toml requires numeric ${name}: ${pathValue}`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

async function exists(pathValue: string): Promise<boolean> {
	try {
		await access(pathValue);
		return true;
	} catch (error) {
		if (isErrno(error, "ENOENT")) {
			return false;
		}
		throw error;
	}
}
