import path from "node:path";
import type { FlowBackendConfig } from "./config.ts";
import { dispatchFlowEvent, normalizeFlowEvent, replayFlowEvent } from "./backend.ts";
import { requestSignature, verifyBodySignature } from "./signature.ts";
import { FlowBackendStore, type FlowRunStatus } from "./store.ts";

export function serveFlowBackend(config: FlowBackendConfig): ReturnType<typeof Bun.serve> {
	const store = new FlowBackendStore(path.join(config.dataDir, "flow-backend.sqlite"));
	return Bun.serve({
		hostname: config.host,
		port: config.port,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/healthz") {
				return json({ ok: true });
			}
			if (request.method === "POST" && (url.pathname === "/events" || url.pathname === "/flow-events")) {
				const body = await request.text();
				if (!validSignature(config, body, request.headers)) {
					return json({ error: "invalid signature" }, 401);
				}
				const event = normalizeFlowEvent(JSON.parse(body) as unknown);
				const result = await dispatchFlowEvent({ config, store, event });
				return json(result, 202);
			}
			if (request.method === "GET" && url.pathname === "/events") {
				return json({
					events: store.listEvents({
						type: url.searchParams.get("type") ?? undefined,
						limit: numberParam(url.searchParams.get("limit")),
					}),
				});
			}
			const eventMatch = url.pathname.match(/^\/events\/([^/]+)(?:\/(replay))?$/);
			if (eventMatch?.[1] && request.method === "GET" && !eventMatch[2]) {
				const eventId = decodeURIComponent(eventMatch[1]);
				const event = store.getEvent(eventId);
				if (!event) {
					return json({ error: "event not found" }, 404);
				}
				return json({ event, runs: store.listRunsByEvent(eventId) });
			}
			if (eventMatch?.[1] && eventMatch[2] === "replay" && request.method === "POST") {
				const body = await request.text();
				if (!validSignature(config, body, request.headers)) {
					return json({ error: "invalid signature" }, 401);
				}
				const params = parseBody(body);
				const result = await replayFlowEvent({
					config,
					store,
					eventId: decodeURIComponent(eventMatch[1]),
					wait: Boolean(params.wait),
					env: process.env,
				});
				return json(result, 202);
			}
			if (request.method === "GET" && url.pathname === "/runs") {
				const eventId = url.searchParams.get("eventId");
				const status = url.searchParams.get("status");
				return json({
					...(eventId ? { eventId } : {}),
					runs: store.listRuns({
						eventId: eventId ?? undefined,
						status: status ? requireRunStatus(status) : undefined,
						limit: numberParam(url.searchParams.get("limit")),
					}),
				});
			}
			const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
			if (runMatch?.[1] && request.method === "GET") {
				const run = store.getRun(decodeURIComponent(runMatch[1]));
				if (!run) {
					return json({ error: "run not found" }, 404);
				}
				return json({ run });
			}
			return json({ error: "not found" }, 404);
		},
	});
}

function validSignature(config: FlowBackendConfig, body: string, headers: Headers): boolean {
	return !config.secret || verifyBodySignature(config.secret, body, requestSignature(headers));
}

function numberParam(value: string | null): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBody(body: string): Record<string, unknown> {
	if (!body.trim()) {
		return {};
	}
	const parsed = JSON.parse(body) as unknown;
	return isRecord(parsed) ? parsed : {};
}

function requireRunStatus(value: string): FlowRunStatus {
	if (value === "queued" || value === "running" || value === "completed" || value === "failed") {
		return value;
	}
	throw new Error("run status must be queued, running, completed, or failed");
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
