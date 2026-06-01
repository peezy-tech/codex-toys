import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

export type CodexMemoryArtifact = {
	relativePath: string;
	path: string;
	bytes: number;
	mtimeMs: number;
};

export type ListCodexMemoryArtifactsOptions = {
	codexHome: string;
};

export type FindTextInCodexMemoryArtifactsOptions =
	ListCodexMemoryArtifactsOptions & {
		text: string;
	};

export type WaitForCodexMemoryArtifactsOptions =
	ListCodexMemoryArtifactsOptions & {
		text?: string;
		timeoutMs?: number;
		pollIntervalMs?: number;
	};

export type CopyCodexMemoryArtifactsOptions = {
	sourceCodexHome: string;
	workbenchRoot: string;
};

export type CopyCodexMemoryArtifactsResult = {
	source: string;
	destination: string;
	copied: CodexMemoryArtifact[];
};

export type SanitizeWorkbenchMemoryArtifactsOptions = {
	workbenchRoot: string;
};

export type SanitizeWorkbenchMemoryArtifactsResult = {
	memoryRoot: string;
	removed: string[];
};

const stableRootMemoryArtifacts = new Set(["raw_memories.md"]);
const SQLITE_EXTENSIONS = [".sqlite", ".sqlite3", ".db"];

export async function listCodexMemoryArtifacts(
	options: ListCodexMemoryArtifactsOptions,
): Promise<CodexMemoryArtifact[]> {
	const memoryRoot = path.join(path.resolve(options.codexHome), "memories");
	const files = await listFiles(memoryRoot);
	const artifacts: CodexMemoryArtifact[] = [];
	for (const relativePath of files) {
		const normalized = toPosixPath(relativePath);
		if (!isStableCodexMemoryArtifact(normalized)) {
			continue;
		}
		const artifactPath = path.join(memoryRoot, relativePath);
		const info = await stat(artifactPath);
		artifacts.push({
			relativePath: normalized,
			path: artifactPath,
			bytes: info.size,
			mtimeMs: info.mtimeMs,
		});
	}
	return artifacts.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function findTextInCodexMemoryArtifacts(
	options: FindTextInCodexMemoryArtifactsOptions,
): Promise<CodexMemoryArtifact[]> {
	const matches: CodexMemoryArtifact[] = [];
	for (const artifact of await listCodexMemoryArtifacts(options)) {
		if ((await readFile(artifact.path, "utf8")).includes(options.text)) {
			matches.push(artifact);
		}
	}
	return matches;
}

export async function waitForCodexMemoryArtifacts(
	options: WaitForCodexMemoryArtifactsOptions,
): Promise<CodexMemoryArtifact[]> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const pollIntervalMs = options.pollIntervalMs ?? 500;
	const started = Date.now();
	let latest: CodexMemoryArtifact[] = [];
	while (Date.now() - started <= timeoutMs) {
		latest = options.text
			? await findTextInCodexMemoryArtifacts({
					codexHome: options.codexHome,
					text: options.text,
				})
			: await listCodexMemoryArtifacts(options);
		if (latest.length > 0) {
			return latest;
		}
		await sleep(pollIntervalMs);
	}
	throw new Error(
		options.text
			? `Timed out waiting for Codex memory artifacts containing ${JSON.stringify(options.text)}`
			: "Timed out waiting for Codex memory artifacts",
	);
}

export async function copyCodexMemoryArtifacts(
	options: CopyCodexMemoryArtifactsOptions,
): Promise<CopyCodexMemoryArtifactsResult> {
	const sourceCodexHome = path.resolve(options.sourceCodexHome);
	const destinationCodexHome = path.join(path.resolve(options.workbenchRoot), ".codex");
	const destinationRoot = path.join(destinationCodexHome, "memories");
	const copied: CodexMemoryArtifact[] = [];
	for (const artifact of await listCodexMemoryArtifacts({ codexHome: sourceCodexHome })) {
		const destinationPath = path.join(destinationRoot, artifact.relativePath);
		await mkdir(path.dirname(destinationPath), { recursive: true });
		await copyFile(artifact.path, destinationPath);
		const info = await stat(destinationPath);
		copied.push({
			relativePath: artifact.relativePath,
			path: destinationPath,
			bytes: info.size,
			mtimeMs: info.mtimeMs,
		});
	}
	return {
		source: path.join(sourceCodexHome, "memories"),
		destination: destinationRoot,
		copied,
	};
}

export async function sanitizeWorkbenchMemoryArtifacts(
	options: SanitizeWorkbenchMemoryArtifactsOptions,
): Promise<SanitizeWorkbenchMemoryArtifactsResult> {
	const memoryRoot = path.join(path.resolve(options.workbenchRoot), ".codex", "memories");
	const removed: string[] = [];
	await removeIfExists(path.join(memoryRoot, ".git"), memoryRoot, removed);
	await removeIfExists(path.join(memoryRoot, "phase2_workbench_diff.md"), memoryRoot, removed);
	for (const file of await listFiles(memoryRoot)) {
		if (isSqlitePath(file)) {
			await removeIfExists(path.join(memoryRoot, file), memoryRoot, removed);
		}
	}
	return { memoryRoot, removed: removed.sort() };
}

function isStableCodexMemoryArtifact(normalizedPath: string): boolean {
	return stableRootMemoryArtifacts.has(normalizedPath) ||
		(normalizedPath.startsWith("rollout_summaries/") &&
			normalizedPath.endsWith(".md"));
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(path.join(root, prefix), { withFileTypes: true });
	} catch (error) {
		if (isErrno(error, "ENOENT")) {
			return [];
		}
		throw error;
	}
	const files: string[] = [];
	for (const entry of entries) {
		const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
		if (entry.isDirectory()) {
			files.push(...await listFiles(root, relativePath));
		} else if (entry.isFile()) {
			files.push(relativePath);
		}
	}
	return files;
}

async function removeIfExists(file: string, root: string, removed: string[]): Promise<void> {
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

function isSqlitePath(file: string): boolean {
	const lower = file.toLowerCase();
	return SQLITE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error &&
		(error as { code?: unknown }).code === code;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
