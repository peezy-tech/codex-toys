import { expect, test } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	discoverFlows,
	createCodexFlowClientFromContext,
	createWorkspaceBackendClientFromContext,
	matchingSteps,
	readFlowContext,
	runBunStep,
	runFlowStep,
	validateJsonSchema,
	workspaceBackendUrlFromContext,
} from "../src/index.ts";
import { codeModeEnabled } from "../src/run.ts";
import type { FlowEvent } from "../src/index.ts";

test("discovers installed flows before source flows", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "flow-runtime-"));
	try {
		await writeFlow(directory, ".codex/flows/demo", "installed");
		await writeFlow(directory, "flows/demo", "source");

		const flows = await discoverFlows({ cwd: directory });

		expect(flows.map((flow) => flow.manifest.name)).toEqual(["demo"]);
		expect(flows[0]?.manifest.description).toBe("installed");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("matches flow steps by event type and payload schema", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "flow-runtime-"));
	try {
		await writeFlow(directory, "flows/demo", "source");
		const flows = await discoverFlows({ cwd: directory });
		const event: FlowEvent = {
			id: "event-1",
			type: "demo.event",
			receivedAt: "2026-05-13T00:00:00.000Z",
			payload: { name: "Ada" },
		};

		expect((await matchingSteps(flows, event)).map(({ step }) => step.name)).toEqual([
			"hello",
		]);
		expect(await matchingSteps(flows, { ...event, payload: {} })).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("bundled Codex release flows match one generic upstream release event", async () => {
	const root = path.resolve(import.meta.dir, "..", "..", "..");
	const flows = await discoverFlows({ cwd: root });
	const event: FlowEvent = {
		id: "event-1",
		type: "upstream.release",
		receivedAt: "2026-05-13T00:00:00.000Z",
		payload: { repo: "openai/codex", tag: "rust-v1.2.3" },
	};

	const matches = await matchingSteps(flows, event);

	expect(matches.map(({ flow, step }) => `${flow.manifest.name}/${step.name}`)).toEqual([
		"openai-codex-bindings/regenerate-bindings",
		"peezy-codex-fork/release-cycle",
	]);
});

test("bundled Codex fork flow matches upstream main branch updates", async () => {
	const root = path.resolve(import.meta.dir, "..", "..", "..");
	const flows = await discoverFlows({ cwd: root });
	const event: FlowEvent = {
		id: "event-branch",
		type: "upstream.branch_update",
		receivedAt: "2026-05-13T00:00:00.000Z",
		payload: {
			repo: "openai/codex",
			ref: "refs/heads/main",
			sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		},
	};

	const matches = await matchingSteps(flows, event);

	expect(matches.map(({ flow, step }) => `${flow.manifest.name}/${step.name}`)).toEqual([
		"peezy-codex-fork/main-branch-update",
	]);
});

test("bundled Code Mode flow remains gated by the feature flag", async () => {
	const root = path.resolve(import.meta.dir, "..", "..", "..");
	const flows = await discoverFlows({ cwd: root });
	const flow = flows.find((entry) => entry.manifest.name === "peezy-codex-fork");
	const step = flow?.manifest.steps.find((entry) => entry.name === "release-cycle");
	if (!flow || !step) {
		throw new Error("expected bundled peezy-codex-fork flow");
	}

	await expect(
		runFlowStep({
			flow,
			step,
			event: {
				id: "event-1",
				type: "upstream.release",
				receivedAt: "2026-05-13T00:00:00.000Z",
				payload: { repo: "openai/codex", tag: "rust-v1.2.3" },
			},
			env: {},
		}),
	).rejects.toThrow("requires CODEX_FLOWS_ENABLE_CODE_MODE=1");
});

test("CODEX_FLOWS_MODE=code-mode enables Code Mode flow steps", () => {
	expect(codeModeEnabled({})).toBe(false);
	expect(codeModeEnabled({ CODEX_FLOWS_ENABLE_CODE_MODE: "1" })).toBe(true);
	expect(codeModeEnabled({ CODEX_FLOWS_MODE: "code-mode" })).toBe(true);
});

test("validates simple JSON schema constraints", () => {
	const schema = {
		type: "object",
		required: ["name"],
		properties: {
			name: { type: "string" },
			kind: { enum: ["demo"] },
		},
	};

	expect(validateJsonSchema({ name: "Ada", kind: "demo" }, schema)).toEqual({ ok: true });
	expect(validateJsonSchema({ kind: "other" }, schema)).toEqual({
		ok: false,
		errors: ["$.name is required", "$.kind must be one of demo"],
	});
});

test("runs Bun flow steps and parses FLOW_RESULT", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "flow-runtime-"));
	try {
		await writeFlow(directory, "flows/demo", "source");
		const [flow] = await discoverFlows({ cwd: directory });
		const step = flow?.manifest.steps[0];
		if (!flow || !step) {
			throw new Error("expected fixture flow");
		}

		const result = await runBunStep({
			flow,
			step,
			event: {
				id: "event-1",
				type: "demo.event",
				receivedAt: "2026-05-13T00:00:00.000Z",
				payload: { name: "Ada" },
			},
		});

		expect(result).toEqual({
			status: "completed",
			message: "hello Ada",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("runs module-style Bun flow steps and passes runtime metadata", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "flow-runtime-"));
	try {
		await writeFlow(directory, "flows/demo", "source", [
			"export default async function step(context) {",
			"  return {",
			"    status: 'completed',",
			"    message: `${context.runtime.runId}:${context.runtime.attemptId}:${context.runtime.replay}` ,",
			"    artifacts: {",
			"      eventId: context.runtime.eventId,",
			"      workspaceBackendUrl: context.runtime.workspaceBackendUrl,",
			"      envRunId: process.env.CODEX_FLOW_RUN_ID,",
			"      envEventId: process.env.CODEX_FLOW_EVENT_ID,",
			"      envReplay: process.env.CODEX_FLOW_REPLAY,",
			"      envWorkspaceBackendUrl: process.env.CODEX_WORKSPACE_BACKEND_WS_URL,",
			"    },",
			"  };",
			"}",
			"",
		].join("\n"));
		const [flow] = await discoverFlows({ cwd: directory });
		const step = flow?.manifest.steps[0];
		if (!flow || !step) {
			throw new Error("expected fixture flow");
		}

		const result = await runBunStep({
			flow,
			step,
			event: {
				id: "event-1",
				type: "demo.event",
				receivedAt: "2026-05-13T00:00:00.000Z",
				payload: { name: "Ada" },
			},
			runtime: {
				runId: "run_123",
				attemptId: "attempt_1",
				replay: true,
				workspaceBackendUrl: "ws://127.0.0.1:3586",
			},
		});

		expect(result).toEqual({
			status: "completed",
			message: "run_123:attempt_1:true",
			artifacts: {
				eventId: "event-1",
				workspaceBackendUrl: "ws://127.0.0.1:3586",
				envRunId: "run_123",
				envEventId: "event-1",
				envReplay: "1",
				envWorkspaceBackendUrl: "ws://127.0.0.1:3586",
			},
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("runs defineBunFlow module-style Bun flow steps", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "flow-runtime-"));
	try {
		const helperUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/bun.ts")).href;
		await writeFlow(directory, "flows/demo", "source", [
			`import { defineBunFlow } from ${JSON.stringify(helperUrl)};`,
			"export default defineBunFlow(async (context) => ({",
			"  status: 'completed',",
			"  message: `hello ${context.flow.event.payload.name}`",
			"}));",
			"",
		].join("\n"));
		const [flow] = await discoverFlows({ cwd: directory });
		const step = flow?.manifest.steps[0];
		if (!flow || !step) {
			throw new Error("expected fixture flow");
		}

		const result = await runBunStep({
			flow,
			step,
			event: {
				id: "event-1",
				type: "demo.event",
				receivedAt: "2026-05-13T00:00:00.000Z",
				payload: { name: "Ada" },
			},
		});

		expect(result).toEqual({
			status: "completed",
			message: "hello Ada",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Bun flow helpers read context and create workspace-backed Codex clients", async () => {
	const context = await readFlowContext(JSON.stringify({
		flow: {
			name: "demo",
			version: 1,
			root: "/tmp/demo",
			step: "hello",
			event: {
				id: "event-1",
				type: "demo.event",
				receivedAt: "2026-05-13T00:00:00.000Z",
				payload: {},
			},
		},
		runtime: {
			eventId: "event-1",
			runId: "run_123",
			replay: false,
			workspaceBackendUrl: "ws://127.0.0.1:3586",
		},
	}));
	const fakeTransport = {
		requestTimeoutMs: 1000,
		calls: [] as Array<{ method: string; params?: unknown }>,
		start() {},
		close() {},
		async request(method: string, params?: unknown) {
			this.calls.push({ method, params });
			if (method === "workspace.initialize") {
				return {};
			}
			if (method === "appServer.call" && isRecord(params)) {
				if (params.method === "thread/start" || params.method === "thread/resume") {
					return { thread: { id: "thread-1" } };
				}
				if (params.method === "turn/start") {
					return { turn: { id: "turn-1", status: "running" } };
				}
			}
			throw new Error(`unexpected request ${method}`);
		},
		notify() {},
		on() {},
		off() {},
	};

	expect(workspaceBackendUrlFromContext(context)).toBe("ws://127.0.0.1:3586");
	const workspaceClient = createWorkspaceBackendClientFromContext(context, {
		transport: fakeTransport as never,
	});
	const codex = createCodexFlowClientFromContext(context, { workspaceClient });

	expect(codex.client).toBe(workspaceClient);
	await expect(codex.startFlow({
		prompt: "continue",
		threadId: "existing-thread",
		wait: false,
	})).resolves.toMatchObject({
		threadId: "thread-1",
		turnId: "turn-1",
	});
	expect(fakeTransport.calls.map((call) => call.method)).toEqual([
		"workspace.initialize",
		"appServer.call",
		"appServer.call",
	]);
	expect(fakeTransport.calls[1]?.params).toMatchObject({
		method: "thread/resume",
		params: { threadId: "existing-thread" },
	});
	codex.close();
});

test("requires a feature flag before running Code Mode flow steps", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "flow-runtime-"));
	try {
		await writeFlow(directory, "flows/demo", "source");
		const [flow] = await discoverFlows({ cwd: directory });
		const step = flow?.manifest.steps[0];
		if (!flow || !step) {
			throw new Error("expected fixture flow");
		}

		await expect(
			runFlowStep({
				flow,
				step: { ...step, runner: "code-mode" },
				event: {
					id: "event-1",
					type: "demo.event",
					receivedAt: "2026-05-13T00:00:00.000Z",
					payload: { name: "Ada" },
				},
				env: {},
			}),
		).rejects.toThrow("requires CODEX_FLOWS_ENABLE_CODE_MODE=1");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

async function writeFlow(
	root: string,
	relative: string,
	description: string,
	script?: string,
): Promise<void> {
	const flowRoot = path.join(root, relative);
	await mkdir(path.join(flowRoot, "exec"), { recursive: true });
	await mkdir(path.join(flowRoot, "schemas"), { recursive: true });
	await Bun.write(
		path.join(flowRoot, "flow.toml"),
		[
			'name = "demo"',
			"version = 1",
			`description = "${description}"`,
			"",
			"[[steps]]",
			'name = "hello"',
			'runner = "bun"',
			'script = "exec/hello.ts"',
			"timeout_ms = 30000",
			"",
			"[steps.trigger]",
			'type = "demo.event"',
			'schema = "schemas/demo-event.schema.json"',
			"",
		].join("\n"),
	);
	await Bun.write(
		path.join(flowRoot, "schemas/demo-event.schema.json"),
		JSON.stringify({
			type: "object",
			required: ["name"],
			properties: {
				name: { type: "string" },
			},
		}),
	);
	await Bun.write(
		path.join(flowRoot, "exec/hello.ts"),
		script ?? [
			"const context = JSON.parse(await Bun.stdin.text());",
			"const name = context.flow.event.payload.name;",
			"console.log(`FLOW_RESULT ${JSON.stringify({ status: 'completed', message: `hello ${name}` })}`);",
			"",
		].join("\n"),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
