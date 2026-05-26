import type { ReasoningEffort, v2 } from "@peezy.tech/codex-flows/generated";
import {
	CodexWorkspaceBackendClient,
	type CodexWorkspaceBackendClientOptions,
} from "@peezy.tech/codex-flows/workspace-backend";
import {
	finalTextFromTurn,
	type TurnCompletionContext,
} from "./announcements.ts";
import { cleanForSpeech, errorMessage, record, stringValue } from "./text.ts";
import type { AnnouncementPriority, Logger } from "./types.ts";

export type AnnouncerDecision = {
	speak: boolean;
	text: string;
	priority: AnnouncementPriority;
};

export type TurnAnnouncer = {
	polish(context: TurnCompletionContext): Promise<AnnouncerDecision>;
	ignoredThreadIds?(): Iterable<string>;
	close?(): void;
};

export type CodexTurnAnnouncerOptions = {
	workspaceBackendUrl: string;
	model: string;
	reasoningEffort: ReasoningEffort;
	timeoutMs: number;
	maxPhraseChars: number;
	cwd?: string | null;
	logger: Logger;
	clientOptions?: Partial<CodexWorkspaceBackendClientOptions>;
};

const announcerInstructions = [
	"You turn Codex workspace turn-completion data into one concise spoken announcement.",
	"Return only JSON matching the provided schema.",
	"Do not use markdown, bullets, code fences, URLs, stack traces, raw ids, or raw command logs.",
	"Prefer the practical outcome and next risk over implementation detail.",
	"Set speak=false when the turn has no meaningful user-facing update.",
].join("\n");

export class TemplateTurnAnnouncer implements TurnAnnouncer {
	async polish(context: TurnCompletionContext): Promise<AnnouncerDecision> {
		const prefix = context.status === "completed"
			? "Workspace turn completed."
			: `Workspace turn ${context.status}.`;
		const detail = context.errorMessage ?? context.finalText;
		return {
			speak: Boolean(detail || context.status !== "completed"),
			priority: context.status === "completed" ? "normal" : "high",
			text: cleanForSpeech(detail ? `${prefix} ${detail}` : prefix),
		};
	}
}

export class CodexTurnAnnouncer implements TurnAnnouncer {
	#workspaceBackendUrl: string;
	#model: string;
	#reasoningEffort: ReasoningEffort;
	#timeoutMs: number;
	#maxPhraseChars: number;
	#cwd: string | null;
	#logger: Logger;
	#clientOptions: Partial<CodexWorkspaceBackendClientOptions>;
	#client?: CodexWorkspaceBackendClient;
	#threadId?: string;

	constructor(options: CodexTurnAnnouncerOptions) {
		this.#workspaceBackendUrl = options.workspaceBackendUrl;
		this.#model = options.model;
		this.#reasoningEffort = options.reasoningEffort;
		this.#timeoutMs = options.timeoutMs;
		this.#maxPhraseChars = options.maxPhraseChars;
		this.#cwd = options.cwd ?? null;
		this.#logger = options.logger;
		this.#clientOptions = options.clientOptions ?? {};
	}

	ignoredThreadIds(): Iterable<string> {
		return this.#threadId ? [this.#threadId] : [];
	}

