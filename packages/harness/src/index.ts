import { spawn } from "node:child_process";
import {
	CodexAppServerClient,
	type v2,
} from "@codex-appkit/codex";
import {
	ClaudeCodeClient,
	DEFAULT_CLAUDE_COMMAND,
	type ClaudeCodeSession,
} from "@codex-appkit/claude";

export type HarnessProvider = "codex" | "claude";

export type HarnessEvent = {
	provider: HarnessProvider;
	event: unknown;
};

export type UnattendedRunInput = {
	provider: HarnessProvider;
	prompt: string;
	cwd?: string;
	model?: string;
	/** Receives provider-native events, with only the provider name added. */
	onEvent?: (event: HarnessEvent) => void;
};

export type UnattendedRun = {
	provider: HarnessProvider;
	sessionId: string;
	runId: string | null;
	onEvent(listener: (event: HarnessEvent) => void): () => void;
	interrupt(): Promise<void>;
	close(): void;
};

export type InstallPluginInput =
	| {
			provider: "codex";
			plugin: string;
			marketplacePath?: string;
			remoteMarketplaceName?: string;
	  }
	| {
			provider: "claude";
			plugin: string;
			scope?: "user" | "project" | "local";
			cwd?: string;
	  };

export type PluginInstallResult =
	| { provider: "codex"; result: v2.PluginInstallResponse }
	| { provider: "claude"; stdout: string; stderr: string };

export type CodexHarnessClient = Pick<
	CodexAppServerClient,
	"connect" | "close" | "startThread" | "startTurn" | "interruptTurn" | "installPlugin" | "on" | "off"
>;

export type ClaudeHarnessClient = Pick<ClaudeCodeClient, "startSession" | "close">;
export type ClaudeHarnessSession = Pick<
	ClaudeCodeSession,
	"id" | "sendText" | "interrupt" | "close" | "on" | "off"
>;

export type CommandResult = { stdout: string; stderr: string };

export type AgentHarnessOptions = {
	createCodexClient?: () => CodexHarnessClient;
	createClaudeClient?: () => ClaudeHarnessClient;
	runCommand?: (
		command: string,
		args: string[],
		options: { cwd?: string },
	) => Promise<CommandResult>;
};

/**
 * A deliberately thin layer over the locally configured Codex app-server and
 * Claude Code. It does not copy sessions, normalize native events, or rewrite
 * provider configuration.
 *
 * `run` always disables interactive permission prompts. Use it only where an
 * outer sandbox already provides the containment you need.
 */
export class AgentHarness {
	#options: AgentHarnessOptions;

	constructor(options: AgentHarnessOptions = {}) {
		this.#options = options;
	}

	async run(input: UnattendedRunInput): Promise<UnattendedRun> {
		return input.provider === "codex"
			? await this.#runCodex(input)
			: this.#runClaude(input);
	}

	async installPlugin(input: InstallPluginInput): Promise<PluginInstallResult> {
		if (input.provider === "claude") {
			const result = await (this.#options.runCommand ?? runCommand)(
				process.env.CLAUDE_CODE_EXECUTABLE ?? DEFAULT_CLAUDE_COMMAND,
				["plugin", "install", input.plugin, "--scope", input.scope ?? "user"],
				{ ...(input.cwd ? { cwd: input.cwd } : {}) },
			);
			return { provider: "claude", ...result };
		}

		const client = this.#createCodexClient();
		try {
			await client.connect();
			const result = await client.installPlugin({
				pluginName: input.plugin,
				...(input.marketplacePath ? { marketplacePath: input.marketplacePath } : {}),
				...(input.remoteMarketplaceName
					? { remoteMarketplaceName: input.remoteMarketplaceName }
					: {}),
			});
			return { provider: "codex", result };
		} finally {
			client.close();
		}
	}

	async #runCodex(input: UnattendedRunInput): Promise<UnattendedRun> {
		const client = this.#createCodexClient();
		const run = new ActiveRun({
			provider: "codex",
			sessionId: "",
			runId: null,
			onEvent: input.onEvent,
			interrupt: async () => {},
			close: () => {},
		});
		const forward = (event: unknown) => run.publish({ provider: "codex", event });
		client.on("notification", forward);
		client.on("request", forward);
		client.on("stderr", forward);
		client.on("error", forward);
		client.on("close", forward);

