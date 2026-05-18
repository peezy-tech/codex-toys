import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export type ThreadBundleManifest = {
	schemaVersion: 1;
	kind: "codex-flows.thread-bundle";
	threadId: string;
	createdAt: string;
	source: {
		originalRelativePath: string;
		cwd?: string;
	};
	files: ThreadBundleManifestFile[];
};

export type ThreadBundleManifestFile = {
	role: "rollout";
	relativePath: string;
	bytes: number;
	sha256: string;
};

export type LocateThreadRolloutOptions = {
	threadId: string;
	codexHome?: string;
};

export type ThreadRolloutLocation = {
	threadId: string;
	codexHome: string;
	path: string;
	relativePath: string;
	bytes: number;
	sha256: string;
	cwd?: string;
	matchedBy: "session_meta" | "filename";
};

export type ExportThreadBundleOptions = LocateThreadRolloutOptions & {
	outputDir: string;
};

export type ExportThreadBundleResult = {
	bundleDir: string;
	manifest: ThreadBundleManifest;
	rollout: ThreadRolloutLocation;
};

export type InspectThreadBundleOptions = {
	bundleDir: string;
};

export type InspectedThreadBundleFile = ThreadBundleManifestFile & {
	path: string;
};

export type InspectThreadBundleResult = {
	bundleDir: string;
	manifest: ThreadBundleManifest;
	files: InspectedThreadBundleFile[];
};

export type ImportThreadBundleOptions = {
	bundleDir: string;
	codexHome?: string;
	replace?: boolean;
};

export type ImportedThreadBundleFile = ThreadBundleManifestFile & {
	path: string;
	backupPath?: string;
};

export type ImportThreadBundleResult = {
	codexHome: string;
	bundleDir: string;
	manifest: ThreadBundleManifest;
	imported: ImportedThreadBundleFile[];
};

export type TransplantThreadRolloutOptions = {
	threadId: string;
	fromCodexHome?: string;
	toCodexHome?: string;
	replace?: boolean;
};

export type TransplantedThreadRollout = ThreadBundleManifestFile & {
	path: string;
	backupPath?: string;
};

export type TransplantThreadRolloutResult = {
	threadId: string;
	fromCodexHome: string;
	toCodexHome: string;
	source: ThreadRolloutLocation;
	transplanted: TransplantedThreadRollout;
};

type CandidateRollout = ThreadRolloutLocation;

const bundleKind = "codex-flows.thread-bundle";
const rolloutFilenamePattern = /^rollout-.+-([0-9a-fA-F-]{36})\.jsonl$/;
const checksumPattern = /^[0-9a-f]{64}$/;

export async function locateThreadRollout(
	options: LocateThreadRolloutOptions,
): Promise<ThreadRolloutLocation> {
	const threadId = requiredNonEmpty(options.threadId, "threadId");
	const codexHome = resolveCodexHome(options.codexHome);
	const rolloutFiles = await listRolloutFiles(path.join(codexHome, "sessions"));
	const parsedMatches: CandidateRollout[] = [];
	const filenameMatches: CandidateRollout[] = [];

	for (const rolloutPath of rolloutFiles) {
		const metadata = await readRolloutSessionMeta(rolloutPath);
		const filenameThreadId = threadIdFromRolloutFilename(path.basename(rolloutPath));
		const relativePath = toManifestPath(path.relative(codexHome, rolloutPath));
		const info = await stat(rolloutPath);
		if (!info.isFile()) {
			continue;
		}
		if (metadata.threadId === threadId) {
			parsedMatches.push({
				threadId,
				codexHome,
				path: rolloutPath,
				relativePath,
				bytes: info.size,
				sha256: await sha256File(rolloutPath),
				...(metadata.cwd ? { cwd: metadata.cwd } : {}),
				matchedBy: "session_meta",
			});
			continue;
		}
		if (!metadata.threadId && filenameThreadId === threadId) {
			filenameMatches.push({
				threadId,
				codexHome,
				path: rolloutPath,
				relativePath,
				bytes: info.size,
				sha256: await sha256File(rolloutPath),
				...(metadata.cwd ? { cwd: metadata.cwd } : {}),
				matchedBy: "filename",
			});
		}
	}

	const matches = parsedMatches.length > 0 ? parsedMatches : filenameMatches;
	if (matches.length === 0) {
		throw new Error(`No rollout found for thread ${threadId} under ${codexHome}`);
	}
	if (matches.length > 1) {
		throw new Error(`Multiple rollouts found for thread ${threadId} under ${codexHome}`);
	}
	const match = matches[0];
	if (!match) {
		throw new Error(`No rollout found for thread ${threadId} under ${codexHome}`);
	}
	return match;
}

