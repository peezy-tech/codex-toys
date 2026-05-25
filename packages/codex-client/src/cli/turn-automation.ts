import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TURN_AUTOMATION_RESULT_PREFIX = "TURN_AUTOMATION ";

export type TurnAutomationContext = {
	automation: {
		scriptPath: string;
		name?: string;
		manifestPath?: string;
	};
	runtime: {
		startedAt: string;
	};
	event?: unknown;
	prompt?: string;
	cwd?: string;
};

export type TurnAutomationSkipDecision = {
	action: "skip";
	reason?: string;
	artifacts?: unknown;
};

export type TurnAutomationTurnDecision = {
	action: "turn";
	prompt: string;
	threadId?: string;
	cwd?: string;
	model?: string;
	serviceTier?: string;
	permissions?: string;
	responsesapiClientMetadata?: Record<string, string>;
	outputSchema?: unknown;
	skills?: string[];
	artifacts?: unknown;
};

export type TurnAutomationDecision =
	| TurnAutomationSkipDecision
	| TurnAutomationTurnDecision;

export type TurnAutomationRun = {
	context: TurnAutomationContext;
	decision: TurnAutomationDecision;
	stdout: string;
	stderr: string;
};

export type RunTurnAutomationScriptOptions = {
	scriptPath: string;
	automation?: LoadedTurnAutomation;
	event?: unknown;
	prompt?: string;
	cwd?: string;
	timeoutMs: number;
	env?: Record<string, string | undefined>;
};

