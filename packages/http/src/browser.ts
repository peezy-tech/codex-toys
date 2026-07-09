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
