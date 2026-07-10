export type CodexAppkitBrowserClientOptions = {
	basePath?: string;
	fetch?: typeof fetch;
};

export type CodexAppkitBrowserClient = {
	rpc<T = unknown>(method: string, params?: unknown): Promise<T>;
	app: {
		call<T = unknown>(method: string, params?: unknown): Promise<T>;
	};
	status(): Promise<unknown>;
	schema(): Promise<unknown>;
	claude: {
		listSessions<T = unknown>(options?: { dir?: string; limit?: number }): Promise<T>;
		getSessionMessages<T = unknown>(
			sessionId: string,
			options?: { dir?: string; limit?: number; offset?: number },
		): Promise<T>;
		start<T = { sessionId: string }>(options?: Record<string, unknown>): Promise<T>;
		send(sessionId: string, text: string): Promise<{ ok: true }>;
		interrupt(sessionId: string): Promise<{ ok: true }>;
		resolveApproval(
			sessionId: string,
			requestId: string,
			decision: Record<string, unknown>,
		): Promise<{ ok: true }>;
		events(sessionId: string, onEvent: (event: unknown) => void): () => void;
	};
};

export function createCodexAppkitBrowserClient(
	options: CodexAppkitBrowserClientOptions = {},
): CodexAppkitBrowserClient {
	const basePath = (options.basePath ?? "/api").replace(/\/$/, "");
	const fetchImpl = options.fetch ?? fetch;
	const post = async <T = unknown>(url: string, body: unknown): Promise<T> =>
		await requestJson(fetchImpl, url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	return {
		status: async () => await requestJson(fetchImpl, `${basePath}/status`),
		schema: async () => await requestJson(fetchImpl, `${basePath}/schema`),
		rpc: async <T = unknown>(method: string, params?: unknown) =>
			await post<T>(`${basePath}/rpc`, { method, params }),
		app: {
			call: async <T = unknown>(method: string, params?: unknown) =>
				await post<T>(`${basePath}/app/${encodeURIComponent(method)}`, params),
		},
		claude: {
			listSessions: async <T = unknown>(options = {}) =>
				await requestJson<T>(fetchImpl, `${basePath}/claude/sessions${searchParams(options)}`),
			getSessionMessages: async <T = unknown>(
				sessionId: string,
				options: { dir?: string; limit?: number; offset?: number } = {},
			) =>
				await requestJson<T>(
					fetchImpl,
					`${basePath}/claude/sessions/${encodeURIComponent(sessionId)}/messages${searchParams(options)}`,
				),
			start: async <T = { sessionId: string }>(options = {}) =>
				await post<T>(`${basePath}/claude/sessions`, options),
			send: async (sessionId, text) =>
				await post<{ ok: true }>(
					`${basePath}/claude/sessions/${encodeURIComponent(sessionId)}/input`,
					{ text },
				),
			interrupt: async (sessionId) =>
				await post<{ ok: true }>(
					`${basePath}/claude/sessions/${encodeURIComponent(sessionId)}/interrupt`,
					{},
				),
			resolveApproval: async (sessionId, requestId, decision) =>
				await post<{ ok: true }>(
					`${basePath}/claude/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(requestId)}`,
					decision,
				),
			events: (sessionId, onEvent) => {
				const events = new EventSource(
					`${basePath}/claude/sessions/${encodeURIComponent(sessionId)}/events`,
				);
				events.onmessage = (message) => onEvent(JSON.parse(message.data) as unknown);
				return () => events.close();
			},
		},
	};
}

export const codexAppkit = createCodexAppkitBrowserClient();

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
		throw new Error(typeof input.error === "string" ? input.error : `Codex AppKit request failed: ${response.status}`);
	}
	return parsed as T;
}

function searchParams(values: Record<string, string | number | undefined>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) {
			params.set(key, String(value));
		}
	}
	const text = params.toString();
	return text ? `?${text}` : "";
}
