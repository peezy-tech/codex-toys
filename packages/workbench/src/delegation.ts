import type { v2 } from "@codex-toys/bridge/generated";

export type WorkbenchDelegationReturnMode =
	| "detached"
	| "record_only"
	| "wake_on_done"
	| "wake_on_group"
	| "manual";

export type WorkbenchDelegationStatus =
	| "active"
	| "idle"
	| "failed"
	| "complete"
	| "reported";

export type WorkbenchDelegation = {
	id: string;
	codexThreadId: string;
	title: string;
	status: WorkbenchDelegationStatus;
	cwd?: string;
	workbenchKey?: string;
	groupId?: string;
	returnMode?: WorkbenchDelegationReturnMode;
	metadata?: Record<string, unknown>;
	lastTurnId?: string;
	lastStatus?: string;
	lastFinal?: string;
	completedAt?: string;
	injectedAt?: string;
	mirroredAt?: string;
	taskMirroredAt?: string;
	reportedAt?: string;
	createdAt: string;
	updatedAt: string;
};

export type WorkbenchPendingWake = {
	id: string;
	kind: "delegation" | "group";
	delegationIds: string[];
	groupId?: string;
	reason: string;
	createdAt: string;
	startedAt?: string;
};

export type WorkbenchDelegationAppServer = {
	startThread(params: v2.ThreadStartParams): Promise<v2.ThreadStartResponse>;
	resumeThread(params: v2.ThreadResumeParams): Promise<v2.ThreadResumeResponse>;
	setThreadName(params: v2.ThreadSetNameParams): Promise<v2.ThreadSetNameResponse>;
	startTurn(params: v2.TurnStartParams): Promise<v2.TurnStartResponse>;
	readThread(params: v2.ThreadReadParams): Promise<v2.ThreadReadResponse>;
};

export type WorkbenchDelegationState = {
	delegations: WorkbenchDelegation[];
	pendingWakes?: WorkbenchPendingWake[];
};

export type WorkbenchDelegationCapabilityOptions = {
	client: WorkbenchDelegationAppServer;
	state: WorkbenchDelegationState;
	now?: () => Date;
	threadStartParams(input: {
		cwd: string;
		args: Record<string, unknown>;
	}): v2.ThreadStartParams;
	threadResumeParams(input: {
		threadId: string;
		cwd?: string;
		args: Record<string, unknown>;
	}): v2.ThreadResumeParams;
	turnStartParams(input: {
		threadId: string;
		prompt: string;
		cwd?: string | null;
		args: Record<string, unknown>;
	}): v2.TurnStartParams;
	metadataFromArgs?: (args: Record<string, unknown>) => Record<string, unknown> | undefined;
	surfaceKeyForCwd?: (cwd?: string) => string | undefined;
	recordResult?: (delegation: WorkbenchDelegation) => Promise<void>;
	mirrorResult?: (delegation: WorkbenchDelegation) => Promise<void>;
	enqueueWake?: (input: {
		kind: WorkbenchPendingWake["kind"];
		delegationIds: string[];
		groupId?: string;
		reason: string;
	}) => void;
	processPendingWakes?: () => Promise<boolean>;
};

export class WorkbenchDelegationCapability {
	#client: WorkbenchDelegationAppServer;
	#state: WorkbenchDelegationState;
	#now: () => Date;
	#options: WorkbenchDelegationCapabilityOptions;

	constructor(options: WorkbenchDelegationCapabilityOptions) {
		this.#client = options.client;
		this.#state = options.state;
		this.#now = options.now ?? (() => new Date());
		this.#options = options;
	}

