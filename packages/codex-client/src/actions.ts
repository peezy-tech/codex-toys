import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
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

const SQLITE_EXTENSIONS = [".sqlite", ".sqlite3", ".db"];
const ACTIONS_STATE_RELATIVE = path.join("workspace", "actions");

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
		return JSON.parse(stripJsonBom(text)) as unknown;
	} catch (error) {
		throw new Error(`${source} must contain JSON: ${errorMessage(error)}`);
	}
}

function stripJsonBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
