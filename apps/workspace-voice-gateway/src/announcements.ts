import type { v2 } from "@peezy.tech/codex-flows/generated";
import type { JsonRpcNotification } from "@peezy.tech/codex-flows/rpc";
import type { WorkspaceBackendEvent } from "@peezy.tech/codex-flows/workspace-backend";
import { cleanForSpeech, record, stringValue } from "./text.ts";
import type { AnnouncementPriority, VoiceAnnouncement } from "./types.ts";

export type AnnouncementPolicy = {
	announceBackendConnected: boolean;
	announceTurnStarted: boolean;
	ignoredThreadIds?: ReadonlySet<string>;
};

export type TurnCompletionContext = {
	threadId: string;
	turnId: string;
	status: v2.TurnStatus;
	durationMs: number | null;
	finalText: string;
	errorMessage: string | null;
};

export type AnnouncementDraft = VoiceAnnouncement & {
	kind:
		| "backend.connected"
		| "backend.error"
		| "backend.closed"
		| "turn.started"
		| "turn.completed"
		| "hook.completed"
		| "warning"
		| "error";
	turnCompletion?: TurnCompletionContext;
};

export function draftFromWorkspaceEvent(
	event: WorkspaceBackendEvent,
	policy: AnnouncementPolicy,
): AnnouncementDraft | undefined {
	if (event.type === "connected") {
		if (!policy.announceBackendConnected) {
			return undefined;
		}
		return draft({
			id: `backend:connected:${event.at}`,
			kind: "backend.connected",
			source: "workspace-backend",
			priority: "low",
			text: "Workspace backend connected.",
			policy,
		});
	}
	if (event.type === "appServer.connected") {
		return draft({
			id: `app-server:connected:${event.at}`,
			kind: "backend.connected",
			source: "workspace-backend",
			priority: "low",
			text: "Codex app server connected.",
			policy,
		});
	}
	if (event.type === "appServer.closed") {
		const reason = event.reason ? ` Reason: ${event.reason}.` : "";
		return draft({
			id: `app-server:closed:${event.at}`,
			kind: "backend.closed",
			source: "workspace-backend",
			priority: "high",
			text: `Codex app server disconnected.${reason}`,
			policy,
		});
	}
	if (event.type === "appServer.error") {
		return draft({
			id: `app-server:error:${event.at}:${event.message}`,
			kind: "backend.error",
			source: "workspace-backend",
			priority: "high",
			text: `Codex app server error: ${event.message}`,
			policy,
		});
	}
	if (event.type === "unsupportedWorkspaceBackendMethod") {
		return undefined;
	}
	return undefined;
}

export function draftFromNotification(
	message: JsonRpcNotification,
	policy: AnnouncementPolicy,
): AnnouncementDraft | undefined {
	const params = record(message.params);
	const threadId = stringValue(params.threadId);
	if (threadId && policy.ignoredThreadIds?.has(threadId)) {
		return undefined;
	}

	if (message.method === "turn/started") {
		if (!policy.announceTurnStarted) {
			return undefined;
		}
		const turn = record(params.turn);
		const turnId = stringValue(turn.id);
		if (!threadId || !turnId) {
			return undefined;
		}
		return draft({
			id: `turn:started:${threadId}:${turnId}`,
			kind: "turn.started",
			source: "app-server",
			priority: "low",
			text: "Workspace turn started.",
			policy,
		});
	}

	if (message.method === "turn/completed") {
		const context = turnCompletionContext(message);
		if (!context) {
			return undefined;
		}
		const statusText = context.status === "completed"
			? "Workspace turn completed."
			: `Workspace turn ${context.status}.`;
		const detail = context.errorMessage ?? context.finalText;
		const text = detail ? `${statusText} ${detail}` : statusText;
		return {
			...draft({
				id: `turn:completed:${context.threadId}:${context.turnId}:${context.status}`,
				kind: "turn.completed",
				source: "app-server",
				priority: context.status === "completed" ? "normal" : "high",
				text,
				policy,
			}),
			turnCompletion: context,
		};
	}

	if (message.method === "hook/completed") {
		const run = record(params.run);
		const status = stringValue(run.status);
		if (!threadId || !status || status === "completed") {
			return undefined;
		}
		const eventName = stringValue(run.eventName) ?? "hook";
		const statusMessage = stringValue(run.statusMessage);
		return draft({
			id: `hook:${threadId}:${stringValue(run.id) ?? eventName}:${status}`,
			kind: "hook.completed",
			source: "app-server",
			priority: "high",
			text: `Codex ${eventName} hook ${status}.${statusMessage ? ` ${statusMessage}` : ""}`,
			policy,
		});
	}

	if (message.method === "error") {
		const error = record(params.error);
		const messageText = stringValue(error.message) ?? "Unknown error.";
		const turnId = stringValue(params.turnId) ?? "unknown";
		return draft({
			id: `error:${threadId ?? "global"}:${turnId}:${messageText}`,
			kind: "error",
			source: "app-server",
			priority: "high",
			text: `Codex turn error: ${messageText}`,
			policy,
		});
	}

	if (
		message.method === "warning" ||
		message.method === "configWarning" ||
		message.method === "guardianWarning"
	) {
		const messageText = stringValue(params.message);
		if (!messageText) {
			return undefined;
		}
		return draft({
			id: `warning:${threadId ?? "global"}:${message.method}:${messageText}`,
			kind: "warning",
			source: "app-server",
			priority: "normal",
			text: messageText,
			policy,
		});
	}

	return undefined;
}

export function turnCompletionContext(
	message: JsonRpcNotification,
): TurnCompletionContext | undefined {
	if (message.method !== "turn/completed") {
		return undefined;
	}
	const params = record(message.params);
	const threadId = stringValue(params.threadId);
	const turn = record(params.turn);
	const turnId = stringValue(turn.id);
	const status = turnStatusValue(turn.status);
	if (!threadId || !turnId || !status) {
		return undefined;
	}
	return {
		threadId,
		turnId,
		status,
		durationMs: numberValue(turn.durationMs),
		finalText: finalTextFromTurn(turn),
		errorMessage: turnErrorMessage(turn),
	};
}

export function finalTextFromTurn(turn: Partial<v2.Turn> | Record<string, unknown>): string {
	const items = Array.isArray(turn.items) ? turn.items : [];
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = record(items[index]);
		if (item.type !== "agentMessage") {
			continue;
		}
		if (item.phase === "commentary") {
			continue;
		}
		const text = stringValue(item.text);
		if (text) {
			return text;
		}
	}
	return "";
}

function draft(input: {
	id: string;
	kind: AnnouncementDraft["kind"];
	source: string;
	priority: AnnouncementPriority;
	text: string;
	policy: AnnouncementPolicy;
}): AnnouncementDraft {
	return {
		id: input.id,
		kind: input.kind,
		source: input.source,
		priority: input.priority,
		text: cleanForSpeech(input.text),
	};
}

function turnStatusValue(value: unknown): v2.TurnStatus | undefined {
	if (
		value === "completed" ||
		value === "interrupted" ||
		value === "failed" ||
		value === "inProgress"
	) {
		return value;
	}
	return undefined;
}

function turnErrorMessage(turn: Record<string, unknown>): string | null {
	const error = record(turn.error);
	return stringValue(error.message) ?? null;
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
