import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vite-plus/test";
import type {
	AgentHarnessRunner,
	HarnessEvent,
	InstallPluginInput,
	PluginInstallResult,
	UnattendedRun,
	UnattendedRunInput,
} from "@codex-appkit/harness";
import { createAgentHarnessHttpHandler } from "@codex-appkit/http";

test("starts a fixed-directory harness run and exposes its native events", async () => {
	const harness = new FakeHarness();
	const handler = createAgentHarnessHttpHandler({ harness, cwd: "/sandbox" });
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
		const started = await fetch(`${baseUrl}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider: "claude", prompt: "inspect the repository", model: "sonnet", cwd: "/ignored" }),
		});
		expect(started.status).toBe(201);
		const run = await started.json() as { id: string; provider: string; sessionId: string };
		expect(run).toMatchObject({ provider: "claude", sessionId: "session-1" });
		expect(harness.input).toMatchObject({
			provider: "claude",
			prompt: "inspect the repository",
			model: "sonnet",
			cwd: "/sandbox",
		});
		const eventResponse = await fetch(`${baseUrl}/runs/${run.id}/events`);
		expect(eventResponse.status).toBe(200);
		const reader = eventResponse.body?.getReader();
		const firstChunk = await reader?.read();
		expect(new TextDecoder().decode(firstChunk?.value)).toContain('"type":"started"');
		await reader?.cancel();
	} finally {
		server.close();
		await once(server, "close");
	}
});

class FakeHarness implements AgentHarnessRunner {
	input: UnattendedRunInput | undefined;

	async run(input: UnattendedRunInput): Promise<UnattendedRun> {
		this.input = input;
		input.onEvent?.({ provider: input.provider, event: { type: "started" } });
		return new FakeRun(input.provider);
	}

	async installPlugin(_input: InstallPluginInput): Promise<PluginInstallResult> {
		return { provider: "claude", stdout: "", stderr: "" };
	}
}

class FakeRun implements UnattendedRun {
	readonly sessionId = "session-1";
	readonly runId = null;
	#listeners = new Set<(event: HarnessEvent) => void>();

	constructor(readonly provider: "codex" | "claude") {}

	onEvent(listener: (event: HarnessEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async interrupt(): Promise<void> {}
	close(): void {}
}
