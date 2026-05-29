import type {
	WorkspaceFunctionMetadata,
	WorkspaceFunctionsCallResponse,
	WorkspaceFunctionsDescribeResponse,
	WorkspaceFunctionsListResponse,
} from "./functions.ts";

export {
	CodexBrowserAppServerClient as CodexAppServerClient,
	type CodexBrowserAppServerClientOptions as CodexAppServerClientOptions,
	type CodexBrowserAppServerTransport as CodexAppServerTransport,
} from "./app-server/browser-client.ts";
export {
	CodexWorkspaceBackendClient,
	type CodexWorkspaceBackendClientOptions,
	type CodexWorkspaceBackendTransport,
	type WorkspaceBackendEvent,
} from "./workspace-backend/client.ts";
export {
	CodexWebSocketTransport,
	type CodexWebSocketTransportOptions,
} from "./app-server/websocket-transport.ts";
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

export type CodexFlowsBrowserClientOptions = {
	basePath?: string;
	fetch?: typeof fetch;
};

export type CodexFlowsBrowserFunctionsClient = {
	list(): Promise<WorkspaceFunctionMetadata[]>;
	describe(name: string): Promise<WorkspaceFunctionMetadata>;
	call<T = unknown>(name: string, params?: unknown): Promise<T>;
};

export type CodexFlowsBrowserClient = {
	functions: CodexFlowsBrowserFunctionsClient;
	status(): Promise<unknown>;
};

export function createCodexFlowsBrowserClient(
	options: CodexFlowsBrowserClientOptions = {},
): CodexFlowsBrowserClient {
	const basePath = (options.basePath ?? "/__codex_flows").replace(/\/$/, "");
	const fetchImpl = options.fetch ?? fetch;
	return {
		status: async () => await requestJson(fetchImpl, `${basePath}/status`),
		functions: {
			list: async () => {
				const response = await requestJson<WorkspaceFunctionsListResponse>(
					fetchImpl,
					`${basePath}/functions`,
				);
				return response.functions;
			},
			describe: async (name) => {
				const response = await requestJson<WorkspaceFunctionsDescribeResponse>(
					fetchImpl,
					`${basePath}/functions/${encodeURIComponent(name)}`,
				);
				return response.function;
			},
			call: async <T = unknown>(name: string, params?: unknown) => {
				const response = await requestJson<WorkspaceFunctionsCallResponse>(
					fetchImpl,
					`${basePath}/functions/${encodeURIComponent(name)}`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ params }),
					},
				);
				return response.result as T;
			},
		},
	};
}

export const codexFlows = createCodexFlowsBrowserClient();

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
		throw new Error(typeof input.error === "string" ? input.error : `Codex Flows request failed: ${response.status}`);
	}
	return parsed as T;
}
