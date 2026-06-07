import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "./types.ts";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const EVAL_ROOT = path.resolve(sourceDir, "..");
export const REPO_ROOT = path.resolve(EVAL_ROOT, "..", "..");
export const DEFAULT_RUNS_DIR = path.join(EVAL_ROOT, ".runs");

export function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

export function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export async function ensureDir(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true });
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
	return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await ensureDir(path.dirname(filePath));
	await writeFile(filePath, `${JSON.stringify(value, null, "\t")}\n`);
}

export async function listJsonFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => path.join(directory, entry.name))
		.sort();
}

export async function readJsonl(filePath: string): Promise<unknown[]> {
	const text = await readFile(filePath, "utf8");
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as unknown);
}

export async function writeJsonl(filePath: string, values: unknown[]): Promise<void> {
	await ensureDir(path.dirname(filePath));
	await writeFile(filePath, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

export function runId(scenarioId: string, profileId: string, now = new Date()): string {
	const timestamp = now.toISOString().replace(/[:.]/g, "-");
	return `${timestamp}-${slug(scenarioId)}-${slug(profileId)}`;
}

export function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

export function resolveEvalPath(value: string, baseDir: string): string {
	if (path.isAbsolute(value)) {
		return value;
	}
	if (value === "@") {
		return REPO_ROOT;
	}
	if (value.startsWith("@/")) {
		return path.join(REPO_ROOT, value.slice(2));
	}
	return path.resolve(baseDir, value);
}

export function jsonPath(value: unknown, selector: string): JsonValue | undefined {
	const parts = selector.split(".").filter(Boolean);
	let current: unknown = value;
	for (const part of parts) {
		if (/^\d+$/.test(part)) {
			current = array(current)[Number(part)];
		} else {
			current = record(current)[part];
		}
		if (current === undefined) {
			return undefined;
		}
	}
	return isJsonValue(current) ? current : undefined;
}

export function isJsonValue(value: unknown): value is JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue);
	}
	if (value && typeof value === "object") {
		return Object.values(value).every(isJsonValue);
	}
	return false;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
