import path from "node:path";
import type { FlowBackendConfig } from "./config.ts";
import { dispatchFlowEvent, normalizeFlowEvent, replayFlowEvent } from "./backend.ts";
import { requestSignature, verifyBodySignature } from "./signature.ts";
import { FlowBackendStore, type FlowRunStatus } from "./store.ts";

export type WorkspaceFlowCapabilityOptions = {
	config: FlowBackendConfig;
	store?: FlowBackendStore;
	env?: Record<string, string | undefined>;
};

export class WorkspaceFlowCapability {
	readonly config: FlowBackendConfig;
	readonly store: FlowBackendStore;
	#env: Record<string, string | undefined>;
	#ownsStore: boolean;

	constructor(options: WorkspaceFlowCapabilityOptions) {
		this.config = options.config;
		this.store = options.store ??
			new FlowBackendStore(path.join(options.config.dataDir, "flow-backend.sqlite"));
		this.#env = options.env ?? process.env;
		this.#ownsStore = !options.store;
	}

	close(): void {
		if (this.#ownsStore) {
			this.store.close();
		}
	}

	async dispatch(event: unknown): Promise<unknown> {
		return await dispatchFlowEvent({
			config: this.config,
			store: this.store,
			event: normalizeFlowEvent(event),
			env: this.#env,
		});
	}

	async replay(eventId: string, options: { wait?: boolean } = {}): Promise<unknown> {
		return await replayFlowEvent({
			config: this.config,
			store: this.store,
			eventId,
			wait: Boolean(options.wait),
			env: this.#env,
		});
	}

	listEvents(options: { type?: string; limit?: number } = {}): unknown {
		return {
			events: this.store.listEvents({
				type: options.type,
				limit: options.limit,
			}),
		};
	}

	getEvent(eventId: string): unknown {
		const event = this.store.getEvent(eventId);
		if (!event) {
			throw new Error(`Unknown event: ${eventId}`);
		}
		return { event, runs: this.store.listRunsByEvent(eventId) };
	}

	listRuns(options: {
		eventId?: string;
		status?: string;
		limit?: number;
	} = {}): unknown {
		return {
			...(options.eventId ? { eventId: options.eventId } : {}),
			runs: this.store.listRuns({
				eventId: options.eventId,
				status: options.status ? requireRunStatus(options.status) : undefined,
				limit: options.limit,
			}),
		};
	}

	getRun(runId: string): unknown {
		const run = this.store.getRun(runId);
		if (!run) {
			throw new Error(`Unknown run: ${runId}`);
		}
		return { run };
	}

	async handleHttp(request: Request): Promise<Response | undefined> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/healthz") {
			return json({ ok: true });
		}
		if (request.method === "POST" && (url.pathname === "/events" || url.pathname === "/flow-events")) {
			const body = await request.text();
			if (!validSignature(this.config, body, request.headers)) {
				return json({ error: "invalid signature" }, 401);
			}
			return json(await this.dispatch(JSON.parse(body) as unknown), 202);
		}
		if (request.method === "GET" && url.pathname === "/events") {
			return json(this.listEvents({
				type: url.searchParams.get("type") ?? undefined,
				limit: numberParam(url.searchParams.get("limit")),
			}));
		}
		const eventMatch = url.pathname.match(/^\/events\/([^/]+)(?:\/(replay))?$/);
		if (eventMatch?.[1] && request.method === "GET" && !eventMatch[2]) {
			try {
				return json(this.getEvent(decodeURIComponent(eventMatch[1])));
			} catch {
				return json({ error: "event not found" }, 404);
			}
		}
		if (eventMatch?.[1] && eventMatch[2] === "replay" && request.method === "POST") {
			const body = await request.text();
			if (!validSignature(this.config, body, request.headers)) {
				return json({ error: "invalid signature" }, 401);
			}
			const params = parseBody(body);
			const result = await this.replay(decodeURIComponent(eventMatch[1]), {
				wait: Boolean(params.wait),
			});
			return json(result, 202);
		}
		if (request.method === "GET" && url.pathname === "/runs") {
			return json(this.listRuns({
				eventId: url.searchParams.get("eventId") ?? undefined,
				status: url.searchParams.get("status") ?? undefined,
				limit: numberParam(url.searchParams.get("limit")),
			}));
		}
		const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
		if (runMatch?.[1] && request.method === "GET") {
			try {
				return json(this.getRun(decodeURIComponent(runMatch[1])));
			} catch {
				return json({ error: "run not found" }, 404);
			}
		}
		return undefined;
	}
}

export function serveFlowBackend(config: FlowBackendConfig): ReturnType<typeof Bun.serve> {
	const flow = new WorkspaceFlowCapability({ config });
	return Bun.serve({
		hostname: config.host,
		port: config.port,
		async fetch(request) {
			return await flow.handleHttp(request) ?? json({ error: "not found" }, 404);
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
