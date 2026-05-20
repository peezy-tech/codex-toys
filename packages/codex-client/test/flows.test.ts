import { expect, test } from "vite-plus/test";
import type { v2 } from "../src/app-server/generated/index.ts";
import {
	CodexFlowClient,
	CodexFlowTimeoutError,
	CodexFlowTurnFailedError,
	toCodexUserInput,
	type CodexFlowAppServerClient,
} from "../src/app-server/flows.ts";

test("normalizes text and structured input", () => {
	expect(toCodexUserInput("hello")).toEqual([
		{ type: "text", text: "hello", text_elements: [] },
	]);
	expect(
		toCodexUserInput([
			{ type: "text", text: "one" },
			{ type: "localImage", path: "/tmp/image.png" },
		]),
	).toEqual([
		{ type: "text", text: "one", text_elements: [] },
		{ type: "localImage", path: "/tmp/image.png" },
	]);
});

test("starts a new thread and turn with safe high-level options", async () => {
	const fake = new FakeAppServerClient();
	const flows = new CodexFlowClient({ client: fake });

	const result = await flows.startFlow({
		cwd: "/workspace/game",
		prompt: "Prepare the run",
		input: [{ type: "text", text: "extra input" }],
		approvalPolicy: "never",
		sandbox: "danger-full-access",
		outputSchema: { type: "object" },
	});

	expect(result.threadId).toBe("thread-1");
	expect(result.turnId).toBe("turn-1");
	expect(fake.startThreadCalls).toEqual([
		expect.objectContaining({
			cwd: "/workspace/game",
			approvalPolicy: "never",
			sandbox: "danger-full-access",
			experimentalRawEvents: false,
			persistExtendedHistory: false,
		}),
	]);
	expect(fake.startTurnCalls).toEqual([
		expect.objectContaining({
			threadId: "thread-1",
			cwd: "/workspace/game",
			approvalPolicy: "never",
			outputSchema: { type: "object" },
			input: [
				{ type: "text", text: "Prepare the run", text_elements: [] },
				{ type: "text", text: "extra input", text_elements: [] },
			],
		}),
	]);
});

test("resumes an existing thread before starting a turn", async () => {
	const fake = new FakeAppServerClient();
	const flows = new CodexFlowClient({ client: fake });

	await flows.startFlow({
		threadId: "existing",
		prompt: "continue",
		cwd: "/workspace/game",
		resume: { excludeTurns: false },
	});

	expect(fake.resumeThreadCalls).toEqual([
		expect.objectContaining({
			threadId: "existing",
			cwd: "/workspace/game",
			excludeTurns: false,
			persistExtendedHistory: false,
		}),
	]);
	expect(fake.startThreadCalls).toEqual([]);
	expect(fake.startTurnCalls[0]?.threadId).toBe("existing");
});

test("waits for a turn/completed notification", async () => {
	const fake = new FakeAppServerClient();
	const flows = new CodexFlowClient({ client: fake });
	const pending = flows.startFlow({
		prompt: "wait for completion",
		wait: { timeoutMs: 500, pollIntervalMs: 0 },
	});

	await eventually(() => {
		expect(fake.notificationListenerCount()).toBe(1);
	});
	fake.emit("notification", {
		method: "turn/completed",
		params: {
			threadId: "thread-1",
			turn: turn("turn-1", "completed"),
		},
	});

	const result = await pending;
	expect(result.completedTurn?.status).toBe("completed");
});

test("waits by polling when completion notification was missed", async () => {
	const fake = new FakeAppServerClient();
	const flows = new CodexFlowClient({ client: fake });

	const pending = flows.startFlow({
		prompt: "wait by poll",
		wait: { timeoutMs: 500, pollIntervalMs: 10 },
	});

	await eventually(() => {
		expect(fake.startTurnCalls.length).toBe(1);
	});
	fake.setThreadTurns("thread-1", [turn("turn-1", "completed")]);

	const result = await pending;
	expect(result.completedTurn?.id).toBe("turn-1");
});

test("wait polling tolerates temporary thread materialization failures", async () => {
	const fake = new FakeAppServerClient();
	fake.enqueueReadThreadError("Thread not materialized yet");
	const flows = new CodexFlowClient({ client: fake });

	const pending = flows.startFlow({
		prompt: "wait through materialization",
		wait: { timeoutMs: 500, pollIntervalMs: 10 },
	});

	await eventually(() => {
		expect(fake.startTurnCalls.length).toBe(1);
	});
	fake.setThreadTurns("thread-1", [turn("turn-1", "completed")]);

	const result = await pending;
	expect(result.completedTurn?.status).toBe("completed");
	expect(fake.readThreadCalls.length).toBeGreaterThanOrEqual(2);
});

test("can throw when a waited turn fails", async () => {
	const fake = new FakeAppServerClient();
	const flows = new CodexFlowClient({ client: fake });

	const pending = flows.startFlow({
		prompt: "fail",
		wait: { timeoutMs: 500, pollIntervalMs: 0, throwOnFailure: true },
	});

	await eventually(() => {
		expect(fake.notificationListenerCount()).toBe(1);
	});
	fake.emit("notification", {
		method: "turn/completed",
		params: {
			threadId: "thread-1",
			turn: turn("turn-1", "failed", "bad turn"),
		},
	});

	await expect(pending).rejects.toBeInstanceOf(CodexFlowTurnFailedError);
});