	list(): { delegations: WorkbenchDelegation[] } {
		return { delegations: this.#delegations() };
	}

	async start(args: Record<string, unknown>): Promise<{
		delegation: WorkbenchDelegation;
		turnId?: string;
	}> {
		const cwd = requiredArg(args, "cwd");
		const title = stringValue(args.title) ?? firstLine(stringValue(args.prompt)) ??
			`Delegated ${compactId(cwd)}`;
		const prompt = stringValue(args.prompt);
		const groupId = stringValue(args.groupId);
		const returnMode = returnModeFromArgs(
			args,
			groupId ? "wake_on_group" : "wake_on_done",
		);
		const started = await this.#client.startThread(this.#options.threadStartParams({
			cwd,
			args,
		}));
		const codexThreadId = started.thread.id;
		await this.#client.setThreadName({
			threadId: codexThreadId,
			name: `[delegated] ${title}`,
		});
		const now = this.#now().toISOString();
		const delegation = this.upsert({
			id: delegationId(codexThreadId),
			codexThreadId,
			title,
			status: prompt ? "active" : "idle",
			cwd,
			workbenchKey: this.#options.surfaceKeyForCwd?.(cwd),
			groupId,
			returnMode,
			metadata: this.#options.metadataFromArgs?.(args),
			createdAt: now,
			updatedAt: now,
		});
		let turnId: string | undefined;
		if (prompt) {
			const turn = await this.#client.startTurn(this.#options.turnStartParams({
				threadId: codexThreadId,
				prompt,
				cwd,
				args,
			}));
			turnId = turn.turn.id;
			delegation.lastTurnId = turnId;
		}
		return { delegation, turnId };
	}

	async resume(args: Record<string, unknown>): Promise<{ delegation: WorkbenchDelegation }> {
		const codexThreadId = requiredArg(args, "threadId");
		const cwd = stringValue(args.cwd);
		const groupId = stringValue(args.groupId);
		const resumed = await this.#client.resumeThread(
			this.#options.threadResumeParams({
				threadId: codexThreadId,
				cwd,
				args,
			}),
		);
		const now = this.#now().toISOString();
		const resolvedCwd = cwd ?? resumeResponseCwd(resumed);
		const existing = this.delegationForThread(codexThreadId);
		const delegation = this.upsert({
			id: stringValue(args.id) ?? delegationId(codexThreadId),
			codexThreadId,
			title: stringValue(args.title) ?? `Delegated ${compactId(codexThreadId)}`,
			status: "idle",
			cwd: resolvedCwd,
			workbenchKey: this.#options.surfaceKeyForCwd?.(resolvedCwd),
			groupId,
			returnMode: returnModeFromArgs(args, "manual"),
			metadata: this.#options.metadataFromArgs?.(args),
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		});
		return { delegation };
	}

	async send(args: Record<string, unknown>): Promise<{
		delegation: WorkbenchDelegation;
		turnId: string;
	}> {
		const delegation = this.requireDelegation(args);
		const prompt = requiredArg(args, "prompt");
		const groupId = stringValue(args.groupId);
		if (groupId) {
			delegation.groupId = groupId;
		}
		delegation.returnMode = returnModeFromArgs(
			args,
			delegation.returnMode ?? (delegation.groupId ? "wake_on_group" : "wake_on_done"),
		);
		const turn = await this.#client.startTurn(this.#options.turnStartParams({
			threadId: delegation.codexThreadId,
			prompt,
			cwd: delegation.cwd ?? null,
			args,
		}));
		delegation.status = "active";
		delegation.lastTurnId = turn.turn.id;
		delegation.lastStatus = undefined;
		delegation.lastFinal = undefined;
		delegation.completedAt = undefined;
		delegation.injectedAt = undefined;
		delegation.mirroredAt = undefined;
		delegation.taskMirroredAt = undefined;
		delegation.reportedAt = undefined;
		delegation.updatedAt = this.#now().toISOString();
		return { delegation, turnId: turn.turn.id };
	}

	async read(args: Record<string, unknown>): Promise<{
		delegation: WorkbenchDelegation;
		latestTurnId?: string;
		latestStatus?: string;
		lastFinal?: ThreadSnapshot["lastFinal"];
		terminalTurnIds: string[];
	}> {
		const delegation = this.requireDelegation(args);
		const response = await this.#client.readThread({
			threadId: delegation.codexThreadId,
			includeTurns: true,
		});
		const snapshot = threadSnapshotFromThread(response.thread);
		const turns = Array.isArray(response.thread.turns) ? response.thread.turns : [];
		const latest = record(turns[turns.length - 1]);
		const latestStatus = stringValue(latest.status);
		if (latestStatus === "completed") {
			delegation.status = "complete";
		} else if (latestStatus === "failed" || latestStatus === "interrupted") {
			delegation.status = "failed";
		} else if (latestStatus) {
			delegation.status = "active";
		}
		delegation.lastTurnId = stringValue(latest.id) ?? delegation.lastTurnId;
		delegation.lastStatus = latestStatus ?? delegation.lastStatus;
		delegation.lastFinal = snapshot.lastFinal?.text ?? delegation.lastFinal;
		if (latestStatus && isTerminalTurnStatus(latestStatus)) {
			delegation.completedAt ??= this.#now().toISOString();
		}
		delegation.updatedAt = this.#now().toISOString();
		return {
			delegation,
			latestTurnId: stringValue(latest.id),
			latestStatus,
			lastFinal: snapshot.lastFinal,
			terminalTurnIds: snapshot.terminalTurnIds,
		};
	}

	setPolicy(args: Record<string, unknown>): { delegations: WorkbenchDelegation[] } {
		const groupId = stringValue(args.groupId);
		const mode = returnModeFromArgs(args, undefined);
		if (!mode) {
			throw new Error("Missing required argument: returnMode");
		}
		const delegations = groupId
			? this.#delegations().filter((delegation) => delegation.groupId === groupId)
			: [this.requireDelegation(args)];
		if (delegations.length === 0) {
			throw new Error("No matching workbench delegations.");
		}
		const now = this.#now().toISOString();
		for (const delegation of delegations) {
			delegation.returnMode = mode;
			delegation.updatedAt = now;
		}
		return { delegations };
	}

	async flushResults(args: Record<string, unknown>): Promise<{ flushed: WorkbenchDelegation[] }> {
		const groupId = stringValue(args.groupId);
		const delegations = groupId
			? this.#delegations().filter((delegation) => delegation.groupId === groupId)
			: stringValue(args.delegationId) || stringValue(args.threadId) || stringValue(args.id)
			? [this.requireDelegation(args)]
			: this.#delegations();
		const flushed: WorkbenchDelegation[] = [];
		for (const delegation of delegations) {
			if (!isTerminalDelegation(delegation)) {
				continue;
			}
			await this.#options.recordResult?.(delegation);
			await this.#options.mirrorResult?.(delegation);
			flushed.push(delegation);
		}
		if (flushed.length > 0 && stringValue(args.wake) !== "false") {
			this.#options.enqueueWake?.({
				kind: groupId ? "group" : "delegation",
				groupId,
				delegationIds: flushed.map((delegation) => delegation.id),
				reason: groupId
					? `Delegation group ${groupId} was manually flushed.`
					: "Delegation results were manually flushed.",
			});
			await this.#options.processPendingWakes?.();
		}
		return { flushed };
	}

	listGroups(): Array<{
		groupId: string;
		total: number;
		active: number;
		terminal: number;
		pendingWake: boolean;
	}> {
		const groups = new Map<string, WorkbenchDelegation[]>();
		for (const delegation of this.#delegations()) {
			if (!delegation.groupId) {
				continue;
			}
			const existing = groups.get(delegation.groupId) ?? [];
			existing.push(delegation);
			groups.set(delegation.groupId, existing);
		}
		return [...groups.entries()].map(([groupId, delegations]) => ({
			groupId,
			total: delegations.length,
			active: delegations.filter((delegation) => delegation.status === "active").length,
			terminal: delegations.filter(isTerminalDelegation).length,
			pendingWake: (this.#state.pendingWakes ?? []).some((wake) =>
				wake.groupId === groupId && !wake.startedAt
			),
		}));
	}

	upsert(input: WorkbenchDelegation): WorkbenchDelegation {
		const delegations = this.#delegations();
		const index = delegations.findIndex((delegation) =>
			delegation.id === input.id ||
			delegation.codexThreadId === input.codexThreadId
		);
		if (index >= 0) {
			delegations[index] = { ...delegations[index], ...input };
			return delegations[index] as WorkbenchDelegation;
		}
		delegations.push(input);
		return input;
	}

	requireDelegation(args: Record<string, unknown>): WorkbenchDelegation {
		const id = stringValue(args.delegationId) ?? stringValue(args.id);
		const threadId = stringValue(args.threadId);
		const delegation = this.#delegations().find((candidate) =>
			(id && candidate.id === id) ||
			(threadId && candidate.codexThreadId === threadId)
		);
		if (!delegation) {
			throw new Error("Unknown workbench delegation.");
		}
		return delegation;
	}

	delegationForThread(threadId: string): WorkbenchDelegation | undefined {
		return this.#delegations().find((delegation) =>
			delegation.codexThreadId === threadId
		);
	}

	#delegations(): WorkbenchDelegation[] {
		this.#state.delegations ??= [];
		return this.#state.delegations;
	}
}

