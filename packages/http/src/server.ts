import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
	CodexAppServerClient,
	COMMON_APP_SERVER_METHODS,
	validateAppServerMethodName,
	type CodexAppServerClientOptions,
} from "@codex-appkit/app-server";

export type CodexAppkitHttpOptions = CodexAppServerClientOptions & {
	staticDir?: string;
	apiBasePath?: string;
	client?: CodexAppServerClient;
};

type AppServerRequester = {
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
	close(): void;
};

export function createCodexAppkitHttpHandler(
	options: CodexAppkitHttpOptions = {},
): (request: IncomingMessage, response: ServerResponse, next?: () => void) => Promise<void> {
	const apiBasePath = normalizeBasePath(options.apiBasePath ?? "/api");
	let requester: AppServerRequester | undefined;
	const getRequester = (): AppServerRequester => {
		requester ??= createRequester(options);
		return requester;
	};
	return async (request, response, next) => {
		const url = new URL(request.url ?? "/", "http://codex-appkit.local");
		const cors = corsPolicyForRequest(request);
		if (url.pathname === apiBasePath || url.pathname.startsWith(`${apiBasePath}/`)) {
			applyCorsHeaders(response, cors);
			if (!cors.allowed) {
				writeJson(response, 403, { error: "CORS origin is not allowed" });
				return;
			}
			if (request.method === "OPTIONS") {
				response.statusCode = 204;
				response.end();
				return;
			}
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

export function createRequester(options: CodexAppkitHttpOptions = {}): AppServerRequester {
	const client = options.client ?? new CodexAppServerClient(options);
	let connected: Promise<void> | undefined;
	const connect = async () => {
		connected ??= client.connect();
		return await connected;
	};
	return {
		request: async (method, params) => {
			await connect();
			return await client.request(method, params);
		},
		close: () => {
			client.close();
			connected = undefined;
		},
	};
}

async function handleApiRequest(
	requester: AppServerRequester,
	apiBasePath: string,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const url = new URL(request.url ?? "/", "http://codex-appkit.local");
	const apiPath = url.pathname.slice(apiBasePath.length) || "/";
	if (request.method === "GET" && apiPath === "/status") {
		let account: unknown = null;
		try {
			account = await requester.request("account/read", { refreshToken: false });
		} catch {
			account = null;
		}
		writeJson(response, 200, {
			ok: true,
			account,
			methods: COMMON_APP_SERVER_METHODS,
		});
		return;
	}
	if (request.method === "GET" && apiPath === "/schema") {
		writeJson(response, 200, {
			ok: true,
			methods: COMMON_APP_SERVER_METHODS,
			routes: [
				"GET /api/status",
				"GET /api/schema",
				"POST /api/rpc",
				"POST /api/app/:method",
			],
		});
		return;
	}
	if (request.method === "POST" && apiPath === "/rpc") {
		const body = record(await readJsonBody(request));
		const method = validateAppServerMethodName(requiredString(body.method, "method"));
		writeJson(response, 200, await requester.request(method, body.params));
		return;
	}
	if (request.method === "POST" && apiPath.startsWith("/app/")) {
		const method = validateAppServerMethodName(
			decodeURIComponent(apiPath.slice("/app/".length)),
		);
		writeJson(response, 200, await requester.request(method, await readJsonBody(request)));
		return;
	}
	writeJson(response, 404, { error: "Unknown Codex AppKit HTTP endpoint" });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	let body = "";
	for await (const chunk of request) {
		body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		if (body.length > 1_000_000) {
			throw new Error("Request body is too large");
		}
	}
	return body.trim() ? JSON.parse(body) as unknown : {};
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

function corsPolicyForRequest(request: IncomingMessage): { allowed: boolean; origin?: string } {
	const origin = request.headers.origin;
	if (typeof origin !== "string" || origin.length === 0) {
		return { allowed: true };
	}
	return isLoopbackOrigin(origin) ? { allowed: true, origin } : { allowed: false };
}

function applyCorsHeaders(
	response: ServerResponse,
	cors: { allowed: boolean; origin?: string },
): void {
	response.setHeader("vary", "Origin");
	if (!cors.allowed || !cors.origin) {
		return;
	}
	response.setHeader("access-control-allow-origin", cors.origin);
	response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
	response.setHeader("access-control-allow-headers", "content-type");
	response.setHeader("access-control-max-age", "600");
}

function isLoopbackOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return false;
		}
		const hostname = url.hostname.toLowerCase();
		return hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "::1" ||
			hostname === "[::1]" ||
			hostname.endsWith(".localhost");
	} catch {
		return false;
	}
}

function normalizeBasePath(value: string): string {
	const apiBasePath = value.startsWith("/") ? value : `/${value}`;
	return apiBasePath.replace(/\/+$/, "") || "/api";
}

function contentType(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		default:
			return "application/octet-stream";
	}
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} is required`);
	}
	return value;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
