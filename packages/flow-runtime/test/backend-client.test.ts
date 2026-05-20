import { expect, test } from "vite-plus/test";
import {
	FlowBackendHttpClient,
	normalizeRun,
} from "../src/backend-client.ts";

test("lists and reads runs/events from HTTP responses", async () => {
	const fetches: Request[] = [];
	const client = new FlowBackendHttpClient({
		baseUrl: "http://flow-backend.test/base/",
		fetch: async (request, init) => {
			const normalized = request instanceof Request
				? request
				: new Request(String(request), init);
			fetches.push(normalized);
			const url = new URL(normalized.url);
			if (url.pathname === "/base/runs") {
				expect(url.searchParams.get("eventId")).toBe("event-1");
				return json({
					eventId: "event-1",
					runs: [
						{
							id: "run-1",
							eventId: "event-1",
							flowName: "release",
							stepName: "check",
							status: "completed",
							resultJson: JSON.stringify({ status: "changed", message: "updated" }),
							stdout: "FLOW_RESULT ...",
							createdAt: "2026-05-15T00:00:00.000Z",
						},
					],
				});
			}
			if (url.pathname === "/base/runs/run-1") {
				return json({
					run: {
						runId: "run-1",
						eventId: "event-1",
						flowName: "release",
						stepName: "check",
						status: "completed",
						result: { status: "completed", artifacts: { ok: true } },
						output: [{ kind: "stdout", text: "done", createdAt: "2026-05-15T00:00:01.000Z" }],
					},
				});
			}
			if (url.pathname === "/base/events") {
				return json({
					events: [
						{
							id: "event-1",
							type: "upstream.release",
							receivedAt: "2026-05-15T00:00:00.000Z",
							payload: { tag: "v1" },
							runIds: ["run-1"],
						},
					],
				});
			}
			if (url.pathname === "/base/events/event-1") {
				return json({
					event: {
						id: "event-1",
						type: "upstream.release",
						payload: { tag: "v1" },
					},
					runs: [{ id: "run-1", status: "running" }],
				});
			}
			return json({ error: "not found" }, 404);
		},
	});

	const runs = await client.listRuns({ eventId: "event-1", limit: 10 });
	expect(runs).toMatchObject({
		eventId: "event-1",
		runs: [
			{
				id: "run-1",
				eventId: "event-1",
				flowName: "release",
				stepName: "check",
				processStatus: "completed",
				resultStatus: "changed",
				effectiveStatus: "changed",
				needsAttention: false,
			},
		],
	});
	expect(runs.runs[0]?.latestOutput).toMatchObject({
		kind: "stdout",
		text: "FLOW_RESULT ...",
	});

	const run = await client.getRun("run-1");
	expect(run).toMatchObject({
		id: "run-1",
		resultStatus: "completed",
		effectiveStatus: "completed",
		latestOutput: { kind: "stdout", text: "done" },
	});
	expect(run.resultPayload).toEqual({ status: "completed", artifacts: { ok: true } });

	const events = await client.listEvents({ type: "upstream.release" });
	expect(events.events[0]).toMatchObject({
		id: "event-1",
		type: "upstream.release",
		runIds: ["run-1"],
	});

	const event = await client.getEvent("event-1");
	expect(event).toMatchObject({
		id: "event-1",
		runs: [{ id: "run-1", effectiveStatus: "running" }],
		runIds: ["run-1"],
	});
	expect(fetches.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
		"GET /base/runs",
		"GET /base/runs/run-1",
		"GET /base/events",
		"GET /base/events/event-1",
	]);
});

test("normalizes process status plus semantic result status and attention state", () => {
	expect(normalizeRun({
		id: "run-blocked",
		status: "completed",
		resultJson: JSON.stringify({ status: "blocked", message: "local changes" }),
	})).toMatchObject({
		processStatus: "completed",
		resultStatus: "blocked",
		effectiveStatus: "blocked",
		needsAttention: true,
	});
	expect(normalizeRun({
		runId: "run-intervention",
		status: "needs_intervention",
		result: { status: "needs_intervention" },
		attempts: [{ attemptId: "attempt-1", status: "running", workerId: "worker-1" }],
	})).toMatchObject({
		id: "run-intervention",
		resultStatus: "needs_intervention",
		effectiveStatus: "needs_intervention",
		needsAttention: true,
		attemptCount: 1,
		attempts: [{ id: "attempt-1", status: "running", workerId: "worker-1" }],
	});
});

test("constructs dispatch, replay, and cancel requests with auth headers", async () => {
	const requests: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
	const client = new FlowBackendHttpClient({
		baseUrl: "http://flow-backend.test",
		bearerToken: "bearer-secret",
		apiKey: "api-key",
		hmacSecret: "hmac-secret",
		headers: { "x-extra": "yes" },
		fetch: async (request, init) => {
			const normalized = request instanceof Request
				? request
				: new Request(String(request), init);
			requests.push({
				url: normalized.url,
				method: normalized.method,
				headers: normalized.headers,
				body: await normalized.text(),
			});
			if (normalized.url.endsWith("/runs/run-1/cancel")) {
				return json({ run: { id: "run-1", status: "canceled" } });
			}
			return json({
				status: "accepted",
				eventId: "event-1",
				runIds: ["run-1"],
				matched: 1,
			}, 202);
		},
	});

	await client.dispatchEvent({
		id: "event-1",
		type: "demo.event",
		receivedAt: "2026-05-15T00:00:00.000Z",
		payload: { value: 1 },
	});
	await client.replayEvent("event-1", { wait: true });
	await client.cancelRun("run-1");

	expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
		"POST /events",
		"POST /events/event-1/replay",
		"POST /runs/run-1/cancel",
	]);
	for (const request of requests) {
		expect(request.headers.get("authorization")).toBe("Bearer bearer-secret");
		expect(request.headers.get("x-api-key")).toBe("api-key");
		expect(request.headers.get("x-extra")).toBe("yes");
		expect(request.headers.get("content-type")).toBe("application/json");
		expect(request.headers.get("x-flow-signature-256")?.startsWith("sha256=")).toBe(true);
		expect(request.body.length).toBeGreaterThan(0);
	}
	expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({ wait: true });
});

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status });
}
