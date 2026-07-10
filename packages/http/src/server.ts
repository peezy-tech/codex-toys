import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
	AgentHarness,
	type AgentHarnessRunner,
	type HarnessEvent,
	type HarnessProvider,
	type InstallPluginInput,
	type UnattendedRun,
} from "@codex-appkit/harness";

export type AgentHarnessHttpOptions = {
	/** Fixed working directory for every run started by this server. */
	cwd?: string;
	staticDir?: string;
	apiBasePath?: string;
	harness?: AgentHarnessRunner;
};

export type AgentHarnessHttpRun = {
	id: string;
	provider: HarnessProvider;
	sessionId: string;
	runId: string | null;
};

type ActiveRun = {
	run: UnattendedRun;
	events: HarnessEvent[];
	subscribers: Set<(event: HarnessEvent) => void>;
};

const MAX_BUFFERED_EVENTS = 500;

/**
 * Loopback-only HTTP bridge for a fixed external sandbox. Requests select a
 * provider and prompt, while the server owns the working directory and the
 * full-permission containment boundary.
 */
export function createAgentHarnessHttpHandler(
	options: AgentHarnessHttpOptions = {},
): (request: IncomingMessage, response: ServerResponse, next?: () => void) => Promise<void> {
	const apiBasePath = normalizeBasePath(options.apiBasePath ?? "/api");
	const harness = options.harness ?? new AgentHarness();
	const cwd = options.cwd ?? process.cwd();
	const runs = new Map<string, ActiveRun>();

	return async (request, response, next) => {
		const url = new URL(request.url ?? "/", "http://agent-harness.local");
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
				await handleApiRequest({ harness, runs, cwd, apiBasePath, request, response });
			} catch (error) {
				writeJson(response, 500, { error: errorMessage(error) });
			}
			return;
		}
		if (options.staticDir && await serveStatic(options.staticDir, url.pathname, response)) {
			return;
		}
		if (next) {
			next();
			return;
		}
		writeJson(response, 404, { error: "not found" });
	};
}

async function handleApiRequest(options: {
	harness: AgentHarnessRunner;
	runs: Map<string, ActiveRun>;
	cwd: string;
	apiBasePath: string;
	request: IncomingMessage;
	response: ServerResponse;
}): Promise<void> {
	const url = new URL(options.request.url ?? "/", "http://agent-harness.local");
	const apiPath = url.pathname.slice(options.apiBasePath.length) || "/";
	if (options.request.method === "GET" && apiPath === "/status") {
		writeJson(options.response, 200, {
			ok: true,
			cwd: options.cwd,
			providers: ["codex", "claude"],
			routes: [
				"GET /api/status",
				"POST /api/runs",
				"GET /api/runs/:id/events",
				"POST /api/runs/:id/interrupt",
				"POST /api/runs/:id/close",
				"POST /api/plugins",
			],
		});
		return;
	}
	if (options.request.method === "POST" && apiPath === "/runs") {
		const body = record(await readJsonBody(options.request));
		const provider = providerFrom(body.provider);
		const entry: ActiveRun = { run: undefined as never, events: [], subscribers: new Set() };
		const run = await options.harness.run({
			provider,
			prompt: requiredString(body.prompt, "prompt"),
			cwd: options.cwd,
			...(optionalString(body.model) ? { model: optionalString(body.model) } : {}),
			onEvent: (event) => publishEvent(entry, event),
		});
		entry.run = run;
		const id = randomUUID();
		options.runs.set(id, entry);
		writeJson(options.response, 201, runResponse(id, run));
		return;
	}
	if (options.request.method === "POST" && apiPath === "/plugins") {
		const result = await options.harness.installPlugin(
			pluginInput(record(await readJsonBody(options.request)), options.cwd),
		);
		writeJson(options.response, 201, result);
		return;
	}

	const segments = apiPath.split("/").filter(Boolean).map(decodeURIComponent);
	if (segments[0] !== "runs" || !segments[1]) {
		writeJson(options.response, 404, { error: "Unknown Agent Harness endpoint" });
		return;
	}
	const id = segments[1];
	const entry = options.runs.get(id);
	if (!entry) {
		writeJson(options.response, 404, { error: "Run not found" });
		return;
	}
	if (segments.length === 3 && segments[2] === "events" && options.request.method === "GET") {
		await streamEvents(entry, options.request, options.response);
		return;
	}
	if (segments.length === 3 && segments[2] === "interrupt" && options.request.method === "POST") {
		await entry.run.interrupt();
		writeJson(options.response, 200, { ok: true });
		return;
	}
	if (segments.length === 3 && segments[2] === "close" && options.request.method === "POST") {
		entry.run.close();
		options.runs.delete(id);
		writeJson(options.response, 200, { ok: true });
		return;
	}
	writeJson(options.response, 404, { error: "Unknown Agent Harness run endpoint" });
}

