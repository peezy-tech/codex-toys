import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	copyFile,
	mkdir,
	readFile,
	readdir,
	stat,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export type ThreadRolloutFile = {
	role: "rollout";
	relativePath: string;
	bytes: number;
	sha256: string;
};

export type LocateThreadRolloutOptions = {
	threadId: string;
	codexHome?: string;
};

export type ThreadRolloutInspection = {
	threadId: string;
	path: string;
	relativePath: string;
	bytes: number;
	sha256: string;
	cwd?: string;
	matchedBy: "session_meta" | "filename";
	codexHome?: string;
};

export type ThreadRolloutLocation = ThreadRolloutInspection & {
	codexHome: string;
};

export type InspectThreadRolloutOptions = {
	threadIdOrPath: string;
	codexHome?: string;
};

export type InstallThreadRolloutOptions = {
	rolloutPath: string;
	codexHome?: string;
	replace?: boolean;
	cwd?: string;
	preserveCwd?: boolean;
};

export type InstalledThreadRollout = ThreadRolloutFile & {
	path: string;
	backupPath?: string;
	cwd?: string;
};

export type InstallThreadRolloutResult = {
	codexHome: string;
	source: ThreadRolloutInspection;
	installed: InstalledThreadRollout;
};

export type TransplantThreadRolloutOptions = {
	threadId: string;
	fromCodexHome?: string;
	toCodexHome?: string;
	replace?: boolean;
	cwd?: string;
	preserveCwd?: boolean;
};

export type TransplantedThreadRollout = ThreadRolloutFile & {
	path: string;
	backupPath?: string;
	cwd?: string;
};

export type TransplantThreadRolloutResult = {
	threadId: string;
	fromCodexHome: string;
	toCodexHome: string;
	source: ThreadRolloutLocation;
	transplanted: TransplantedThreadRollout;
};

type CandidateRollout = ThreadRolloutLocation;

const rolloutFilenamePattern = /^rollout-.+-([0-9a-fA-F-]{36})\.jsonl$/;
const rolloutFilenameDatePattern = /^rollout-(\d{4})-(\d{2})-(\d{2})T.+-[0-9a-fA-F-]{36}\.jsonl$/;

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

export async function inspectThreadRollout(
	options: InspectThreadRolloutOptions,
): Promise<ThreadRolloutInspection> {
	const input = requiredNonEmpty(options.threadIdOrPath, "threadIdOrPath");
	if (await isExistingFile(input) || isPathLikeRolloutInput(input)) {
		return await inspectRolloutPath(path.resolve(input), options.codexHome);
	}
	return await locateThreadRollout({
		threadId: input,
		codexHome: options.codexHome,
	});
}

