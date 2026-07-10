import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
	ClaudeCodeClient,
	type ClaudeCodeClientOptions,
	type ClaudeCodeEvent,
	type ClaudeCodeSessionStartOptions,
} from "@codex-appkit/claude-code";
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
	claudeClient?: ClaudeCodeClient;
	claudeOptions?: ClaudeCodeClientOptions;
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
	let claude: ClaudeCodeClient | undefined;
	const getClaude = (): ClaudeCodeClient => {
		claude ??= options.claudeClient ?? new ClaudeCodeClient(options.claudeOptions);
		return claude;
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
				await handleApiRequest(getRequester(), getClaude(), apiBasePath, request, response);
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
	claude: ClaudeCodeClient,
	apiBasePath: string,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const url = new URL(request.url ?? "/", "http://codex-appkit.local");
	const apiPath = url.pathname.slice(apiBasePath.length) || "/";
	if (apiPath === "/claude/sessions" || apiPath.startsWith("/claude/sessions/")) {
		await handleClaudeRequest(claude, apiPath, url, request, response);
		return;
	}
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
				"GET /api/claude/sessions",
				"GET /api/claude/sessions/:sessionId/messages",
				"POST /api/claude/sessions",
				"POST /api/claude/sessions/:sessionId/input",
				"POST /api/claude/sessions/:sessionId/interrupt",
				"POST /api/claude/sessions/:sessionId/approvals/:requestId",
				"GET /api/claude/sessions/:sessionId/events",
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

async function handleClaudeRequest(
	claude: ClaudeCodeClient,
	apiPath: string,
	url: URL,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const segments = apiPath.split("/").filter(Boolean).map(decodeURIComponent);
	if (segments.length === 2 && request.method === "GET") {
		writeJson(response, 200, await claude.listSessions({
			...(optionalSearchParam(url, "dir") ? { dir: optionalSearchParam(url, "dir") } : {}),
			...(optionalPositiveInteger(url.searchParams.get("limit")) !== undefined
				? { limit: optionalPositiveInteger(url.searchParams.get("limit")) }
				: {}),
		}));
		return;
	}
	if (segments.length === 2 && request.method === "POST") {
		const session = claude.startSession(claudeSessionStartOptions(await readJsonBody(request)));
		writeJson(response, 201, { sessionId: session.id });
		return;
	}
	const sessionId = segments[2];
	if (!sessionId) {
		writeJson(response, 404, { error: "Claude session ID is required" });
		return;
	}
	if (segments.length === 4 && segments[3] === "messages" && request.method === "GET") {
		writeJson(response, 200, await claude.getSessionMessages(sessionId, {
			...(optionalSearchParam(url, "dir") ? { dir: optionalSearchParam(url, "dir") } : {}),
			...(optionalNonNegativeInteger(url.searchParams.get("limit")) !== undefined
				? { limit: optionalNonNegativeInteger(url.searchParams.get("limit")) }
				: {}),
			...(optionalNonNegativeInteger(url.searchParams.get("offset")) !== undefined
				? { offset: optionalNonNegativeInteger(url.searchParams.get("offset")) }
				: {}),
		}));
		return;
	}
	if (segments.length === 4 && segments[3] === "events" && request.method === "GET") {
		await streamClaudeEvents(claude.requireActiveSession(sessionId), request, response);
		return;
	}
	if (segments.length === 4 && segments[3] === "input" && request.method === "POST") {
		const body = record(await readJsonBody(request));
		claude.requireActiveSession(sessionId).sendText(requiredString(body.text, "text"));
		writeJson(response, 202, { ok: true });
		return;
	}
	if (segments.length === 4 && segments[3] === "interrupt" && request.method === "POST") {
		await claude.requireActiveSession(sessionId).interrupt();
		writeJson(response, 200, { ok: true });
		return;
	}
	if (segments.length === 5 && segments[3] === "approvals" && request.method === "POST") {
		const requestId = segments[4];
		if (!requestId) {
			writeJson(response, 404, { error: "Claude approval ID is required" });
			return;
		}
		const body = record(await readJsonBody(request));
		const behavior = requiredString(body.behavior, "behavior");
		if (behavior !== "allow" && behavior !== "deny") {
			throw new Error("behavior must be allow or deny");
		}
		claude.requireActiveSession(sessionId).resolveApproval(requestId, {
			behavior,
			...(typeof body.message === "string" ? { message: body.message } : {}),
			...(typeof body.interrupt === "boolean" ? { interrupt: body.interrupt } : {}),
			...(recordOrUndefined(body.updatedInput) ? { updatedInput: recordOrUndefined(body.updatedInput) } : {}),
		});
		writeJson(response, 200, { ok: true });
		return;
	}
	writeJson(response, 404, { error: "Unknown Claude AppKit HTTP endpoint" });
}

async function streamClaudeEvents(
	session: ReturnType<ClaudeCodeClient["requireActiveSession"]>,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	response.statusCode = 200;
	response.setHeader("content-type", "text/event-stream; charset=utf-8");
	response.setHeader("cache-control", "no-cache, no-transform");
	response.setHeader("connection", "keep-alive");
	response.write(": claude appkit event stream\n\n");
	await new Promise<void>((resolve) => {
		let finished = false;
		const onEvent = (event: ClaudeCodeEvent) => {
			response.write(`data: ${JSON.stringify(event)}\n\n`);
		};
		const cleanup = () => {
			if (finished) {
				return;
			}
			finished = true;
			session.off("event", onEvent);
			resolve();
		};
		session.on("event", onEvent);
		request.once("close", cleanup);
		response.once("close", cleanup);
	});
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

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function optionalSearchParam(url: URL, key: string): string | undefined {
	const value = url.searchParams.get(key);
	return value && value.length > 0 ? value : undefined;
}

function optionalNonNegativeInteger(value: string | null): number | undefined {
	if (!value || !/^\d+$/.test(value)) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function optionalPositiveInteger(value: string | null): number | undefined {
	const parsed = optionalNonNegativeInteger(value);
	return parsed && parsed > 0 ? parsed : undefined;
}

function claudeSessionStartOptions(value: unknown): ClaudeCodeSessionStartOptions {
	const body = record(value);
	const start: ClaudeCodeSessionStartOptions = {};
	if (typeof body.cwd === "string" && body.cwd.length > 0) start.cwd = body.cwd;
	if (typeof body.resume === "string" && body.resume.length > 0) start.resume = body.resume;
	if (typeof body.forkSession === "boolean") start.forkSession = body.forkSession;
	if (typeof body.model === "string" && body.model.length > 0) start.model = body.model;
	if (body.permissionMode === "default" || body.permissionMode === "acceptEdits" ||
		body.permissionMode === "bypassPermissions" || body.permissionMode === "plan" ||
		body.permissionMode === "dontAsk" || body.permissionMode === "auto") {
		start.permissionMode = body.permissionMode;
	}
	if (Array.isArray(body.allowedTools) && body.allowedTools.every((item) => typeof item === "string")) {
		start.allowedTools = body.allowedTools;
	}
	if (Array.isArray(body.disallowedTools) && body.disallowedTools.every((item) => typeof item === "string")) {
		start.disallowedTools = body.disallowedTools;
	}
	if (Array.isArray(body.additionalDirectories) && body.additionalDirectories.every((item) => typeof item === "string")) {
		start.additionalDirectories = body.additionalDirectories;
	}
	if (typeof body.maxTurns === "number" && Number.isSafeInteger(body.maxTurns) && body.maxTurns > 0) {
		start.maxTurns = body.maxTurns;
	}
	if (body.effort === "low" || body.effort === "medium" || body.effort === "high" || body.effort === "max") {
		start.effort = body.effort;
	}
	return start;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