export async function exportThreadBundle(
	options: ExportThreadBundleOptions,
): Promise<ExportThreadBundleResult> {
	const outputDir = path.resolve(requiredNonEmpty(options.outputDir, "outputDir"));
	const rollout = await locateThreadRollout(options);
	await assertOutputDirectoryAvailable(outputDir);
	const bundleRolloutPath = safeResolve(outputDir, rollout.relativePath);
	await mkdir(path.dirname(bundleRolloutPath), { recursive: true });
	await copyFile(rollout.path, bundleRolloutPath);
	const copiedInfo = await stat(bundleRolloutPath);
	const copiedSha256 = await sha256File(bundleRolloutPath);
	if (copiedInfo.size !== rollout.bytes || copiedSha256 !== rollout.sha256) {
		throw new Error(`Copied rollout checksum mismatch for ${rollout.relativePath}`);
	}
	const manifest: ThreadBundleManifest = {
		schemaVersion: 1,
		kind: bundleKind,
		threadId: rollout.threadId,
		createdAt: new Date().toISOString(),
		source: {
			originalRelativePath: rollout.relativePath,
			...(rollout.cwd ? { cwd: rollout.cwd } : {}),
		},
		files: [
			{
				role: "rollout",
				relativePath: rollout.relativePath,
				bytes: rollout.bytes,
				sha256: rollout.sha256,
			},
		],
	};
	await writeFile(
		path.join(outputDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	return { bundleDir: outputDir, manifest, rollout };
}

export async function inspectThreadBundle(
	options: InspectThreadBundleOptions,
): Promise<InspectThreadBundleResult> {
	const bundleDir = path.resolve(requiredNonEmpty(options.bundleDir, "bundleDir"));
	const manifest = await readManifest(bundleDir);
	const files: InspectedThreadBundleFile[] = [];
	for (const file of manifest.files) {
		const filePath = safeResolve(bundleDir, file.relativePath);
		const info = await stat(filePath);
		if (!info.isFile()) {
			throw new Error(`Bundle file is not a regular file: ${file.relativePath}`);
		}
		if (info.size !== file.bytes) {
			throw new Error(`Bundle file byte length mismatch: ${file.relativePath}`);
		}
		const actualSha256 = await sha256File(filePath);
		if (actualSha256 !== file.sha256) {
			throw new Error(`Bundle file checksum mismatch: ${file.relativePath}`);
		}
		files.push({ ...file, path: filePath });
	}
	return { bundleDir, manifest, files };
}

export async function importThreadBundle(
	options: ImportThreadBundleOptions,
): Promise<ImportThreadBundleResult> {
	const inspected = await inspectThreadBundle({ bundleDir: options.bundleDir });
	const codexHome = resolveCodexHome(options.codexHome);
	const imported: ImportedThreadBundleFile[] = [];
	for (const file of inspected.files) {
		const copied = await copyVerifiedRollout({
			sourcePath: file.path,
			targetCodexHome: codexHome,
			relativePath: file.relativePath,
			bytes: file.bytes,
			sha256: file.sha256,
			replace: options.replace,
			verb: "Imported",
		});
		imported.push({
			role: file.role,
			relativePath: file.relativePath,
			bytes: file.bytes,
			sha256: file.sha256,
			path: copied.path,
			...(copied.backupPath ? { backupPath: copied.backupPath } : {}),
		});
	}
	return {
		codexHome,
		bundleDir: inspected.bundleDir,
		manifest: inspected.manifest,
		imported,
	};
}

export async function transplantThreadRollout(
	options: TransplantThreadRolloutOptions,
): Promise<TransplantThreadRolloutResult> {
	const source = await locateThreadRollout({
		threadId: options.threadId,
		codexHome: options.fromCodexHome,
	});
	const toCodexHome = resolveCodexHome(options.toCodexHome);
	const copied = await copyVerifiedRollout({
		sourcePath: source.path,
		targetCodexHome: toCodexHome,
		relativePath: source.relativePath,
		bytes: source.bytes,
		sha256: source.sha256,
		replace: options.replace,
		verb: "Transplanted",
	});
	return {
		threadId: source.threadId,
		fromCodexHome: source.codexHome,
		toCodexHome,
		source,
		transplanted: {
			role: "rollout",
			relativePath: source.relativePath,
			bytes: source.bytes,
			sha256: source.sha256,
			path: copied.path,
			...(copied.backupPath ? { backupPath: copied.backupPath } : {}),
		},
	};
}

export function formatThreadRolloutLocation(location: ThreadRolloutLocation): string {
	const lines = [
		`thread id          ${location.threadId}`,
		`codex home         ${location.codexHome}`,
		`rollout            ${location.relativePath}`,
		`matched by         ${location.matchedBy}`,
		`bytes              ${location.bytes}`,
		`sha256             ${location.sha256}`,
	];
	if (location.cwd) {
		lines.push(`cwd                ${location.cwd}`);
	}
	return `${lines.join("\n")}\n`;
}

export function formatThreadBundleExport(result: ExportThreadBundleResult): string {
	return [
		`thread id          ${result.manifest.threadId}`,
		`bundle             ${result.bundleDir}`,
		`rollout            ${result.manifest.files[0]?.relativePath ?? ""}`,
		`bytes              ${result.manifest.files[0]?.bytes ?? 0}`,
		`sha256             ${result.manifest.files[0]?.sha256 ?? ""}`,
		"",
	].join("\n");
}

export function formatThreadBundleInspection(result: InspectThreadBundleResult): string {
	const rollout = result.manifest.files[0];
	const lines = [
		`thread id          ${result.manifest.threadId}`,
		`bundle             ${result.bundleDir}`,
		`schema             ${result.manifest.schemaVersion}`,
		`created            ${result.manifest.createdAt}`,
		`rollout            ${rollout?.relativePath ?? ""}`,
		`bytes              ${rollout?.bytes ?? 0}`,
		`sha256             ${rollout?.sha256 ?? ""}`,
	];
	if (result.manifest.source.cwd) {
		lines.push(`source cwd         ${result.manifest.source.cwd}`);
	}
	return `${lines.join("\n")}\n`;
}

export function formatThreadBundleImport(result: ImportThreadBundleResult): string {
	const lines = [
		`thread id          ${result.manifest.threadId}`,
		`codex home         ${result.codexHome}`,
		`bundle             ${result.bundleDir}`,
		`imported           ${result.imported.length}`,
	];
	for (const file of result.imported) {
		lines.push(`rollout            ${file.relativePath}`);
		if (file.backupPath) {
			lines.push(`backup             ${file.backupPath}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

export function formatThreadRolloutTransplant(result: TransplantThreadRolloutResult): string {
	const lines = [
		`thread id          ${result.threadId}`,
		`from codex home    ${result.fromCodexHome}`,
		`to codex home      ${result.toCodexHome}`,
		`rollout            ${result.transplanted.relativePath}`,
		`bytes              ${result.transplanted.bytes}`,
		`sha256             ${result.transplanted.sha256}`,
	];
	if (result.transplanted.backupPath) {
		lines.push(`backup             ${result.transplanted.backupPath}`);
	}
	return `${lines.join("\n")}\n`;
}

async function copyVerifiedRollout(options: {
	sourcePath: string;
	targetCodexHome: string;
	relativePath: string;
	bytes: number;
	sha256: string;
	replace?: boolean;
	verb: "Imported" | "Transplanted";
}): Promise<{ path: string; backupPath?: string }> {
	const destinationPath = safeResolve(options.targetCodexHome, options.relativePath);
	if (path.resolve(options.sourcePath) === destinationPath) {
		throw new Error(`Source and target rollout are the same file: ${destinationPath}`);
	}
	const destinationExists = await exists(destinationPath);
	let backup: string | undefined;
	if (destinationExists) {
		if (!options.replace) {
			throw new Error(`Target rollout already exists: ${destinationPath}`);
		}
		backup = await nextBackupPath(destinationPath);
		await copyFile(destinationPath, backup);
	}
	await mkdir(path.dirname(destinationPath), { recursive: true });
	await copyFile(options.sourcePath, destinationPath);
	const copiedInfo = await stat(destinationPath);
	if (copiedInfo.size !== options.bytes) {
		throw new Error(`${options.verb} rollout byte length mismatch: ${options.relativePath}`);
	}
	const copiedSha256 = await sha256File(destinationPath);
	if (copiedSha256 !== options.sha256) {
		throw new Error(`${options.verb} rollout checksum mismatch: ${options.relativePath}`);
	}
	return {
		path: destinationPath,
		...(backup ? { backupPath: backup } : {}),
	};
}

function resolveCodexHome(codexHome: string | undefined): string {
	return path.resolve(codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
}

async function listRolloutFiles(root: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...await listRolloutFiles(fullPath));
		} else if (entry.isFile() && rolloutFilenamePattern.test(entry.name)) {
			files.push(fullPath);
		}
	}
	return files.sort();
}

async function readRolloutSessionMeta(
	rolloutPath: string,
): Promise<{ threadId?: string; cwd?: string }> {
	const lines = createInterface({
		input: createReadStream(rolloutPath, { encoding: "utf8" }),
		crlfDelay: Infinity,
	});
	try {
		for await (const line of lines) {
			if (!line.trim()) {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line) as unknown;
			} catch {
				continue;
			}
			const record = objectValue(parsed);
			if (record?.type !== "session_meta") {
				continue;
			}
			const payload = objectValue(record.payload);
			return {
				...(typeof payload?.id === "string" ? { threadId: payload.id } : {}),
				...(typeof payload?.cwd === "string" ? { cwd: payload.cwd } : {}),
			};
		}
		return {};
	} finally {
		lines.close();
	}
}

function threadIdFromRolloutFilename(fileName: string): string | undefined {
	return rolloutFilenamePattern.exec(fileName)?.[1]?.toLowerCase();
}

async function readManifest(bundleDir: string): Promise<ThreadBundleManifest> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path.join(bundleDir, "manifest.json"), "utf8")) as unknown;
	} catch (error) {
		throw new Error(`Failed to read thread bundle manifest: ${errorMessage(error)}`);
	}
	return validateManifest(parsed);
}

function validateManifest(value: unknown): ThreadBundleManifest {
	const manifest = objectValue(value);
	if (!manifest) {
		throw new Error("Thread bundle manifest must be an object");
	}
	if (manifest.schemaVersion !== 1) {
		throw new Error("Thread bundle manifest schemaVersion must be 1");
	}
	if (manifest.kind !== bundleKind) {
		throw new Error(`Thread bundle manifest kind must be ${bundleKind}`);
	}
	const threadId = requiredManifestString(manifest.threadId, "threadId");
	const createdAt = requiredManifestString(manifest.createdAt, "createdAt");
	const source = objectValue(manifest.source);
	if (!source) {
		throw new Error("Thread bundle manifest source must be an object");
	}
	const originalRelativePath = requiredManifestString(
		source.originalRelativePath,
		"source.originalRelativePath",
	);
	assertSafeRelativePath(originalRelativePath);
	const cwd = typeof source.cwd === "string" && source.cwd ? source.cwd : undefined;
	if (!Array.isArray(manifest.files) || manifest.files.length !== 1) {
		throw new Error("Thread bundle manifest files must contain exactly one rollout file");
	}
	const files = manifest.files.map(validateManifestFile);
	const rollout = files[0];
	if (!rollout) {
		throw new Error("Thread bundle manifest files must contain exactly one rollout file");
	}
	if (rollout.relativePath !== originalRelativePath) {
		throw new Error("Thread bundle manifest source path must match the rollout file path");
	}
	return {
		schemaVersion: 1,
		kind: bundleKind,
		threadId,
		createdAt,
		source: {
			originalRelativePath,
			...(cwd ? { cwd } : {}),
		},
		files,
	};
}

function validateManifestFile(value: unknown): ThreadBundleManifestFile {
	const file = objectValue(value);
	if (!file) {
		throw new Error("Thread bundle manifest file entry must be an object");
	}
	if (file.role !== "rollout") {
		throw new Error("Thread bundle manifest file role must be rollout");
	}
	const relativePath = requiredManifestString(file.relativePath, "files[].relativePath");
	assertSafeRelativePath(relativePath);
	const bytes = file.bytes;
	if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
		throw new Error("Thread bundle manifest file bytes must be a non-negative integer");
	}
	const sha256 = requiredManifestString(file.sha256, "files[].sha256");
	if (!checksumPattern.test(sha256)) {
		throw new Error("Thread bundle manifest file sha256 must be a lowercase sha256 hex digest");
	}
	return {
		role: "rollout",
		relativePath,
		bytes,
		sha256,
	};
}

async function assertOutputDirectoryAvailable(outputDir: string): Promise<void> {
	let info;
	try {
		info = await stat(outputDir);
	} catch {
		await mkdir(outputDir, { recursive: true });
		return;
	}
	if (!info.isDirectory()) {
		throw new Error(`Output path exists and is not a directory: ${outputDir}`);
	}
	const entries = await readdir(outputDir);
	if (entries.length > 0) {
		throw new Error(`Output directory must be empty: ${outputDir}`);
	}
}

function safeResolve(root: string, relativePath: string): string {
	assertSafeRelativePath(relativePath);
	const rootPath = path.resolve(root);
	const resolved = path.resolve(rootPath, ...relativePath.split(/[\\/]+/));
	if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) {
		throw new Error(`Path escapes root: ${relativePath}`);
	}
	return resolved;
}

function assertSafeRelativePath(relativePath: string): void {
	if (!relativePath || path.isAbsolute(relativePath)) {
		throw new Error(`Path must be relative: ${relativePath}`);
	}
	const segments = relativePath.split(/[\\/]+/);
	if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
		throw new Error(`Path contains unsafe segments: ${relativePath}`);
	}
}

function toManifestPath(relativePath: string): string {
	return relativePath.split(path.sep).join("/");
}

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(filePath);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", resolve);
	});
	return hash.digest("hex");
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

async function nextBackupPath(filePath: string): Promise<string> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const base = `${filePath}.backup-${timestamp}`;
	if (!await exists(base)) {
		return base;
	}
	for (let index = 2; ; index += 1) {
		const candidate = `${base}-${index}`;
		if (!await exists(candidate)) {
			return candidate;
		}
	}
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function requiredNonEmpty(value: string | undefined, label: string): string {
	if (!value) {
		throw new Error(`${label} is required`);
	}
	return value;
}

function requiredManifestString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value) {
		throw new Error(`Thread bundle manifest ${label} must be a non-empty string`);
	}
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