	async polish(context: TurnCompletionContext): Promise<AnnouncerDecision> {
		const client = await this.#ensureClient();
		const threadId = await this.#ensureThread();
		const prompt = JSON.stringify({
			task: "polish-workspace-voice-announcement",
			maxCharacters: this.#maxPhraseChars,
			turn: context,
		});
		const started = await client.startTurn({
			threadId,
			input: [{ type: "text", text: prompt, text_elements: [] }],
			model: this.#model,
			cwd: this.#cwd,
			approvalPolicy: "never",
			sandboxPolicy: { type: "readOnly", networkAccess: false },
			effort: this.#reasoningEffort,
			outputSchema: announcerOutputSchema(this.#maxPhraseChars),
		});
		const completedTurn = await waitForTurn(client, {
			threadId,
			turnId: started.turn.id,
			timeoutMs: this.#timeoutMs,
		});
		const text = finalTextFromTurn(completedTurn);
		const decision = parseAnnouncerDecision(text);
		if (!decision) {
			this.#logger.warn("announcer.invalidOutput", {
				threadId,
				turnId: started.turn.id,
			});
			return new TemplateTurnAnnouncer().polish(context);
		}
		return decision;
	}

	close(): void {
		this.#client?.close();
	}

	async #ensureClient(): Promise<CodexWorkspaceBackendClient> {
		if (this.#client) {
			return this.#client;
		}
		this.#client = new CodexWorkspaceBackendClient({
			...this.#clientOptions,
			webSocketTransportOptions: {
				url: this.#workspaceBackendUrl,
				requestTimeoutMs: this.#timeoutMs,
				...this.#clientOptions.webSocketTransportOptions,
			},
			clientName: "codex-workspace-voice-announcer",
			clientTitle: "Codex Workspace Voice Announcer",
			clientVersion: "0.1.0",
		});
		await this.#client.connect();
		return this.#client;
	}

	async #ensureThread(): Promise<string> {
		await this.#ensureClient();
		if (this.#threadId) {
			return this.#threadId;
		}
		if (!this.#client) {
			throw new Error("Announcer client is not initialized");
		}
		const response = await this.#client.startThread({
			model: this.#model,
			cwd: this.#cwd,
			approvalPolicy: "never",
			sandbox: "read-only",
			baseInstructions: announcerInstructions,
			ephemeral: true,
			environments: [],
			dynamicTools: [],
			experimentalRawEvents: false,
			persistExtendedHistory: false,
		});
		this.#threadId = response.thread.id;
		return this.#threadId;
	}
}

export function parseAnnouncerDecision(
	rawText: string,
): AnnouncerDecision | undefined {
	const parsed = parseJsonObject(rawText);
	if (!parsed) {
		return undefined;
	}
	const speak = parsed.speak;
	const text = stringValue(parsed.text);
	if (typeof speak !== "boolean" || !text) {
		return undefined;
	}
	return {
		speak,
		text: cleanForSpeech(text),
		priority: priorityValue(parsed.priority) ?? "normal",
	};
}

export function fallbackAnnouncerDecision(
	context: TurnCompletionContext,
	error: unknown,
	logger: Logger,
): AnnouncerDecision {
	logger.warn("announcer.failed", { error: errorMessage(error) });
	return {
		speak: true,
		priority: context.status === "completed" ? "normal" : "high",
		text: cleanForSpeech(
			context.errorMessage ||
				context.finalText ||
				`Workspace turn ${context.status}.`,
		),
	};
}

function announcerOutputSchema(
	maxPhraseChars: number,
): NonNullable<v2.TurnStartParams["outputSchema"]> {
	return {
		type: "object",
		additionalProperties: false,
		required: ["speak", "text"],
		properties: {
			speak: { type: "boolean" },
			priority: { type: "string", enum: ["low", "normal", "high"] },
			text: { type: "string", maxLength: maxPhraseChars },
		},
	};
}

async function waitForTurn(
	client: CodexWorkspaceBackendClient,
	options: {
		threadId: string;
		turnId: string;
		timeoutMs: number;
	},
): Promise<v2.Turn> {
	const startedAt = Date.now();
	while (true) {
		const response = await client.readThread({
			threadId: options.threadId,
			includeTurns: true,
		});
		const turn = response.thread.turns.find((entry) => entry.id === options.turnId);
		if (!turn) {
			throw new Error(`Announcer turn ${options.turnId} was not found`);
		}
		if (turn.status !== "inProgress") {
			if (turn.status === "failed") {
				throw new Error(turn.error?.message ?? `Announcer turn ${options.turnId} failed`);
			}
			return turn;
		}
		if (Date.now() - startedAt >= options.timeoutMs) {
			throw new Error(`Timed out waiting for announcer turn ${options.turnId}`);
		}
		await delay(Math.min(1000, Math.max(0, options.timeoutMs - (Date.now() - startedAt))));
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonObject(rawText: string): Record<string, unknown> | undefined {
	const trimmed = rawText.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		return record(JSON.parse(trimmed));
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start < 0 || end <= start) {
			return undefined;
		}
		try {
			return record(JSON.parse(trimmed.slice(start, end + 1)));
		} catch {
			return undefined;
		}
	}
}

function priorityValue(value: unknown): AnnouncementPriority | undefined {
	if (value === "low" || value === "normal" || value === "high") {
		return value;
	}
	return undefined;
}