test("times out while waiting for a turn", async () => {
	const fake = new FakeAppServerClient();
	const flows = new CodexFlowClient({ client: fake });

	await expect(
		flows.startFlow({
			prompt: "never completes",
			wait: { timeoutMs: 10, pollIntervalMs: 0 },
		}),
	).rejects.toBeInstanceOf(CodexFlowTimeoutError);
});

class FakeAppServerClient implements CodexFlowAppServerClient {
	startThreadCalls: v2.ThreadStartParams[] = [];
	resumeThreadCalls: v2.ThreadResumeParams[] = [];
	startTurnCalls: v2.TurnStartParams[] = [];
	readThreadCalls: v2.ThreadReadParams[] = [];
	#listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	#threads = new Map<string, v2.Thread>();
	#readThreadErrors: string[] = [];
	#nextThread = 1;
	#nextTurn = 1;

	async connect(): Promise<void> {}

	close(): void {}

	on(event: string, listener: (...args: any[]) => void): void {
		const listeners = this.#listeners.get(event) ?? new Set();
		listeners.add(listener as (...args: unknown[]) => void);
		this.#listeners.set(event, listeners);
	}

	off(event: string, listener: (...args: any[]) => void): void {
		this.#listeners.get(event)?.delete(listener as (...args: unknown[]) => void);
	}

	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.#listeners.get(event) ?? []) {
			listener(...args);
		}
	}

	notificationListenerCount(): number {
		return this.#listeners.get("notification")?.size ?? 0;
	}

	enqueueReadThreadError(message: string): void {
		this.#readThreadErrors.push(message);
	}

	async startThread(
		params: v2.ThreadStartParams,
	): Promise<v2.ThreadStartResponse> {
		this.startThreadCalls.push(params);
		const id = `thread-${this.#nextThread++}`;
		const created = thread(id);
		this.#threads.set(id, created);
		return {
			thread: created,
			model: params.model ?? "gpt-test",
			modelProvider: params.modelProvider ?? "openai",
			serviceTier: params.serviceTier ?? null,
			cwd: params.cwd ?? "",
			runtimeWorkspaceRoots: [],
			instructionSources: [],
			approvalPolicy: params.approvalPolicy ?? "on-request",
			approvalsReviewer: params.approvalsReviewer ?? "user",
			sandbox: { type: "dangerFullAccess" },
			activePermissionProfile: null,
			reasoningEffort: null,
		};
	}

	async resumeThread(
		params: v2.ThreadResumeParams,
	): Promise<v2.ThreadResumeResponse> {
		this.resumeThreadCalls.push(params);
		const resumed = this.#threads.get(params.threadId) ?? thread(params.threadId);
		this.#threads.set(params.threadId, resumed);
		return {
			thread: resumed,
			model: params.model ?? "gpt-test",
			modelProvider: params.modelProvider ?? "openai",
			serviceTier: params.serviceTier ?? null,
			cwd: params.cwd ?? "",
			runtimeWorkspaceRoots: [],
			instructionSources: [],
			approvalPolicy: params.approvalPolicy ?? "on-request",
			approvalsReviewer: params.approvalsReviewer ?? "user",
			sandbox: { type: "dangerFullAccess" },
			activePermissionProfile: null,
			reasoningEffort: null,
		};
	}

	async readThread(params: v2.ThreadReadParams): Promise<v2.ThreadReadResponse> {
		this.readThreadCalls.push(params);
		const message = this.#readThreadErrors.shift();
		if (message) {
			throw new Error(message);
		}
		return {
			thread: this.#threads.get(params.threadId) ?? thread(params.threadId),
		};
	}

	async startTurn(params: v2.TurnStartParams): Promise<v2.TurnStartResponse> {
		this.startTurnCalls.push(params);
		const id = `turn-${this.#nextTurn++}`;
		const started = turn(id, "inProgress");
		const current = this.#threads.get(params.threadId) ?? thread(params.threadId);
		this.#threads.set(params.threadId, {
			...current,
			turns: [...current.turns, started],
		});
		return { turn: started };
	}

	setThreadTurns(threadId: string, turns: v2.Turn[]): void {
		const current = this.#threads.get(threadId) ?? thread(threadId);
		this.#threads.set(threadId, { ...current, turns });
	}
}

function thread(id: string, turns: v2.Turn[] = []): v2.Thread {
	return {
		id,
		sessionId: id,
		forkedFromId: null,
		preview: "",
		ephemeral: false,
		modelProvider: "openai",
		createdAt: 0,
		updatedAt: 0,
		status: { type: "idle" },
		path: null,
		cwd: "",
		cliVersion: "test",
		source: "appServer",
		threadSource: null,
		agentNickname: null,
		agentRole: null,
		gitInfo: null,
		name: null,
		turns,
	};
}

function turn(
	id: string,
	status: v2.TurnStatus,
	message?: string,
): v2.Turn {
	return {
		id,
		items: [],
		itemsView: "full",
		status,
		error: message
			? { message, codexErrorInfo: null, additionalDetails: null }
			: null,
		startedAt: 0,
		completedAt: status === "inProgress" ? null : 1,
		durationMs: status === "inProgress" ? null : 1,
	};
}

async function eventually(assertion: () => void): Promise<void> {
	const started = Date.now();
	let lastError: unknown;
	while (Date.now() - started < 500) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
	throw lastError;
}
