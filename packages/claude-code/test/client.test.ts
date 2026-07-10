import { expect, test } from "vite-plus/test";
import type {
	CanUseTool,
	Options,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	ClaudeCodeClient,
	type ClaudeCodeEvent,
	type ClaudeCodeQuery,
} from "@codex-appkit/claude-code";

test("uses the local Claude command and preserved settings by default", async () => {
	let captured: { prompt: AsyncIterable<SDKUserMessage>; options: Options } | undefined;
	const client = new ClaudeCodeClient({
		createQuery: (input) => {
			captured = input;
			return new FakeQuery();
		},
	});
	const session = client.startSession({ cwd: "/workspace" });

	expect(captured?.options.pathToClaudeCodeExecutable).toBe("claude");
	expect(captured?.options.cwd).toBe("/workspace");
	expect(captured?.options.settingSources).toEqual(["user", "project", "local"]);
	expect(captured?.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
	expect(captured?.options.env).toBeUndefined();

	session.close();
});

test("streams input, deltas, and browser-resolved approvals", async () => {
	let captured: { prompt: AsyncIterable<SDKUserMessage>; options: Options } | undefined;
	const events: ClaudeCodeEvent[] = [];
	const client = new ClaudeCodeClient({
		createQuery: (input) => {
			captured = input;
			return new FakeQuery([
				{
					type: "system",
					subtype: "init",
					session_id: "11111111-1111-4111-8111-111111111111",
				} as SDKMessage,
				{
					type: "stream_event",
					session_id: "11111111-1111-4111-8111-111111111111",
					event: {
						type: "content_block_delta",
						delta: { type: "text_delta", text: "hello" },
					},
				} as SDKMessage,
			]);
		},
	});
	client.on("event", (event: ClaudeCodeEvent) => events.push(event));
	const session = client.startSession();
	await nextTurn();

	session.sendText("inspect the repository");
	const input = await captured?.prompt[Symbol.asyncIterator]().next();
	expect(input?.value).toMatchObject({
		type: "user",
		message: { role: "user", content: "inspect the repository" },
	});
	expect(events).toContainEqual(expect.objectContaining({
		type: "message.delta",
		delta: expect.objectContaining({ kind: "text", delta: "hello" }),
	}));

	const abortController = new AbortController();
	const approval = captured?.options.canUseTool?.(
		"Bash",
		{ command: "git status" },
		{
			signal: abortController.signal,
			toolUseID: "tool-1",
		} as Parameters<CanUseTool>[2],
	);
	await nextTurn();
	const requested = events.find((event) => event.type === "approval.requested");
	expect(requested).toMatchObject({
		type: "approval.requested",
		toolName: "Bash",
		input: { command: "git status" },
	});
	if (!requested || requested.type !== "approval.requested") {
		throw new Error("Expected an approval request");
	}
	session.resolveApproval(requested.requestId, { behavior: "allow" });
	expect(await approval).toEqual({
		behavior: "allow",
		updatedInput: { command: "git status" },
	});

	session.close();
});

class FakeQuery implements ClaudeCodeQuery {
	#messages: SDKMessage[];
	#closed = false;
	#waitForClose = Promise.withResolvers<void>();
	interrupted = false;

	constructor(messages: SDKMessage[] = []) {
		this.#messages = messages;
	}

	async interrupt(): Promise<void> {
		this.interrupted = true;
	}

	close(): void {
		if (!this.#closed) {
			this.#closed = true;
			this.#waitForClose.resolve();
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
		for (const message of this.#messages) {
			yield message;
		}
		await this.#waitForClose.promise;
	}
}

async function nextTurn(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
