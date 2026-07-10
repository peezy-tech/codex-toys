export type AgentHarnessBrowserProvider = "codex" | "claude";

export type AgentHarnessBrowserRun = {
	id: string;
	provider: AgentHarnessBrowserProvider;
	sessionId: string;
	runId: string | null;
};

export type AgentHarnessBrowserClientOptions = {
	basePath?: string;
	fetch?: typeof fetch;
};

export type AgentHarnessBrowserClient = {
	status(): Promise<unknown>;
	run(input: { provider: AgentHarnessBrowserProvider; prompt: string; model?: string }): Promise<AgentHarnessBrowserRun>;
	interrupt(id: string): Promise<{ ok: true }>;
	close(id: string): Promise<{ ok: true }>;
	installPlugin(input: Record<string, unknown>): Promise<unknown>;
	events(id: string, onEvent: (event: unknown) => void): () => void;
};

export function createAgentHarnessBrowserClient(
	options: AgentHarnessBrowserClientOptions = {},
): AgentHarnessBrowserClient {
	const basePath = (options.basePath ?? "/api").replace(/\/$/, "");
	const fetchImpl = options.fetch ?? fetch;
	const post = async <T = unknown>(path: string, body: unknown): Promise<T> =>
		await requestJson(fetchImpl, `${basePath}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	return {
		status: async () => await requestJson(fetchImpl, `${basePath}/status`),
		run: async (input) => await post<AgentHarnessBrowserRun>("/runs", input),
		interrupt: async (id) => await post<{ ok: true }>(`/runs/${encodeURIComponent(id)}/interrupt`, {}),
		close: async (id) => await post<{ ok: true }>(`/runs/${encodeURIComponent(id)}/close`, {}),
		installPlugin: async (input) => await post("/plugins", input),
		events: (id, onEvent) => {
			const events = new EventSource(`${basePath}/runs/${encodeURIComponent(id)}/events`);
			events.onmessage = (message) => onEvent(JSON.parse(message.data) as unknown);
			return () => events.close();
		},
	};
}

async function requestJson<T = unknown>(
	fetchImpl: typeof fetch,
	url: string,
	init?: RequestInit,
): Promise<T> {
	const response = await fetchImpl(url, init);
	const text = await response.text();
	const parsed = text ? JSON.parse(text) as unknown : undefined;
	if (!response.ok) {
		const input = parsed && typeof parsed === "object" ? parsed as { error?: unknown } : {};
		throw new Error(typeof input.error === "string" ? input.error : `Agent Harness request failed: ${response.status}`);
	}
	return parsed as T;
}
