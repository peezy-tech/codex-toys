import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
	DiscordWorkspaceHookEvent,
	DiscordWorkspaceHookEventName,
} from "./types.ts";

export type HookEventSpoolDisposition = "processed" | "ignored" | "failed";
export type StopHookSpoolDisposition = HookEventSpoolDisposition;

export type PendingHookEventSpoolFile =
	| {
			filePath: string;
			fileName: string;
			event: DiscordWorkspaceHookEvent;
	  }
	| {
			filePath: string;
			fileName: string;
			error: Error;
	  };
export type PendingStopHookSpoolFile = PendingHookEventSpoolFile;

export function defaultStopHookSpoolDir(): string {
	return path.join(os.homedir(), ".codex", "discord-bridge", "stop-hooks");
}

export function stopHookSpoolDirFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return env.CODEX_DISCORD_HOOK_SPOOL_DIR || defaultStopHookSpoolDir();
}

export function stopHookSpoolPaths(spoolDir: string): Record<
	"pending" | HookEventSpoolDisposition,
	string
> {
	const root = path.resolve(spoolDir);
	return {
		pending: path.join(root, "pending"),
		processed: path.join(root, "processed"),
		ignored: path.join(root, "ignored"),
		failed: path.join(root, "failed"),
	};
}

export async function ensureStopHookSpool(spoolDir: string): Promise<void> {
	const paths = stopHookSpoolPaths(spoolDir);
	await Promise.all(Object.values(paths).map((dir) => mkdir(dir, { recursive: true })));
}

export async function writeStopHookSpoolEvent(
	input: unknown,
	options: {
		spoolDir?: string;
		now?: () => Date;
	} = {},
): Promise<DiscordWorkspaceHookEvent> {
	return await writeHookSpoolEvent(input, options);
}

