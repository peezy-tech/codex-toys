import { expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalFlowClient } from "../src/local-client.ts";
import type { FlowEvent } from "../src/index.ts";

test("local client dispatches matching steps and returns normalized views", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "flow-local-client-"));
	try {
		await writeFlow(directory, "flows/demo", "source");
		await writeFlow(directory, ".codex/flows/demo", "installed");
		const client = createLocalFlowClient({ cwd: directory, env: {} });
		const event: FlowEvent = {
			id: "event-1",
			type: "demo.event",
			receivedAt: "2026-05-15T00:00:00.000Z",
			payload: { name: "Ada" },
		};

		const result = await client.dispatchEvent(event);

		expect(result).toMatchObject({
			status: "accepted",
			eventId: "event-1",
			matched: 1,
			runs: [
				{
					eventId: "event-1",
					flowName: "demo",
					stepName: "hello",
					backend: "local",
					processStatus: "completed",
					resultStatus: "completed",
					effectiveStatus: "completed",
					needsAttention: false,
					resultPayload: {
						status: "completed",
						message: "installed Ada",
					},
				},
			],
		});
		const run = result.runs[0];
		if (!run) {
			throw new Error("expected one local run");
		}
		expect(result.runIds).toEqual([run.id]);

		const eventView = await client.getEvent("event-1");
		expect(eventView).toMatchObject({
			id: "event-1",
			type: "demo.event",
			runIds: result.runIds,
			runs: [{ id: result.runIds[0] }],
		});

		const runs = await client.listRuns({ eventId: "event-1" });
		expect(runs.runs.map((run) => run.id)).toEqual(result.runIds);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("local memory state dedupes normal dispatch and replays new attempts", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "flow-local-client-"));
	try {
		await writeFlow(directory, "flows/demo", "demo");
		const client = createLocalFlowClient({ cwd: directory, env: {} });
		const event: FlowEvent = {
			id: "event-1",
			type: "demo.event",
			receivedAt: "2026-05-15T00:00:00.000Z",
			payload: { name: "Ada" },
		};

		const first = await client.dispatchEvent(event);
		const duplicate = await client.dispatchEvent(event);
		expect(duplicate).toMatchObject({
			status: "duplicate",
			eventId: "event-1",
			matched: 0,
			idempotent: true,
			runIds: first.runIds,
		});

		const replay = await client.replayEvent("event-1");
		expect(replay.status).toBe("accepted");
		expect(replay.runIds).toHaveLength(1);
		expect(replay.runIds[0]).not.toBe(first.runIds[0]);
		expect(replay.runIds[0]?.endsWith("_replay")).toBe(true);

		const eventView = await client.getEvent("event-1");
		expect(eventView.runIds).toEqual([...first.runIds, ...replay.runIds]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("local file state persists events and runs across client instances", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "flow-local-client-"));
	try {
		await writeFlow(directory, "flows/demo", "demo");
		const dataDir = path.join(directory, ".codex", "flow-client");
		const event: FlowEvent = {
			id: "event-1",
			type: "demo.event",
			receivedAt: "2026-05-15T00:00:00.000Z",
			payload: { name: "Ada" },
		};

		const firstClient = createLocalFlowClient({
			cwd: directory,
			env: {},
			state: { kind: "file", dataDir },
		});
		const first = await firstClient.dispatchEvent(event);

		const secondClient = createLocalFlowClient({
			cwd: directory,
			env: {},
			state: { kind: "file", dataDir },
		});
		const eventView = await secondClient.getEvent("event-1");
		expect(eventView.runIds).toEqual(first.runIds);

		const duplicate = await secondClient.dispatchEvent(event);
		expect(duplicate).toMatchObject({
			status: "duplicate",
			idempotent: true,
			runIds: first.runIds,
		});

		const replay = await secondClient.replayEvent("event-1");
		expect(replay.runIds[0]?.endsWith("_replay")).toBe(true);

		const thirdClient = createLocalFlowClient({
			cwd: directory,
			env: {},
			state: { kind: "file", dataDir },
		});
		expect((await thirdClient.getEvent("event-1")).runIds).toEqual([
			...first.runIds,
			...replay.runIds,
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("local client marks semantic attention statuses from FLOW_RESULT", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flow-local-client-"));
  try {
    await writeFlow(directory, "flows/demo", "demo");
    const client = createLocalFlowClient({ cwd: directory, env: {} });

		const result = await client.dispatchEvent({
			id: "event-blocked",
			type: "demo.event",
			receivedAt: "2026-05-15T00:00:00.000Z",
			payload: { name: "Ada", status: "blocked" },
		});

		expect(result.runs[0]).toMatchObject({
			processStatus: "completed",
			resultStatus: "blocked",
			effectiveStatus: "blocked",
			needsAttention: true,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
  }
});

test("local client emits run progress and streams Node stderr", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "flow-local-client-"));
	try {
		await writeFlow(directory, "flows/demo", "demo");
		const progress: Array<{ kind: string; text?: string; status?: string; runId?: string }> = [];
		const client = createLocalFlowClient({
			cwd: directory,
			env: {},
			progress: (event) => progress.push(event),
		});

		const result = await client.dispatchEvent({
			id: "event-progress",
			type: "demo.event",
			receivedAt: "2026-05-15T00:00:00.000Z",
			payload: { name: "Ada", stderr: "working\\n" },
		});

		expect(result.runs[0]?.effectiveStatus).toBe("completed");
		expect(progress.map((event) => event.kind)).toEqual(["run_start", "stderr", "run_complete"]);
		expect(progress[0]).toMatchObject({
			kind: "run_start",
			runId: result.runIds[0],
		});
		expect(progress[1]).toMatchObject({
			kind: "stderr",
			runId: result.runIds[0],
			text: "working\\n",
		});
		expect(progress[2]).toMatchObject({
			kind: "run_complete",
			runId: result.runIds[0],
			status: "completed",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("local client reports unsupported operations when state is disabled", async () => {
	const client = createLocalFlowClient({
		cwd: await mkdtemp(path.join(os.tmpdir(), "flow-local-client-")),
		state: false,
	});

	await expect(client.listEvents()).rejects.toThrow("requires local state");
	await expect(client.getRun("missing")).rejects.toThrow("requires local state");
	await expect(client.replayEvent("missing")).rejects.toThrow("requires local state");
});

test("local memory state rejects unknown events and runs", async () => {
	const client = createLocalFlowClient({
		cwd: await mkdtemp(path.join(os.tmpdir(), "flow-local-client-")),
	});

	await expect(client.getEvent("missing")).rejects.toThrow("Unknown event");
	await expect(client.getRun("missing")).rejects.toThrow("Unknown run");
	await expect(client.replayEvent("missing")).rejects.toThrow("Unknown event");
});

async function writeFlow(
	root: string,
	relative: string,
	label: string,
): Promise<void> {
	const flowRoot = path.join(root, relative);
	await mkdir(path.join(flowRoot, "exec"), { recursive: true });
	await mkdir(path.join(flowRoot, "schemas"), { recursive: true });
	await writeFile(
		path.join(flowRoot, "flow.toml"),
		[
			'name = "demo"',
			"version = 1",
			`description = ${JSON.stringify(label)}`,
			"",
			"[[steps]]",
			'name = "hello"',
			'runner = "node"',
			'script = "exec/hello.ts"',
			"timeout_ms = 30000",
			"",
			"[steps.trigger]",
			'type = "demo.event"',
			'schema = "schemas/demo-event.schema.json"',
			"",
		].join("\n"),
	);
	await writeFile(
		path.join(flowRoot, "schemas/demo-event.schema.json"),
		JSON.stringify({
			type: "object",
			required: ["name"],
			properties: {
				name: { type: "string" },
				stderr: { type: "string" },
				status: { enum: ["completed", "changed", "blocked", "needs_intervention", "failed"] },
			},
		}),
	);
		await writeFile(
			path.join(flowRoot, "exec/hello.ts"),
			[
				"async function main() {",
				"  const chunks = [];",
				"  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);",
				"  const context = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
				"  const payload = context.flow.event.payload;",
				`  const label = ${JSON.stringify(label)};`,
				"  const status = payload.status ?? 'completed';",
				"  if (payload.stderr) process.stderr.write(payload.stderr);",
				"  console.log(`FLOW_RESULT ${JSON.stringify({ status, message: `${label} ${payload.name}` })}`);",
				"}",
				"void main();",
				"",
			].join("\n"),
		);
	}
