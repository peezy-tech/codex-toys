import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vite-plus/test";
import {
	ClaudeCodeClient,
	type ClaudeCodeQuery,
} from "@codex-appkit/claude-code";
import { createCodexAppkitHttpHandler } from "@codex-appkit/http";

test("starts and feeds a local Claude session through the HTTP bridge", async () => {
	let prompt: AsyncIterable<unknown> | undefined;
	const claude = new ClaudeCodeClient({
		createQuery: (input) => {
			prompt = input.prompt;
			return new IdleQuery() as ClaudeCodeQuery;
		},
	});
	const handler = createCodexAppkitHttpHandler({ claudeClient: claude });
	const server = createServer((request, response) => {
		void handler(request, response);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Expected a TCP test server");
	}
	const baseUrl = `http://127.0.0.1:${address.port}/api`;

	try {
		const started = await fetch(`${baseUrl}/claude/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: "/workspace" }),
		});
		expect(started.status).toBe(201);
		const { sessionId } = await started.json() as { sessionId: string };

		const input = await fetch(`${baseUrl}/claude/sessions/${sessionId}/input`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "inspect the repository" }),
		});
		expect(input.status).toBe(202);
		const message = await prompt?.[Symbol.asyncIterator]().next();
		expect(message?.value).toMatchObject({
			type: "user",
			message: { role: "user", content: "inspect the repository" },
		});
	} finally {
		claude.close();
		server.close();
		await once(server, "close");
	}
});

class IdleQuery {
	#close = Promise.withResolvers<void>();

	async interrupt(): Promise<void> {}

	close(): void {
		this.#close.resolve();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<never> {
		await this.#close.promise;
	}
}
