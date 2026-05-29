import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { CodexWebSocketTransport } from "./app-server/websocket-transport.ts";
import type { CodexWorkspaceBackendTransport } from "./workspace-backend/client.ts";
import {
	WORKSPACE_BACKEND_INITIALIZE_METHOD,
	type WorkspaceBackendInitializeResponse,
} from "./workspace-backend/index.ts";
import {
	WORKSPACE_FUNCTIONS_CALL_METHOD,
	WORKSPACE_FUNCTIONS_DESCRIBE_METHOD,
	WORKSPACE_FUNCTIONS_LIST_METHOD,
	type WorkspaceFunctionsCallResponse,
	type WorkspaceFunctionsDescribeResponse,
	type WorkspaceFunctionsListResponse,
} from "./functions.ts";
import {
	createSshRemoteAgentTransport,
	hasSshRemote,
	type SshRemoteProviderOptions,
} from "./cli/remote-provider.ts";

export type CodexFlowsRemoteVitePluginOptions = Partial<SshRemoteProviderOptions> & {
	ssh?: string;
	sshTarget?: string;
	workspaceUrl?: string;
	basePath?: string;
	transport?: CodexWorkspaceBackendTransport;
};

type WorkspaceRequester = {
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
	close(): void;
};

export function codexFlowsRemote(
	options: CodexFlowsRemoteVitePluginOptions = {},
): Plugin {
	const basePath = normalizeBasePath(options.basePath ?? "/__codex_flows");
	let requester: WorkspaceRequester | undefined;
	const getRequester = (): WorkspaceRequester => {
		if (requester) {
			return requester;
		}
		requester = createWorkspaceRequester(options);
		return requester;
	};
	return {
		name: "codex-flows-remote",
		configureServer(server) {
			server.middlewares.use(async (request, response, next) => {
				if (!request.url) {
					next();
					return;
				}
				const url = new URL(request.url, "http://codex-flows.local");
				if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
					next();
					return;
				}
				try {
					await handleCodexFlowsRequest(
						getRequester(),
						basePath,
						request,
						response,
					);
				} catch (error) {
					writeJson(response, 500, { error: errorMessage(error) });
				}
			});
			server.httpServer?.once("close", () => {
				requester?.close();
				requester = undefined;
			});
		},
	};
}

function createWorkspaceRequester(
	options: CodexFlowsRemoteVitePluginOptions,
): WorkspaceRequester {
	const timeoutMs = options.timeoutMs ?? 90_000;
	const transport = options.transport ?? (hasSshRemote({
		sshTarget: options.sshTarget ?? options.ssh,
		env: options.env,
	})
		? createSshRemoteAgentTransport({
				...options,
				sshTarget: options.sshTarget ?? options.ssh,
				timeoutMs,
			})
		: new CodexWebSocketTransport({
				url: options.workspaceUrl ?? "ws://127.0.0.1:3586",
				requestTimeoutMs: timeoutMs,
			}));
	let initialized: Promise<WorkspaceBackendInitializeResponse> | undefined;
	const initialize = async () => {
		transport.start();
		initialized ??= transport.request<WorkspaceBackendInitializeResponse>(
			WORKSPACE_BACKEND_INITIALIZE_METHOD,
			{
				clientInfo: {
					name: "codex-flows-vite",
					title: "Codex Flows Vite Plugin",
					version: "0.1.0",
				},
				capabilities: {
					appServerPassThrough: true,
				},
			},
		);
		await initialized;
	};
	return {
		request: async (method, params) => {
			await initialize();
			return await transport.request(method, params);
		},
		close: () => {
			transport.close();
			initialized = undefined;
		},
	};
}

async function handleCodexFlowsRequest(
	requester: WorkspaceRequester,
	basePath: string,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const url = new URL(request.url ?? "/", "http://codex-flows.local");
	const path = url.pathname.slice(basePath.length) || "/";
	if (request.method === "GET" && path === "/status") {
		let remoteAgent: unknown = null;
		try {
			remoteAgent = await requester.request("remoteAgent/status", {});
		} catch {
			remoteAgent = null;
		}
		writeJson(response, 200, { ok: true, remoteAgent });
		return;
	}
	if (request.method === "GET" && path === "/functions") {
		writeJson(
			response,
			200,
			await requester.request<WorkspaceFunctionsListResponse>(
				WORKSPACE_FUNCTIONS_LIST_METHOD,
				{},
			),
		);
		return;
	}
	const match = path.match(/^\/functions\/([^/]+)$/);
	if (match?.[1] && request.method === "GET") {
		writeJson(
			response,
			200,
			await requester.request<WorkspaceFunctionsDescribeResponse>(
				WORKSPACE_FUNCTIONS_DESCRIBE_METHOD,
				{ name: decodeURIComponent(match[1]) },
			),
		);
		return;
	}
	if (match?.[1] && request.method === "POST") {
		const body = await readJsonBody(request);
		writeJson(
			response,
			200,
			await requester.request<WorkspaceFunctionsCallResponse>(
				WORKSPACE_FUNCTIONS_CALL_METHOD,
				{
					name: decodeURIComponent(match[1]),
					params: record(body).params,
				},
			),
		);
		return;
	}
	writeJson(response, 404, { error: "Unknown Codex Flows endpoint" });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	let body = "";
	for await (const chunk of request) {
		body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		if (body.length > 1_000_000) {
			throw new Error("Request body is too large");
		}
	}
	if (!body.trim()) {
		return {};
	}
	return JSON.parse(body) as unknown;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(`${JSON.stringify(value)}\n`);
}

function normalizeBasePath(value: string): string {
	const path = value.startsWith("/") ? value : `/${value}`;
	return path.replace(/\/+$/, "") || "/__codex_flows";
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
