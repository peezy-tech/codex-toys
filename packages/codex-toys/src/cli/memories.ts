import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { discoverWorkbenchRoot } from "@codex-toys/workbench";

export type MemoryTransplantDirection = "global-to-workbench" | "workbench-to-global";

export type MemoryTransplantOptions = {
	direction: MemoryTransplantDirection;
	workbenchRoot?: string;
	globalCodexHome?: string;
	workbenchCodexHome?: string;
	apply?: boolean;
	overwrite?: boolean;
	merge?: "codex";
	backup?: boolean;
};

export type MemoryTransplantPlan = {
	direction: MemoryTransplantDirection;
	apply: boolean;
	source: string;
	destination: string;
	filesToAdd: MemoryFilePlan[];
	conflicts: MemoryFilePlan[];
	skipped: MemorySkippedFile[];
	estimatedBytes: number;
};

export type MemoryFilePlan = {
	relativePath: string;
	sourcePath: string;
	destinationPath: string;
	bytes: number;
	action: "copy" | "overwrite" | "merge";
	backupPath?: string;
};

export type MemorySkippedFile = {
	relativePath: string;
	sourcePath: string;
	reason: string;
};

const mergeableFiles = new Set(["MEMORY.md", "memory_summary.md"]);
const rootMemoryArtifacts = new Set([...mergeableFiles, "raw_memories.md"]);
const skippedMemoryDirectories = new Set([
	".git",
	"auth",
	"extensions",
	"logs",
	"sessions",
	"skills",
]);

