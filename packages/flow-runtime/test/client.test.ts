import { expect, test } from "vite-plus/test";
import { createFlowClient } from "../src/client.ts";

test("client factory creates an HTTP backend client with auth handling", async () => {
	const requests: Request[] = [];
	const client = createFlowClient({
		mode: "http",
		baseUrl: "https://flow.example",
		hmacSecret: "secret",
		fetch: async (request, init) => {
			const normalized = request instanceof Request
				? request
				: new Request(String(request), init);
			requests.push(normalized);
			return Response.json({
				status: "accepted",
				eventId: "event-1",
				runIds: ["run-1"],
				matched: 1,
			});
		},
	});

	const result = await client.dispatchEvent({
		id: "event-1",
		type: "demo.event",
		receivedAt: "2026-05-15T00:00:00.000Z",
		payload: {},
	});

	expect(result).toMatchObject({
		status: "accepted",
		eventId: "event-1",
		runIds: ["run-1"],
		matched: 1,
	});
	expect(requests[0]?.headers.get("x-flow-signature-256")?.startsWith("sha256=")).toBe(true);
});

test("client factory creates a local client", async () => {
	const client = createFlowClient({
		mode: "local",
		cwd: process.cwd(),
		state: false,
	});

	await expect(client.listEvents()).rejects.toThrow("requires local state");
});