function runResponse(id: string, run: UnattendedRun): AgentHarnessHttpRun {
	return { id, provider: run.provider, sessionId: run.sessionId, runId: run.runId };
}

function publishEvent(entry: ActiveRun, event: HarnessEvent): void {
	entry.events.push(event);
	if (entry.events.length > MAX_BUFFERED_EVENTS) {
		entry.events.splice(0, entry.events.length - MAX_BUFFERED_EVENTS);
	}
	for (const subscriber of [...entry.subscribers]) {
		subscriber(event);
	}
}

async function streamEvents(
	entry: ActiveRun,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	response.statusCode = 200;
	response.setHeader("content-type", "text/event-stream; charset=utf-8");
	response.setHeader("cache-control", "no-cache, no-transform");
	response.setHeader("connection", "keep-alive");
	response.write(": agent harness event stream\n\n");
	for (const event of entry.events) {
		writeSseEvent(response, event);
	}
	await new Promise<void>((resolve) => {
		let finished = false;
		const onEvent = (event: HarnessEvent) => writeSseEvent(response, event);
		const cleanup = () => {
			if (finished) {
				return;
			}
			finished = true;
			entry.subscribers.delete(onEvent);
			resolve();
		};
		entry.subscribers.add(onEvent);
		request.once("close", cleanup);
		response.once("close", cleanup);
	});
}

function writeSseEvent(response: ServerResponse, event: HarnessEvent): void {
	response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function pluginInput(body: Record<string, unknown>, cwd: string): InstallPluginInput {
	const provider = providerFrom(body.provider);
	const plugin = requiredString(body.plugin, "plugin");
	if (provider === "codex") {
		return {
			provider,
			plugin,
			...(optionalString(body.marketplacePath) ? { marketplacePath: optionalString(body.marketplacePath) } : {}),
			...(optionalString(body.remoteMarketplaceName)
				? { remoteMarketplaceName: optionalString(body.remoteMarketplaceName) }
				: {}),
		};
	}
	const scope = claudeScope(optionalString(body.scope));
	return { provider, plugin, cwd, ...(scope ? { scope } : {}) };
}

function claudeScope(value: string | undefined): "user" | "project" | "local" | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "user" || value === "project" || value === "local") {
		return value;
	}
	throw new Error("scope must be user, project, or local");
}

function providerFrom(value: unknown): HarnessProvider {
	if (value === "codex" || value === "claude") {
		return value;
	}
	throw new Error("provider must be codex or claude");
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

async function serveStatic(staticDir: string, urlPath: string, response: ServerResponse): Promise<boolean> {
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

function applyCorsHeaders(response: ServerResponse, cors: { allowed: boolean; origin?: string }): void {
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
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" ||
			hostname === "[::1]" || hostname.endsWith(".localhost");
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
		case ".html": return "text/html; charset=utf-8";
		case ".js": return "text/javascript; charset=utf-8";
		case ".css": return "text/css; charset=utf-8";
		case ".json": return "application/json; charset=utf-8";
		case ".svg": return "image/svg+xml";
		default: return "application/octet-stream";
	}
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Request body must be a JSON object");
	}
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} is required`);
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