export async function runTurnAutomationScript(
	options: RunTurnAutomationScriptOptions,
): Promise<TurnAutomationRun> {
	const scriptPath = path.resolve(options.scriptPath);
	const context = turnAutomationContext({ ...options, scriptPath });
	const command = await nodeCommandPath(scriptPath);
	const subprocess = spawn(command[0] ?? process.execPath, command.slice(1), {
		cwd: options.automation?.root ?? process.cwd(),
		env: {
			...process.env,
			...options.env,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	subprocess.stdin.end(`${JSON.stringify(context, null, 2)}\n`);
	const timer = setTimeout(() => subprocess.kill("SIGTERM"), options.timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(subprocess.stdout),
		collectText(subprocess.stderr),
		exitCodeFor(subprocess),
	]).finally(() => clearTimeout(timer));
	if (exitCode !== 0) {
		throw new Error(`Turn automation script failed:\n${stderr || stdout}`);
	}
	return {
		context,
		decision: parseTurnAutomationDecision(stdout, options.prompt),
		stdout,
		stderr,
	};
}

export function parseTurnAutomationDecision(
	stdout: string,
	fallbackPrompt?: string,
): TurnAutomationDecision {
	const parsed = parsePrefixedResult(stdout) ?? parseJsonOnlyResult(stdout);
	return normalizeTurnAutomationDecision(parsed, fallbackPrompt);
}

export function formatTurnAutomationRun(run: TurnAutomationRun & {
	turn?: TurnAutomationStartedTurn;
}): string {
	if (run.decision.action === "skip") {
		return [
			"automation action   skip",
			`reason              ${run.decision.reason ?? "none"}`,
		].join("\n") + "\n";
	}
	return [
		"automation action   turn",
		`prompt              ${preview(run.decision.prompt)}`,
		run.decision.cwd ? `cwd                 ${run.decision.cwd}` : undefined,
		run.decision.threadId ? `requested thread    ${run.decision.threadId}` : undefined,
		run.decision.skills?.length
			? `skills requested    ${run.decision.skills.join(", ")}`
			: undefined,
		run.turn ? `turn surface        ${run.turn.via}` : undefined,
		run.turn ? `thread id           ${run.turn.threadId}` : undefined,
		run.turn ? `turn id             ${run.turn.turnId}` : undefined,
	].filter(Boolean).join("\n") + "\n";
}

export type TurnAutomationStartedTurn = {
	via: "workspace" | "app-server";
	threadId: string;
	turnId: string;
	thread: unknown;
	turn: unknown;
};

export type TurnAutomationManifest = {
	name?: string;
	description?: string;
	script: string;
	prompt?: string;
	promptFile?: string;
	cwd?: string;
	skills?: string[];
};

export type LoadedTurnAutomation = {
	name: string;
	root: string;
	manifestPath: string;
	manifest: TurnAutomationManifest;
	scriptPath: string;
	prompt?: string;
	cwd?: string;
	skills?: string[];
};

export type TurnAutomationRunTarget = {
	scriptPath: string;
	automation?: LoadedTurnAutomation;
	prompt?: string;
	cwd?: string;
	skills?: string[];
};

export type ListTurnAutomationsOptions = {
	cwd?: string;
	roots?: string[];
};

export async function listTurnAutomations(
	options: ListTurnAutomationsOptions = {},
): Promise<LoadedTurnAutomation[]> {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const roots = options.roots?.map((root) => path.resolve(cwd, root)) ??
		[
			path.join(cwd, ".codex", "automations"),
			path.join(cwd, "automations"),
		];
	const loaded: LoadedTurnAutomation[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		for (const manifestPath of await automationManifestPaths(root)) {
			const automation = await loadTurnAutomationManifest(manifestPath);
			if (seen.has(automation.name)) {
				continue;
			}
			seen.add(automation.name);
			loaded.push(automation);
		}
	}
	return loaded.sort((left, right) => left.name.localeCompare(right.name));
}

export async function resolveTurnAutomationTarget(
	target: string,
	options: ListTurnAutomationsOptions = {},
): Promise<TurnAutomationRunTarget> {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const resolved = path.resolve(cwd, target);
	if (await isFile(resolved)) {
		return { scriptPath: resolved };
	}
	const directoryManifest = path.join(resolved, "automation.json");
	if (await isFile(directoryManifest)) {
		const automation = await loadTurnAutomationManifest(directoryManifest);
		return targetFromAutomation(automation);
	}
	const automations = await listTurnAutomations({ ...options, cwd });
	const automation = automations.find((entry) => entry.name === target);
	if (!automation) {
		throw new Error(`No turn automation named ${JSON.stringify(target)} was found`);
	}
	return targetFromAutomation(automation);
}

export function applyTurnAutomationDefaults(
	decision: TurnAutomationDecision,
	defaults: {
		prompt?: string;
		cwd?: string;
		skills?: string[];
	},
): TurnAutomationDecision {
	if (decision.action === "skip") {
		return decision;
	}
	const prompt = decision.prompt || defaults.prompt;
	if (!prompt) {
		throw new Error("turn automation prompt must be a non-empty string");
	}
	return compactUndefined({
		...decision,
		prompt,
		cwd: decision.cwd ?? defaults.cwd,
		skills: decision.skills ?? defaults.skills,
	});
}

export function formatTurnAutomationList(
	automations: LoadedTurnAutomation[],
): string {
	if (automations.length === 0) {
		return "No turn automations found.\n";
	}
	return automations.map((automation) => {
		const description = automation.manifest.description
			? ` - ${automation.manifest.description}`
			: "";
		return `${automation.name}${description}`;
	}).join("\n") + "\n";
}

function turnAutomationContext(
	options: RunTurnAutomationScriptOptions & {
		scriptPath: string;
		automation?: LoadedTurnAutomation;
	},
): TurnAutomationContext {
	return compactUndefined({
		automation: {
			scriptPath: options.scriptPath,
			name: options.automation?.name,
			manifestPath: options.automation?.manifestPath,
		},
		runtime: {
			startedAt: new Date().toISOString(),
		},
		event: options.event,
		prompt: options.prompt,
		cwd: options.cwd,
	});
}

async function automationManifestPaths(root: string): Promise<string[]> {
	if (!await isDirectory(root)) {
		return [];
	}
	const entries = await readdir(root, { withFileTypes: true });
	const manifests: string[] = [];
	for (const entry of entries) {
		if (entry.isDirectory()) {
			const manifestPath = path.join(root, entry.name, "automation.json");
			if (await isFile(manifestPath)) {
				manifests.push(manifestPath);
			}
		}
	}
	return manifests.sort();
}

async function loadTurnAutomationManifest(
	manifestPath: string,
): Promise<LoadedTurnAutomation> {
	const root = path.dirname(manifestPath);
	const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`Turn automation manifest must be an object: ${manifestPath}`);
	}
	const script = optionalString(parsed.script);
	if (!script) {
		throw new Error(`Turn automation manifest requires script: ${manifestPath}`);
	}
	const name = optionalString(parsed.name) ?? path.basename(root);
	const manifest = compactUndefined({
		name,
		description: optionalString(parsed.description),
		script,
		prompt: optionalString(parsed.prompt),
		promptFile: optionalString(parsed.promptFile),
		cwd: optionalString(parsed.cwd),
		skills: stringArray(parsed.skills),
	});
	const prompt = manifest.promptFile
		? await readFile(path.resolve(root, manifest.promptFile), "utf8")
		: manifest.prompt;
	return compactUndefined({
		name,
		root,
		manifestPath,
		manifest,
		scriptPath: path.resolve(root, script),
		prompt,
		cwd: manifest.cwd ? resolveMaybeRelative(root, manifest.cwd) : undefined,
		skills: manifest.skills,
	});
}