export async function planMemoryTransplant(
	options: MemoryTransplantOptions,
): Promise<MemoryTransplantPlan> {
	const workbenchRoot = path.resolve(options.workbenchRoot ?? await discoverWorkbenchRoot());
	const globalHome = path.resolve(options.globalCodexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
	const workbenchHome = path.resolve(options.workbenchCodexHome ?? path.join(workbenchRoot, ".codex"));
	const sourceHome = options.direction === "global-to-workbench" ? globalHome : workbenchHome;
	const destinationHome = options.direction === "global-to-workbench" ? workbenchHome : globalHome;
	const source = path.join(sourceHome, "memories");
	const destination = path.join(destinationHome, "memories");
	const filesToAdd: MemoryFilePlan[] = [];
	const conflicts: MemoryFilePlan[] = [];
	const skipped: MemorySkippedFile[] = [];
	for (const file of await listMemoryFiles(source)) {
		const sourcePath = path.join(source, file);
		if (shouldSkipMemoryFile(file)) {
			skipped.push({ relativePath: file, sourcePath, reason: "excluded non-memory or unsafe Codex home file" });
			continue;
		}
		const size = (await stat(sourcePath)).size;
		const destinationPath = path.join(destination, file);
		const destinationExists = await exists(destinationPath);
		if (!destinationExists) {
			filesToAdd.push({ relativePath: file, sourcePath, destinationPath, bytes: size, action: "copy" });
			continue;
		}
		if (options.merge === "codex" && mergeableFiles.has(file)) {
			conflicts.push({ relativePath: file, sourcePath, destinationPath, bytes: size, action: "merge", backupPath: backupPath(destinationPath) });
		} else if (options.overwrite) {
			conflicts.push({ relativePath: file, sourcePath, destinationPath, bytes: size, action: "overwrite", backupPath: backupPath(destinationPath) });
		} else {
			conflicts.push({ relativePath: file, sourcePath, destinationPath, bytes: size, action: "copy" });
		}
	}
	return {
		direction: options.direction,
		apply: options.apply ?? false,
		source,
		destination,
		filesToAdd,
		conflicts,
		skipped,
		estimatedBytes: [...filesToAdd, ...conflicts].reduce((sum, item) => sum + item.bytes, 0),
	};
}

export async function applyMemoryTransplant(
	options: MemoryTransplantOptions,
): Promise<MemoryTransplantPlan> {
	const plan = await planMemoryTransplant(options);
	if (!options.apply) {
		return plan;
	}
	await mkdir(plan.destination, { recursive: true });
	for (const file of plan.filesToAdd) {
		await mkdir(path.dirname(file.destinationPath), { recursive: true });
		await copyFile(file.sourcePath, file.destinationPath);
	}
	for (const file of plan.conflicts) {
		if (file.action === "copy") {
			continue;
		}
		await mkdir(path.dirname(file.destinationPath), { recursive: true });
		if (options.backup ?? true) {
			const backup = file.backupPath ?? backupPath(file.destinationPath);
			await mkdir(path.dirname(backup), { recursive: true });
			await copyFile(file.destinationPath, backup);
		}
		if (file.action === "overwrite") {
			await copyFile(file.sourcePath, file.destinationPath);
		} else {
			await mergeMemoryFile(file.sourcePath, file.destinationPath);
		}
	}
	return plan;
}

export function formatMemoryTransplantPlan(plan: MemoryTransplantPlan): string {
	const lines = [
		`direction             ${plan.direction}`,
		`mode                  ${plan.apply ? "apply" : "dry-run"}`,
		`source                ${plan.source}`,
		`destination           ${plan.destination}`,
		`files to add          ${plan.filesToAdd.length}`,
		`conflicts             ${plan.conflicts.length}`,
		`skipped               ${plan.skipped.length}`,
		`estimated bytes       ${plan.estimatedBytes}`,
	];
	for (const file of plan.filesToAdd) {
		lines.push(`add                   ${file.relativePath} (${file.bytes} bytes)`);
	}
	for (const file of plan.conflicts) {
		lines.push(`conflict              ${file.relativePath} (${file.action})`);
	}
	for (const file of plan.skipped) {
		lines.push(`skip                  ${file.relativePath} (${file.reason})`);
	}
	return `${lines.join("\n")}\n`;
}

async function listMemoryFiles(root: string, prefix = ""): Promise<string[]> {
	let entries: string[];
	try {
		entries = await readdir(path.join(root, prefix));
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const relative = prefix ? path.join(prefix, entry) : entry;
		if (shouldSkipMemoryDirectory(relative)) {
			continue;
		}
		const full = path.join(root, relative);
		const info = await stat(full);
		if (info.isDirectory()) {
			files.push(...await listMemoryFiles(root, relative));
		} else if (info.isFile()) {
			files.push(relative);
		}
	}
	return files.sort();
}

function shouldSkipMemoryFile(relativePath: string): boolean {
	const normalized = relativePath.split(path.sep).join("/");
	if (!isAllowedMemoryArtifact(normalized)) {
		return true;
	}
	if (/\.backup-\d{4}-\d{2}-\d{2}T/.test(normalized)) {
		return true;
	}
	if (normalized.endsWith(".sqlite") || normalized.endsWith(".sqlite3") || normalized.endsWith(".db")) {
		return true;
	}
	if (/(^|\/)(auth|sessions|logs|skills)(\/|$)/.test(normalized)) {
		return true;
	}
	return false;
}

function shouldSkipMemoryDirectory(relativePath: string): boolean {
	const normalized = relativePath.split(path.sep).join("/");
	return normalized.split("/").some((segment) => skippedMemoryDirectories.has(segment));
}

function isAllowedMemoryArtifact(normalizedPath: string): boolean {
	if (rootMemoryArtifacts.has(normalizedPath)) {
		return true;
	}
	return normalizedPath.startsWith("rollout_summaries/") && normalizedPath.endsWith(".md");
}

async function mergeMemoryFile(sourcePath: string, destinationPath: string): Promise<void> {
	const [source, destination] = await Promise.all([
		readFile(sourcePath, "utf8"),
		readFile(destinationPath, "utf8"),
	]);
	const prompt = [
		"Merge these Codex memory files. Preserve durable facts, remove duplicates, and output only the merged markdown.",
		"",
		"--- destination ---",
		destination,
		"",
		"--- source ---",
		source,
	].join("\n");
	const proc = spawn(process.env.CODEX_APP_SERVER_CODEX_COMMAND ?? "codex", ["exec", prompt]);
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(proc.stdout),
		collectText(proc.stderr),
		exitCodeFor(proc),
	]);
	if (exitCode !== 0) {
		throw new Error(`Codex memory merge failed (${exitCode}): ${stderr || stdout}`);
	}
	await writeFile(destinationPath, stdout.trimEnd() + "\n");
}

async function exists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
}

function collectText(stream: NodeJS.ReadableStream | null): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = "";
		if (!stream) {
			resolve(output);
			return;
		}
		stream.setEncoding("utf8");
		stream.on("data", (chunk: string) => {
			output += chunk;
		});
		stream.once("error", reject);
		stream.once("end", () => resolve(output));
	});
}

function exitCodeFor(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
}

function backupPath(file: string): string {
	return `${file}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}