export async function writeHookSpoolEvent(
	input: unknown,
	options: {
		spoolDir?: string;
		now?: () => Date;
	} = {},
): Promise<DiscordWorkspaceHookEvent> {
	const spoolDir = options.spoolDir ?? stopHookSpoolDirFromEnv();
	const event = hookEventFromInput(input, options.now ?? (() => new Date()));
	const paths = stopHookSpoolPaths(spoolDir);
	await mkdir(paths.pending, { recursive: true });
	const fileName = `${event.id}.json`;
	const finalPath = path.join(paths.pending, fileName);
	const tempPath = path.join(
		paths.pending,
		`.${fileName}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
	);
	await writeFile(tempPath, `${JSON.stringify(event, null, 2)}\n`);
	await rename(tempPath, finalPath);
	return event;
}

export async function readPendingStopHookSpoolFiles(
	spoolDir: string,
): Promise<PendingHookEventSpoolFile[]> {
	const paths = stopHookSpoolPaths(spoolDir);
	await ensureStopHookSpool(spoolDir);
	const fileNames = (await readdir(paths.pending))
		.filter((fileName) => fileName.endsWith(".json"))
		.sort();
	const files: PendingHookEventSpoolFile[] = [];
	for (const fileName of fileNames) {
		const filePath = path.join(paths.pending, fileName);
		try {
			const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
			files.push({
				filePath,
				fileName,
				event: parseHookSpoolEvent(parsed),
			});
		} catch (error) {
			files.push({
				filePath,
				fileName,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		}
	}
	return files;
}

export async function archiveStopHookSpoolFile(
	file: Pick<PendingHookEventSpoolFile, "filePath" | "fileName">,
	spoolDir: string,
	disposition: HookEventSpoolDisposition,
): Promise<void> {
	const paths = stopHookSpoolPaths(spoolDir);
	await mkdir(paths[disposition], { recursive: true });
	const target = path.join(
		paths[disposition],
		`${Date.now()}-${randomUUID()}-${file.fileName}`,
	);
	try {
		await rename(file.filePath, target);
	} catch (error) {
		const code = error instanceof Error && "code" in error
			? String((error as NodeJS.ErrnoException).code)
			: "";
		if (code === "ENOENT") {
			return;
		}
		throw error;
	}
}

export async function removeStopHookSpool(spoolDir: string): Promise<void> {
	await rm(path.resolve(spoolDir), { recursive: true, force: true });
}

function hookEventFromInput(
	input: unknown,
	now: () => Date,
): DiscordWorkspaceHookEvent {
	const parsed = record(input);
	const eventName = stringValue(parsed.hook_event_name) ?? stringValue(parsed.eventName);
	if (!isHookEventName(eventName)) {
		throw new Error(`Unsupported hook event: ${eventName}`);
	}
	const sessionId = stringValue(parsed.session_id) ?? stringValue(parsed.sessionId);
	if (!sessionId) {
		throw new Error("Hook input is missing session_id");
	}
	const turnId = stringValue(parsed.turn_id) ?? stringValue(parsed.turnId);
	const transcriptPath =
		stringValue(parsed.transcript_path) ?? stringValue(parsed.transcriptPath);
	const cwd = stringValue(parsed.cwd);
	const model = stringValue(parsed.model);
	const source = stringValue(parsed.source);
	const toolName = stringValue(parsed.tool_name) ?? stringValue(parsed.toolName);
	const toolUseId = stringValue(parsed.tool_use_id) ?? stringValue(parsed.toolUseId);
	const toolInput = parsed.tool_input ?? parsed.toolInput;
	const toolResponse = parsed.tool_response ?? parsed.toolResponse;
	const lastAssistantMessage =
		nullableString(parsed.last_assistant_message) ??
		nullableString(parsed.lastAssistantMessage);
	const stopHookActive =
		typeof parsed.stop_hook_active === "boolean"
			? parsed.stop_hook_active
			: typeof parsed.stopHookActive === "boolean"
			? parsed.stopHookActive
			: undefined;
	const id = hookEventId({
		eventName,
		sessionId,
		turnId,
		transcriptPath,
		cwd,
		toolName,
		toolUseId,
		source,
	});
	return {
		version: 1,
		id,
		eventName,
		sessionId,
		turnId,
		cwd,
		transcriptPath,
		model,
		source,
		promptPreview: previewString(parsed.prompt),
		toolName,
		toolUseId,
		toolInputPreview: previewJson(toolInput),
		toolResponsePreview: previewJson(toolResponse),
		permissionDescription: nullableString(record(toolInput).description),
		lastAssistantMessage: eventName === "Stop" ? lastAssistantMessage : undefined,
		stopHookActive: eventName === "Stop" ? stopHookActive : undefined,
		createdAt: now().toISOString(),
	};
}

function parseHookSpoolEvent(input: unknown): DiscordWorkspaceHookEvent {
	const parsed = record(input);
	if (parsed.version !== 1) {
		throw new Error("Invalid hook event version");
	}
	const eventName = stringValue(parsed.eventName);
	const id = stringValue(parsed.id);
	const sessionId = stringValue(parsed.sessionId);
	const createdAt = stringValue(parsed.createdAt);
	if (!isHookEventName(eventName) || !id || !sessionId || !createdAt) {
		throw new Error("Invalid hook event");
	}
	return {
		version: 1,
		id,
		eventName,
		sessionId,
		turnId: stringValue(parsed.turnId),
		cwd: stringValue(parsed.cwd),
		transcriptPath: stringValue(parsed.transcriptPath),
		model: stringValue(parsed.model),
		source: stringValue(parsed.source),
		promptPreview: stringValue(parsed.promptPreview),
		toolName: stringValue(parsed.toolName),
		toolUseId: stringValue(parsed.toolUseId),
		toolInputPreview: stringValue(parsed.toolInputPreview),
		toolResponsePreview: stringValue(parsed.toolResponsePreview),
		permissionDescription: stringValue(parsed.permissionDescription),
		lastAssistantMessage: nullableString(parsed.lastAssistantMessage),
		stopHookActive: typeof parsed.stopHookActive === "boolean"
			? parsed.stopHookActive
			: undefined,
		createdAt,
	};
}

function hookEventId(input: {
	eventName: DiscordWorkspaceHookEventName;
	sessionId: string;
	turnId?: string;
	transcriptPath?: string;
	cwd?: string;
	toolName?: string;
	toolUseId?: string;
	source?: string;
}): string {
	const identity = input.turnId
		? {
				eventName: input.eventName,
				sessionId: input.sessionId,
				turnId: input.turnId,
				toolName: input.toolName,
				toolUseId: input.toolUseId,
			}
		: {
				eventName: input.eventName,
				sessionId: input.sessionId,
				source: input.source,
				transcriptPath: input.transcriptPath,
				cwd: input.cwd,
			};
	const prefix = input.eventName === "Stop" ? "stop" : "hook";
	return `${prefix}-${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24)}`;
}

function isHookEventName(value: unknown): value is DiscordWorkspaceHookEventName {
	return value === "SessionStart" ||
		value === "UserPromptSubmit" ||
		value === "PreToolUse" ||
		value === "PermissionRequest" ||
		value === "PostToolUse" ||
		value === "Stop";
}

function previewString(value: unknown, maxLength = 500): string | undefined {
	const parsed = nullableString(value);
	if (!parsed) {
		return undefined;
	}
	return parsed.length <= maxLength ? parsed : `${parsed.slice(0, maxLength - 3)}...`;
}

function previewJson(value: unknown, maxLength = 500): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return previewString(text, maxLength);
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
