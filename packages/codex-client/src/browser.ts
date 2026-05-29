import type {
	WorkspaceFunctionMetadata,
	WorkspaceFunctionsCallResponse,
	WorkspaceFunctionsDescribeResponse,
	WorkspaceFunctionsListResponse,
} from "./functions.ts";

export {
	JsonRpcError,
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	requireJsonRpcResult,
} from "./app-server/rpc.ts";
export type {
	JsonRpcErrorObject,
	JsonRpcId,
	JsonRpcMessage,
	JsonRpcNotification,
	JsonRpcRequest,
	JsonRpcResponse,
} from "./app-server/rpc.ts";
export type { v2 } from "./app-server/generated/index.ts";
export type {
	WorkspaceFunctionMetadata,
	WorkspaceFunctionsCallResponse,
	WorkspaceFunctionsDescribeResponse,
	WorkspaceFunctionsListResponse,
} from "./functions.ts";
export {
	CodexAuthClient,
	CodexAuthTimeoutError,
	accountResponseToAuthState,
	createCodexAuthClient,
	rateLimitSnapshotToUsage,
} from "./app-server/auth.ts";
export type {
	CodexApiKeyLoginStart,
	CodexAuthChangeEvent,
	CodexAuthClientTransport,
	CodexAuthMode,
	CodexAuthState,
	CodexAuthTokensLoginStart,
	CodexChatGptLoginStart,
	CodexDeviceCodeLoginStart,
	CodexLoginMethod,
	CodexLoginStart,
	CodexUsageSnapshot,
	CodexUsageWindow,
	WaitForLoginOptions,
} from "./app-server/auth.ts";

export type CodexToysBrowserClientOptions = {
	basePath?: string;
	fetch?: typeof fetch;
};

export type CodexToysBrowserFunctionsClient = {
	list(): Promise<WorkspaceFunctionMetadata[]>;
	describe(name: string): Promise<WorkspaceFunctionMetadata>;
	call<T = unknown>(name: string, params?: unknown): Promise<T>;
};

export type CodexToysBrowserClient = {
	rpc<T = unknown>(method: string, params?: unknown): Promise<T>;
	app: {
		call<T = unknown>(method: string, params?: unknown): Promise<T>;
	};
	workspace: {
		call<T = unknown>(method: string, params?: unknown): Promise<T>;
	};
	functions: CodexToysBrowserFunctionsClient;
	status(): Promise<unknown>;
	schema(): Promise<unknown>;
};

export function createCodexToysBrowserClient(
	options: CodexToysBrowserClientOptions = {},
): CodexToysBrowserClient {
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
		workspace: {
			call: async <T = unknown>(method: string, params?: unknown) =>
				await post<T>(`${basePath}/workspace/${encodeURIComponent(method)}`, params),
		},
		functions: {
			list: async () => {
				const response = await post<WorkspaceFunctionsListResponse>(
					`${basePath}/workspace/functions.list`,
					{},
				);
				return response.functions;
			},
			describe: async (name) => {
				const response = await post<WorkspaceFunctionsDescribeResponse>(
					`${basePath}/workspace/functions.describe`,
					{ name },
				);
				return response.function;
			},
			call: async <T = unknown>(name: string, params?: unknown) => {
				const response = await post<WorkspaceFunctionsCallResponse>(
					`${basePath}/workspace/functions.call`,
					{ name, params },
				);
				return response.result as T;
			},
		},
	};
}

export const codexToys = createCodexToysBrowserClient();

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
		throw new Error(typeof input.error === "string" ? input.error : `Codex Toys request failed: ${response.status}`);
	}
	return parsed as T;
}