type ThreadSnapshot = {
	terminalTurnIds: string[];
	lastFinal?: {
		turnId: string;
		text: string;
	};
};

export function workbenchDelegationId(threadId: string): string {
	return delegationId(threadId);
}

export function returnModeFromArgs(
	args: Record<string, unknown>,
	fallback: WorkbenchDelegationReturnMode | undefined,
): WorkbenchDelegationReturnMode | undefined {
	const value = stringValue(args.returnMode) ?? stringValue(args.returnPolicy);
	if (!value) {
		return fallback;
	}
	if (value === "immediate") {
		return "wake_on_done";
	}
	if (value === "group_barrier") {
		return "wake_on_group";
	}
	if (
		value === "detached" ||
		value === "record_only" ||
		value === "wake_on_done" ||
		value === "wake_on_group" ||
		value === "manual"
	) {
		return value;
	}
	throw new Error(`Invalid returnMode: ${value}`);
}

export function isTerminalDelegation(delegation: WorkbenchDelegation): boolean {
	return delegation.status === "complete" ||
		delegation.status === "failed" ||
		delegation.status === "reported";
}

function threadSnapshotFromThread(thread: { turns?: unknown[] }): ThreadSnapshot {
	const turns = Array.isArray(thread.turns) ? thread.turns : [];
	const terminalTurnIds: string[] = [];
	let lastFinal: ThreadSnapshot["lastFinal"];
	for (const turn of turns) {
		const parsed = record(turn);
		const turnId = stringValue(parsed.id);
		if (turnId && isTerminalTurnStatus(parsed.status)) {
			terminalTurnIds.push(turnId);
		}
	}
	for (const turn of [...turns].reverse()) {
		const parsed = record(turn);
		const turnId = stringValue(parsed.id);
		const text = lastFinalTextFromTurn(parsed);
		if (turnId && text) {
			lastFinal = { turnId, text };
			break;
		}
	}
	if (lastFinal && !terminalTurnIds.includes(lastFinal.turnId)) {
		terminalTurnIds.push(lastFinal.turnId);
	}
	return {
		terminalTurnIds: [...new Set(terminalTurnIds)],
		lastFinal,
	};
}

function resumeResponseCwd(response: unknown): string | undefined {
	const responseRecord = record(response);
	return stringValue(responseRecord.cwd) ??
		stringValue(record(responseRecord.thread).cwd);
}

function lastFinalTextFromTurn(turn: Record<string, unknown>): string {
	const items = Array.isArray(turn.items) ? turn.items : [];
	for (const item of [...items].reverse()) {
		const candidate = record(item);
		if (
			candidate.type === "agentMessage" &&
			candidate.phase === "final_answer"
		) {
			return stringValue(candidate.text)?.trim() ?? "";
		}
	}
	return "";
}

function isTerminalTurnStatus(value: unknown): boolean {
	return value === "completed" || value === "failed" || value === "interrupted";
}

function requiredArg(args: Record<string, unknown>, name: string): string {
	const value = stringValue(args[name]);
	if (!value) {
		throw new Error(`Missing required argument: ${name}`);
	}
	return value;
}

function firstLine(value: string | undefined): string | undefined {
	const line = value?.split(/\r?\n/, 1)[0]?.trim();
	return line || undefined;
}

function compactId(value: string): string {
	return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}

function delegationId(threadId: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < threadId.length; index += 1) {
		hash ^= threadId.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `delegation-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
