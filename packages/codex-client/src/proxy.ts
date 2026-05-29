import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
	APP_SERVER_CALL_METHOD,
	WORKSPACE_BACKEND_INITIALIZE_METHOD,
	type WorkspaceBackendInitializeResponse,
} from "./workspace-backend/index.ts";
import type { CodexWorkspaceBackendTransport } from "./workspace-backend/client.ts";
import {
	createLocalAgentTransport,
	createSshAgentTransport,
	hasSshRemote,
	type SshRemoteProviderOptions,
} from "./cli/remote-provider.ts";

export type CodexFlowsProxyOptions = Partial<SshRemoteProviderOptions> & {
	staticDir?: string;
	apiBasePath?: string;
	transport?: CodexWorkspaceBackendTransport;
};

type ProxyRequester = {
	initialize(): Promise<WorkspaceBackendInitializeResponse>;
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
	close(): void;
};

export function createCodexFlowsProxyHandler(
	options: CodexFlowsProxyOptions = {},
): (request: IncomingMessage, response: ServerResponse, next?: () => void) => Promise<void> {
	const apiBasePath = normalizeBasePath(options.apiBasePath ?? "/api");
	let requester: ProxyRequester | undefined;
	const getRequester = (): ProxyRequester => {
		requester ??= createProxyRequester(options);
		return requester;
	};
	return async (request, response, next) => {
		const url = new URL(request.url ?? "/", "http://codex-flows.local");
		if (url.pathname === apiBasePath || url.pathname.startsWith(`${apiBasePath}/`)) {
			try {
				await handleApiRequest(getRequester(), apiBasePath, request, response);
			} catch (error) {
				writeJson(response, 500, { error: errorMessage(error) });
			}
			return;
		}
		if (options.staticDir) {
			const served = await serveStatic(options.staticDir, url.pathname, response);
			if (served) {
				return;
			}
		}
		if (next) {
			next();
			return;
		}
		writeJson(response, 404, { error: "not found" });
	};
}

export function createProxyRequester(options: CodexFlowsProxyOptions): ProxyRequester {
	const timeoutMs = options.timeoutMs ?? 90_000;
	const transport = options.transport ?? (hasSshRemote({
		sshTarget: options.sshTarget,
		env: options.env,
	})
		? createSshAgentTransport({ ...options, timeoutMs })
		: createLocalAgentTransport({ ...options, timeoutMs }));
	let initialized: Promise<WorkspaceBackendInitializeResponse> | undefined;
	const initialize = async () => {
		transport.start();
		initialized ??= transport.request<WorkspaceBackendInitializeResponse>(
			WORKSPACE_BACKEND_INITIALIZE_METHOD,
			{
				clientInfo: {
					name: "codex-flows-proxy",
					title: "Codex Flows Proxy",
					version: "0.1.0",
				},
				capabilities: {
					appServerPassThrough: true,
				},
			},
		);
		return await initialized;
	};
	return {
		initialize,
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

async function handleApiRequest(
	requester: ProxyRequester,
	apiBasePath: string,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const url = new URL(request.url ?? "/", "http://codex-flows.local");
	const apiPath = url.pathname.slice(apiBasePath.length) || "/";
	if (request.method === "GET" && apiPath === "/status") {
		const initialized = await requester.initialize();
		let agent: unknown = null;
		try {
			agent = await requester.request("agent.status", {});
		} catch {
			agent = null;
		}
		writeJson(response, 200, {
			ok: true,
			serverInfo: initialized.serverInfo,
			capabilities: initialized.capabilities,
			agent,
		});
		return;
	}
	if (request.method === "GET" && apiPath === "/schema") {
		writeJson(response, 200, await requester.initialize());
		return;
	}
	if (request.method === "POST" && apiPath === "/rpc") {
		const body = record(await readJsonBody(request));
		const method = requiredString(body.method, "method");
		writeJson(response, 200, await requester.request(method, body.params));
		return;
	}
	if (request.method === "POST" && apiPath.startsWith("/app/")) {
		const method = decodeURIComponent(apiPath.slice("/app/".length));
		writeJson(
			response,
			200,
			await requester.request(APP_SERVER_CALL_METHOD, {
				method,
				params: await readJsonBody(request),
			}),
		);
		return;
	}
	if (request.method === "POST" && apiPath.startsWith("/workspace/")) {
		const method = decodeURIComponent(apiPath.slice("/workspace/".length));
		writeJson(response, 200, await requester.request(method, await readJsonBody(request)));
		return;
	}
	writeJson(response, 404, { error: "Unknown Codex Flows proxy endpoint" });
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

async function serveStatic(
	staticDir: string,
	urlPath: string,
	response: ServerResponse,
): Promise<boolean> {
	const root = path.resolve(staticDir);
	const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
	const candidate = path.resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`);
	if (!candidate.startsWith(`${root}${path.sep}`) && candidate !== root) {
		return false;
	}
	try {
		const metadata = await stat(candidate);
		if (!metadata.isFile()) {
			return false;
		}
		response.statusCode = 200;
		response.setHeader("content-type", contentType(candidate));
		response.end(await readFile(candidate));
		return true;
	} catch {
		return false;
	}
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(`${JSON.stringify(value)}\n`);
}

function normalizeBasePath(value: string): string {
	const base = value.startsWith("/") ? value : `/${value}`;
	return base.replace(/\/+$/, "") || "/api";
}

function contentType(filePath: string): string {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".html") {
		return "text/html; charset=utf-8";
	}
	if (extension === ".js") {
		return "text/javascript; charset=utf-8";
	}
	if (extension === ".css") {
		return "text/css; charset=utf-8";
	}
	if (extension === ".json") {
		return "application/json; charset=utf-8";
	}
	return "application/octet-stream";
}

function requiredString(value: unknown, name: string): string {
	if (typeof value === "string" && value.length > 0) {
		return value;
	}
	throw new Error(`${name} is required`);
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