export async function installThreadRollout(
	options: InstallThreadRolloutOptions,
): Promise<InstallThreadRolloutResult> {
	const source = await inspectThreadRollout({ threadIdOrPath: options.rolloutPath });
	const codexHome = resolveCodexHome(options.codexHome);
	const copied = await copyVerifiedRollout({
		sourcePath: source.path,
		targetCodexHome: codexHome,
		relativePath: source.relativePath,
		replace: options.replace,
		cwd: transplantCwd(options),
		verb: "Installed",
	});
	return {
		codexHome,
		source,
		installed: {
			role: "rollout",
			relativePath: source.relativePath,
			bytes: copied.bytes,
			sha256: copied.sha256,
			path: copied.path,
			...(copied.cwd ? { cwd: copied.cwd } : {}),
			...(copied.backupPath ? { backupPath: copied.backupPath } : {}),
		},
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
		replace: options.replace,
		cwd: transplantCwd(options),
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
			bytes: copied.bytes,
			sha256: copied.sha256,
			path: copied.path,
			...(copied.cwd ? { cwd: copied.cwd } : {}),
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

export function formatThreadRolloutInspection(result: ThreadRolloutInspection): string {
	const lines = [
		`thread id          ${result.threadId}`,
		...(result.codexHome ? [`codex home         ${result.codexHome}`] : []),
		`path               ${result.path}`,
		`rollout            ${result.relativePath}`,
		`matched by         ${result.matchedBy}`,
		`bytes              ${result.bytes}`,
		`sha256             ${result.sha256}`,
	];
	if (result.cwd) {
		lines.push(`cwd                ${result.cwd}`);
	}
	return `${lines.join("\n")}\n`;
}

export function formatThreadRolloutInstallation(result: InstallThreadRolloutResult): string {
	const lines = [
		`thread id          ${result.source.threadId}`,
		`codex home         ${result.codexHome}`,
		`rollout            ${result.installed.relativePath}`,
		`bytes              ${result.installed.bytes}`,
		`sha256             ${result.installed.sha256}`,
	];
	if (result.installed.backupPath) {
		lines.push(`backup             ${result.installed.backupPath}`);
	}
	if (result.installed.cwd) {
		lines.push(`cwd                ${result.installed.cwd}`);
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
	if (result.transplanted.cwd) {
		lines.push(`cwd                ${result.transplanted.cwd}`);
	}
	return `${lines.join("\n")}\n`;
}

async function copyVerifiedRollout(options: {
	sourcePath: string;
	targetCodexHome: string;
	relativePath: string;
	replace?: boolean;
	cwd?: string;
	verb: "Installed" | "Transplanted";
}): Promise<{ path: string; backupPath?: string; bytes: number; sha256: string; cwd?: string }> {
	const destinationPath = safeResolve(options.targetCodexHome, options.relativePath);
	if (path.resolve(options.sourcePath) === destinationPath) {
		throw new Error(`Source and target rollout are the same file: ${destinationPath}`);
	}
	const sourceInfo = await stat(options.sourcePath);
	const sourceSha256 = await sha256File(options.sourcePath);
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
	if (options.cwd) {
		await writeFile(destinationPath, await rewriteRolloutCwd(options.sourcePath, options.cwd));
	} else {
		await copyFile(options.sourcePath, destinationPath);
	}
	const copiedInfo = await stat(destinationPath);
	const copiedSha256 = await sha256File(destinationPath);
	if (!options.cwd) {
		if (copiedInfo.size !== sourceInfo.size) {
			throw new Error(`${options.verb} rollout byte length mismatch: ${options.relativePath}`);
		}
		if (copiedSha256 !== sourceSha256) {
			throw new Error(`${options.verb} rollout checksum mismatch: ${options.relativePath}`);
		}
	}
	const metadata = await readRolloutSessionMeta(destinationPath);
	if (options.cwd && metadata.cwd !== options.cwd) {
		throw new Error(`${options.verb} rollout cwd rewrite failed: ${options.relativePath}`);
	}
	return {
		path: destinationPath,
		bytes: copiedInfo.size,
		sha256: copiedSha256,
		...(metadata.cwd ? { cwd: metadata.cwd } : {}),
		...(backup ? { backupPath: backup } : {}),
	};
}

function transplantCwd(options: { cwd?: string; preserveCwd?: boolean }): string | undefined {
	if (options.preserveCwd) {
		return undefined;
	}
	return path.resolve(options.cwd ?? process.cwd());
}

async function rewriteRolloutCwd(filePath: string, cwd: string): Promise<string> {
	const text = await readFile(filePath, "utf8");
	const lines = text.split(/\n/);
	let rewrote = false;
	const rewritten = lines.map((line, index) => {
		if (rewrote || !line.trim()) {
			return line;
		}
		const prefix = index === 0 && line.charCodeAt(0) === 0xfeff ? "\ufeff" : "";
		const jsonText = prefix ? line.slice(1) : line;
		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonText) as unknown;
		} catch {
			return line;
		}
		const record = objectValue(parsed);
		if (record?.type !== "session_meta") {
			return line;
		}
		const payload = objectValue(record.payload) ?? {};
		record.payload = {
			...payload,
			cwd,
		};
		rewrote = true;
		return `${prefix}${JSON.stringify(record)}`;
	}).join("\n");
	if (!rewrote) {
		throw new Error(`Thread rollout does not contain a session_meta record: ${filePath}`);
	}
	return rewritten;
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
					parsed = JSON.parse(stripJsonBom(line)) as unknown;
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

function stripJsonBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function inspectRolloutPath(
	rolloutPath: string,
	codexHomeInput: string | undefined,
): Promise<ThreadRolloutInspection> {
	const filePath = path.resolve(rolloutPath);
	const info = await stat(filePath);
	if (!info.isFile()) {
		throw new Error(`Thread rollout is not a regular file: ${filePath}`);
	}
	const metadata = await readRolloutSessionMeta(filePath);
	const filenameThreadId = threadIdFromRolloutFilename(path.basename(filePath));
	const threadId = metadata.threadId ?? filenameThreadId;
	if (!threadId) {
		throw new Error(
			`Thread rollout does not contain a session_meta id and filename has no thread id: ${filePath}`,
		);
	}
	const codexHome = codexHomeInput ? resolveCodexHome(codexHomeInput) : undefined;
	const relativePath = codexHome && isInsideRoot(codexHome, filePath)
		? toManifestPath(path.relative(codexHome, filePath))
		: inferRolloutRelativePath(filePath);
	assertSafeRelativePath(relativePath);
	return {
		threadId,
		path: filePath,
		relativePath,
		bytes: info.size,
		sha256: await sha256File(filePath),
		...(metadata.cwd ? { cwd: metadata.cwd } : {}),
		matchedBy: metadata.threadId ? "session_meta" : "filename",
		...(codexHome ? { codexHome } : {}),
	};
}

function isPathLikeRolloutInput(input: string): boolean {
	return input.endsWith(".jsonl") || input.includes("/") || input.includes("\\");
}

async function isExistingFile(input: string): Promise<boolean> {
	try {
		return (await stat(path.resolve(input))).isFile();
	} catch {
		return false;
	}
}

function inferRolloutRelativePath(filePath: string): string {
	const normalized = filePath.split(/[\\/]+/);
	const sessionsIndex = normalized.lastIndexOf("sessions");
	if (sessionsIndex >= 0 && sessionsIndex < normalized.length - 1) {
		return normalized.slice(sessionsIndex).join("/");
	}
	const filename = path.basename(filePath);
	const match = rolloutFilenameDatePattern.exec(filename);
	if (!match) {
		throw new Error(`Cannot infer Codex sessions path from rollout filename: ${filename}`);
	}
	const [, year, month, day] = match;
	return `sessions/${year}/${month}/${day}/${filename}`;
}

function threadIdFromRolloutFilename(fileName: string): string | undefined {
	return rolloutFilenamePattern.exec(fileName)?.[1]?.toLowerCase();
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

function isInsideRoot(root: string, filePath: string): boolean {
	const rootPath = path.resolve(root);
	const resolved = path.resolve(filePath);
	return resolved === rootPath || resolved.startsWith(`${rootPath}${path.sep}`);
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