function targetFromAutomation(
	automation: LoadedTurnAutomation,
): TurnAutomationRunTarget {
	return compactUndefined({
		scriptPath: automation.scriptPath,
		automation,
		prompt: automation.prompt,
		cwd: automation.cwd,
		skills: automation.skills,
	});
}

async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}

async function isDirectory(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isDirectory();
	} catch {
		return false;
	}
}

function resolveMaybeRelative(root: string, value: string): string {
	return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function parsePrefixedResult(stdout: string): unknown {
	for (const line of stdout.split(/\r?\n/).reverse()) {
		const index = line.indexOf(TURN_AUTOMATION_RESULT_PREFIX);
		if (index === -1) {
			continue;
		}
		return JSON.parse(line.slice(index + TURN_AUTOMATION_RESULT_PREFIX.length).trim());
	}
	return undefined;
}

function parseJsonOnlyResult(stdout: string): unknown {
	const text = stdout.trim();
	if (!text.startsWith("{")) {
		throw new Error(`Script did not emit ${TURN_AUTOMATION_RESULT_PREFIX.trim()}`);
	}
	return JSON.parse(text);
}

function normalizeTurnAutomationDecision(
	value: unknown,
	fallbackPrompt?: string,
): TurnAutomationDecision {
	if (!isRecord(value)) {
		throw new Error("Turn automation result must be a JSON object");
	}
	if (value.action === "skip") {
		return compactUndefined({
			action: "skip",
			reason: optionalString(value.reason),
			artifacts: value.artifacts,
		});
	}
	if (value.action !== "turn") {
		throw new Error("Turn automation action must be skip or turn");
	}
	const prompt = optionalString(value.prompt) ?? fallbackPrompt;
	if (!prompt) {
		throw new Error("turn automation prompt must be a non-empty string");
	}
	return compactUndefined({
		action: "turn",
		prompt,
		threadId: optionalString(value.threadId),
		cwd: optionalString(value.cwd),
		model: optionalString(value.model),
		serviceTier: optionalString(value.serviceTier),
		permissions: optionalString(value.permissions),
		responsesapiClientMetadata: stringRecord(value.responsesapiClientMetadata),
		outputSchema: value.outputSchema,
		skills: stringArray(value.skills),
		artifacts: value.artifacts,
	});
}

async function nodeCommandPath(scriptPath: string): Promise<string[]> {
	const tsxLoader = import.meta.resolve("tsx");
	if (await isModuleStyleScript(scriptPath)) {
		return [
			process.execPath,
			"--import",
			tsxLoader,
			siblingRuntimePath("turn-automation-module-runner"),
			scriptPath,
		];
	}
	return [process.execPath, "--import", tsxLoader, scriptPath];
}

async function isModuleStyleScript(scriptPath: string): Promise<boolean> {
	const source = await readFile(scriptPath, "utf8");
	return /\bexport\s+default\b/.test(source);
}

function siblingRuntimePath(basename: string): string {
	const currentPath = fileURLToPath(import.meta.url);
	const extension = path.extname(currentPath) || ".ts";
	return path.join(path.dirname(currentPath), `${basename}${extension}`);
}

async function collectText(stream: NodeJS.ReadableStream | null): Promise<string> {
	let output = "";
	if (!stream) {
		return output;
	}
	for await (const chunk of stream) {
		output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
	}
	return output;
}

function exitCodeFor(subprocess: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		subprocess.once("error", reject);
		subprocess.once("exit", (code) => resolve(code));
	});
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const entries = Object.entries(value).filter((entry): entry is [string, string] =>
		typeof entry[1] === "string"
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const entries = value.filter((entry): entry is string =>
		typeof entry === "string" && entry.length > 0
	);
	return entries.length > 0 ? entries : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactUndefined<T extends Record<string, unknown>>(value: T): T {
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			result[key] = entry;
		}
	}
	return result as T;
}

function preview(value: string): string {
	return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}
