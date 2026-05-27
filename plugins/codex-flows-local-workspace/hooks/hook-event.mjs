#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const hookEventNames = new Set([
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PostToolUse",
	"Stop",
]);

async function main() {
	let input = "";
	try {
		input = await readStdinText();
		const event = hookEventFromInput(JSON.parse(input), () => new Date());
		await writeHookSpoolEvent(event);
		if (eventSupportsContinueOutput(event.eventName)) {
			process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
		}
	} catch (error) {
		process.stderr.write(`codex-flows plugin hook failed: ${errorMessage(error)}\n`);
		if (eventSupportsContinueOutput(eventNameFromHookInput(input))) {
			process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
		}
	}
}

async function readStdinText() {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function writeHookSpoolEvent(event) {
	const paths = hookSpoolPaths(hookSpoolDirFromEnv());
	await mkdir(paths.pending, { recursive: true });
	const fileName = `${event.id}.json`;
	const finalPath = path.join(paths.pending, fileName);
	const tempPath = path.join(
		paths.pending,
		`.${fileName}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
	);
	await writeFile(tempPath, `${JSON.stringify(event, null, 2)}\n`);
	await rename(tempPath, finalPath);
}

function hookSpoolDirFromEnv(env = process.env) {
	return env.CODEX_FLOWS_HOOK_SPOOL_DIR ||
		path.join(os.homedir(), ".codex", "codex-flows", "hook-spool");
}

function hookSpoolPaths(spoolDir) {
	const root = path.resolve(spoolDir);
	return {
		pending: path.join(root, "pending"),
		processed: path.join(root, "processed"),
		ignored: path.join(root, "ignored"),
		failed: path.join(root, "failed"),
	};
}

function hookEventFromInput(input, now) {
	const parsed = record(input);
	const eventName = stringValue(parsed.hook_event_name) ?? stringValue(parsed.eventName);
	if (!hookEventNames.has(eventName)) {
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

	return {
		version: 1,
		id: hookEventId({
			eventName,
			sessionId,
			turnId,
			transcriptPath,
			cwd,
			toolName,
			toolUseId,
			source,
		}),
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

function hookEventId(input) {
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

function eventSupportsContinueOutput(eventName) {
	return eventName === "SessionStart" ||
		eventName === "UserPromptSubmit" ||
		eventName === "Stop";
}

function eventNameFromHookInput(input) {
	try {
		const parsed = record(JSON.parse(input));
		return stringValue(parsed.hook_event_name) ?? stringValue(parsed.eventName);
	} catch {
		return undefined;
	}
}

function previewString(value, maxLength = 500) {
	const parsed = nullableString(value);
	if (!parsed) {
		return undefined;
	}
	return parsed.length <= maxLength ? parsed : `${parsed.slice(0, maxLength - 3)}...`;
}

function previewJson(value, maxLength = 500) {
	if (value === undefined || value === null) {
		return undefined;
	}
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return previewString(text, maxLength);
}

function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value
		: {};
}

function stringValue(value) {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableString(value) {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

await main();
