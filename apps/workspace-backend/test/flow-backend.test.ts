import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dispatchFlowEvent, replayFlowEvent } from "../src/flow/backend.ts";
import { parseCli, readConfig } from "../src/flow/config.ts";
import { flowCommand } from "../src/flow/executor.ts";
import { requestSignature, signBody, verifyBodySignature } from "../src/flow/signature.ts";
import { FlowBackendStore } from "../src/flow/store.ts";

test("signs and verifies dispatch bodies", () => {
	const body = JSON.stringify({ id: "event-1" });
	const signature = signBody("secret", body);

	expect(verifyBodySignature("secret", body, signature)).toBe(true);
	expect(verifyBodySignature("secret", `${body}\n`, signature)).toBe(false);
});

test("reads generic and Patch dispatch signatures", () => {
	expect(requestSignature(new Headers({ "x-flow-signature-256": "sha256=generic" }))).toBe("sha256=generic");
	expect(requestSignature(new Headers({ "x-patch-flow-signature-256": "sha256=patch" }))).toBe("sha256=patch");
});

test("dispatches matching flow steps and records runs", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "flow-backend-"));
	try {
		await writeFlow(directory);
		const config = readConfig(
			{},
			{
				cwd: directory,
				dataDir: path.join(directory, ".codex", "flow-backend"),
				executor: "direct",
				bunCommand: process.execPath,
			},
		);
		const store = new FlowBackendStore(path.join(config.dataDir, "flow-backend.sqlite"));
		try {
			const result = await dispatchFlowEvent({
				config,
				store,
				wait: true,
				env: {},
				event: {
					id: "event-1",
					type: "demo.event",
					receivedAt: "2026-05-13T00:00:00.000Z",
					payload: { name: "Ada" },
				},
			});

			expect(result).toMatchObject({ status: "accepted", eventId: "event-1", matched: 1 });
			const runs = store.listRunsByEvent("event-1");
			expect(runs).toHaveLength(1);
			expect(runs[0]).toMatchObject({
				flowName: "demo",
				stepName: "hello",
				status: "completed",
			});
			expect(runs[0]?.stdout).toContain("hello Ada");
			expect(store.listEvents()).toHaveLength(1);
			expect(store.getEvent("event-1")).toMatchObject({
				id: "event-1",
				type: "demo.event",
				payload: { name: "Ada" },
			});

			const replay = await replayFlowEvent({
				config,
				store,
				eventId: "event-1",
				wait: true,
				env: {},
			});

			expect(replay).toMatchObject({ status: "accepted", eventId: "event-1", matched: 1 });
			const replayRuns = store.listRuns({ eventId: "event-1" });
			expect(replayRuns).toHaveLength(2);
			expect(replayRuns.map((run) => run.status).sort()).toEqual(["completed", "completed"]);
			expect(replayRuns.some((run) => run.id.endsWith("_replay"))).toBe(true);
			const replayRun = replayRuns.find((run) => run.id.endsWith("_replay"));
			expect(replayRun ? store.getRun(replayRun.id)?.stdout : "").toContain("hello Ada");
		} finally {
			store.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("parses inspection and replay commands", () => {
	expect(parseCli(["list-events", "--type", "demo.event", "--limit", "10"], {})).toMatchObject({
		kind: "list-events",
		type: "demo.event",
		limit: 10,
	});
	expect(parseCli(["show-event", "event-1"], {})).toMatchObject({
		kind: "show-event",
		eventId: "event-1",
	});
	expect(parseCli(["replay-event", "event-1", "--wait"], {})).toMatchObject({
		kind: "replay-event",
		eventId: "event-1",
		wait: true,
	});
	expect(parseCli(["list-runs", "--event-id", "event-1", "--status", "failed"], {})).toMatchObject({
		kind: "list-runs",
		eventId: "event-1",
		status: "failed",
	});
	expect(parseCli(["show-run", "run_123"], {})).toMatchObject({
		kind: "show-run",
		runId: "run_123",
	});
});

test("builds systemd-run commands without executing them", () => {
	const config = readConfig({}, { cwd: "/tmp/project", executor: "systemd-run", bunCommand: "/usr/bin/bun" });
	const command = flowCommand({
		config,
		runId: "run_123",
		eventPath: "/tmp/event.json",
		flowName: "demo",
		stepName: "hello",
		env: {
			CODEX_FLOWS_MODE: "code-mode",
			CODEX_FLOWS_ENABLE_CODE_MODE: "1",
			CODEX_FLOW_PUSH: "1",
			PEEZY_CODEX_REPO: "/tmp/codex",
		},
	});

	expect(command.command).toBe("systemd-run");
	expect(command.args).toContain("--user");
	expect(command.args).toContain("--wait");
	expect(command.args).toContain("--setenv=CODEX_FLOWS_MODE=code-mode");
	expect(command.args).toContain("--setenv=CODEX_FLOWS_ENABLE_CODE_MODE=1");
	expect(command.args).toContain("--setenv=CODEX_FLOW_PUSH=1");
	expect(command.args).toContain("--setenv=PEEZY_CODEX_REPO=/tmp/codex");
	expect(command.args).toContain("/usr/bin/bun");
});

async function writeFlow(root: string): Promise<void> {
	const flowRoot = path.join(root, "flows", "demo");
	await mkdir(path.join(flowRoot, "exec"), { recursive: true });
	await mkdir(path.join(flowRoot, "schemas"), { recursive: true });
	await Bun.write(
		path.join(flowRoot, "flow.toml"),
		[
			'name = "demo"',
			"version = 1",
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
			properties: { name: { type: "string" } },
		}),
	);
	await Bun.write(
		path.join(flowRoot, "exec/hello.ts"),
		[
			"const context = JSON.parse(await Bun.stdin.text());",
			"const name = context.flow.event.payload.name;",
			"console.log(`FLOW_RESULT ${JSON.stringify({ status: 'completed', message: `hello ${name}` })}`);",
			"",
		].join("\n"),
	);
}