		try {
			await client.connect();
			const thread = await client.startThread({
				...(input.cwd ? { cwd: input.cwd } : {}),
				...(input.model ? { model: input.model } : {}),
				approvalPolicy: "never",
				sandbox: "danger-full-access",
			});
			const turn = await client.startTurn({
				threadId: thread.thread.id,
				...(input.cwd ? { cwd: input.cwd } : {}),
				...(input.model ? { model: input.model } : {}),
				approvalPolicy: "never",
				sandboxPolicy: { type: "dangerFullAccess" },
				input: [{ type: "text", text: input.prompt, text_elements: [] }],
			});
			run.setIdentity(thread.thread.id, turn.turn.id);
			run.setActions({
				interrupt: async () => {
					await client.interruptTurn({ threadId: thread.thread.id, turnId: turn.turn.id });
				},
				close: () => {
					client.off("notification", forward);
					client.off("request", forward);
					client.off("stderr", forward);
					client.off("error", forward);
					client.off("close", forward);
					client.close();
				},
			});
			return run;
		} catch (error) {
			client.close();
			throw error;
		}
	}

	#runClaude(input: UnattendedRunInput): UnattendedRun {
		const client = this.#createClaudeClient();
		const session = client.startSession({
			...(input.cwd ? { cwd: input.cwd } : {}),
			...(input.model ? { model: input.model } : {}),
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
		}) as ClaudeHarnessSession;
		const run = new ActiveRun({
			provider: "claude",
			sessionId: session.id,
			runId: null,
			onEvent: input.onEvent,
			interrupt: () => session.interrupt(),
			close: () => {
				session.off("event", forward);
				session.close();
				client.close();
			},
		});
		const forward = (event: unknown) => run.publish({ provider: "claude", event });
		session.on("event", forward);
		session.sendText(input.prompt);
		return run;
	}

	#createCodexClient(): CodexHarnessClient {
		return this.#options.createCodexClient?.() ?? new CodexAppServerClient({
			clientName: "codex-appkit-harness",
			clientTitle: "Codex AppKit Harness",
			clientVersion: "0.1.0",
		});
	}

	#createClaudeClient(): ClaudeHarnessClient {
		return this.#options.createClaudeClient?.() ?? new ClaudeCodeClient();
	}
}

export type AgentHarnessRunner = Pick<AgentHarness, "run" | "installPlugin">;

class ActiveRun implements UnattendedRun {
	readonly provider: HarnessProvider;
	sessionId: string;
	runId: string | null;
	#listeners = new Set<(event: HarnessEvent) => void>();
	#interrupt: () => Promise<void>;
	#close: () => void;

	constructor(options: {
		provider: HarnessProvider;
		sessionId: string;
		runId: string | null;
		onEvent?: (event: HarnessEvent) => void;
		interrupt: () => Promise<void>;
		close: () => void;
	}) {
		this.provider = options.provider;
		this.sessionId = options.sessionId;
		this.runId = options.runId;
		this.#interrupt = options.interrupt;
		this.#close = options.close;
		if (options.onEvent) {
			this.#listeners.add(options.onEvent);
		}
	}

	onEvent(listener: (event: HarnessEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	interrupt(): Promise<void> {
		return this.#interrupt();
	}

	close(): void {
		this.#close();
	}

	publish(event: HarnessEvent): void {
		for (const listener of this.#listeners) {
			listener(event);
		}
	}

	setIdentity(sessionId: string, runId: string): void {
		this.sessionId = sessionId;
		this.runId = runId;
	}

	setActions(options: { interrupt: () => Promise<void>; close: () => void }): void {
		this.#interrupt = options.interrupt;
		this.#close = options.close;
	}
}

function runCommand(
	command: string,
	args: string[],
	options: { cwd?: string },
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			...(options.cwd ? { cwd: options.cwd } : {}),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}: ${stderr || stdout}`));
		});
	});
}
