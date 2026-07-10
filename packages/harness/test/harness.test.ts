import { expect, test } from "vite-plus/test";
import type { v2 } from "@codex-appkit/codex";
import type { ClaudeCodeSessionStartOptions } from "@codex-appkit/claude";
import {
	AgentHarness,
	type HarnessEvent,
} from "@codex-appkit/harness";

test("runs Codex with full permissions and forwards native events", async () => {
	const client = new FakeCodexClient();
	const events: HarnessEvent[] = [];
	const harness = new AgentHarness({
		createCodexClient: () => client as never,
	});

	const run = await harness.run({
		provider: "codex",
		prompt: "inspect the repository",
		cwd: "/workspace",
		model: "gpt-5",
		onEvent: (event) => events.push(event),
	});

	expect(client.threadParams).toMatchObject({
		cwd: "/workspace",
		model: "gpt-5",
		approvalPolicy: "never",
		sandbox: "danger-full-access",
	});
	expect(client.turnParams).toMatchObject({
		threadId: "thread-1",
		model: "gpt-5",
		approvalPolicy: "never",
		sandboxPolicy: { type: "dangerFullAccess" },
		input: [{ type: "text", text: "inspect the repository", text_elements: [] }],
	});
	expect(run).toMatchObject({ provider: "codex", sessionId: "thread-1", runId: "turn-1" });
	expect(events).toContainEqual({ provider: "codex", event: { method: "item/started" } });

	await run.interrupt();
	expect(client.interruptParams).toEqual({ threadId: "thread-1", turnId: "turn-1" });
	run.close();
	expect(client.closed).toBe(true);
});

test("runs Claude with bypass permissions and local session state", async () => {
	const client = new FakeClaudeClient();
	const events: HarnessEvent[] = [];
	const harness = new AgentHarness({
		createClaudeClient: () => client as never,
	});

	const run = harness.run({
		provider: "claude",
		prompt: "inspect the repository",
		cwd: "/workspace",
		model: "sonnet",
		onEvent: (event) => events.push(event),
	});

	await expect(run).resolves.toMatchObject({ provider: "claude", sessionId: "claude-session", runId: null });
	expect(client.options).toMatchObject({
		cwd: "/workspace",
		model: "sonnet",
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
	});
	expect(client.session.sent).toEqual(["inspect the repository"]);
	client.session.emit("event", { type: "message", message: "hello" });
	expect(events).toContainEqual({
		provider: "claude",
		event: { type: "message", message: "hello" },
	});
});

test("installs provider-native plugins without inventing a cross-provider format", async () => {
	const client = new FakeCodexClient();
	const commands: Array<{ command: string; args: string[]; cwd?: string }> = [];
	const harness = new AgentHarness({
		createCodexClient: () => client as never,
		runCommand: async (command, args, options) => {
			commands.push({ command, args, cwd: options.cwd });
			return { stdout: "installed", stderr: "" };
		},
	});

	await expect(harness.installPlugin({
		provider: "claude",
		plugin: "example",
		scope: "project",
		cwd: "/workspace",
	})).resolves.toEqual({ provider: "claude", stdout: "installed", stderr: "" });
	expect(commands).toEqual([{
		command: "claude",
		args: ["plugin", "install", "example", "--scope", "project"],
		cwd: "/workspace",
	}]);

	await harness.installPlugin({
		provider: "codex",
		plugin: "example",
		remoteMarketplaceName: "internal",
	});
	expect(client.pluginParams).toEqual({
		pluginName: "example",
		remoteMarketplaceName: "internal",
	});
	expect(client.closed).toBe(true);
});

class FakeCodexClient {
	#listeners = new Map<string, Set<(event: unknown) => void>>();
	threadParams: v2.ThreadStartParams | undefined;
	turnParams: v2.TurnStartParams | undefined;
	interruptParams: v2.TurnInterruptParams | undefined;
	pluginParams: v2.PluginInstallParams | undefined;
	closed = false;

	on(event: string, listener: (event: unknown) => void): this {
		const listeners = this.#listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.#listeners.set(event, listeners);
		return this;
	}

	off(event: string, listener: (event: unknown) => void): this {
		this.#listeners.get(event)?.delete(listener);
		return this;
	}

	async connect(): Promise<void> {}

	close(): void {
		this.closed = true;
	}

	async startThread(params: v2.ThreadStartParams): Promise<v2.ThreadStartResponse> {
		this.threadParams = params;
		return { thread: { id: "thread-1" } } as v2.ThreadStartResponse;
	}

	async startTurn(params: v2.TurnStartParams): Promise<v2.TurnStartResponse> {
		this.turnParams = params;
		this.emit("notification", { method: "item/started" });
		return { turn: { id: "turn-1" } } as v2.TurnStartResponse;
	}

	async interruptTurn(params: v2.TurnInterruptParams): Promise<v2.TurnInterruptResponse> {
		this.interruptParams = params;
		return {} as v2.TurnInterruptResponse;
	}

	async installPlugin(params: v2.PluginInstallParams): Promise<v2.PluginInstallResponse> {
		this.pluginParams = params;
		return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
	}

	emit(event: string, payload: unknown): void {
		for (const listener of this.#listeners.get(event) ?? []) {
			listener(payload);
		}
	}
}

class FakeClaudeClient {
	options: ClaudeCodeSessionStartOptions | undefined;
	session = new FakeClaudeSession();
	closed = false;

	startSession(options: ClaudeCodeSessionStartOptions): FakeClaudeSession {
		this.options = options;
		return this.session;
	}

	close(): void {
		this.closed = true;
	}
}

class FakeClaudeSession {
	id = "claude-session";
	sent: string[] = [];
	#listeners = new Map<string, Set<(event: unknown) => void>>();

	on(event: string, listener: (event: unknown) => void): this {
		const listeners = this.#listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.#listeners.set(event, listeners);
		return this;
	}

	off(event: string, listener: (event: unknown) => void): this {
		this.#listeners.get(event)?.delete(listener);
		return this;
	}

	sendText(text: string): void {
		this.sent.push(text);
	}

	async interrupt(): Promise<void> {}

	close(): void {}

	emit(event: string, payload: unknown): void {
		for (const listener of this.#listeners.get(event) ?? []) {
			listener(payload);
		}
	}
}
