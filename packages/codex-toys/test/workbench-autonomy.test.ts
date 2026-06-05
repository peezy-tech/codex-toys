import { describe, expect, test } from "vite-plus/test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "../src/cli/args.ts";
import {
	cancelDeferredRunIntent,
	collectDeferredRuns,
	collectLocalHandoffRuns,
	collectPromptQueueRuns,
	collectWorkbenchDoctorInfo,
	createDeferredRunIntent,
	createWorkbenchContext,
	defaultActionsRunnerImage,
	drainLocalHandoffQueue,
	enqueueLocalHandoffIntent,
	enqueuePromptQueueIntent,
	listLocalHandoffIntents,
	listPromptQueueIntents,
	listDeferredRunIntents,
	loadWorkbenchConfig,
	pruneDeferredRunHistory,
	readDeferredRun,
	resolveWorkbenchMode,
	retryDeferredRunIntent,
	runDuePromptQueueIntents,
	runDueDeferredRuns,
	runWorkbenchTaskById,
	scaffoldActionsWorkbench,
	tickWorkbench,
	commitActionsWorkbenchState,
} from "@codex-toys/workbench";

const execFile = promisify(execFileCallback);

describe("workbench autonomy", () => {
	test("resolves auto mode from GitHub Actions", () => {
		expect(resolveWorkbenchMode("auto", { GITHUB_ACTIONS: "true" })).toEqual({
			requestedMode: "auto",
			mode: "actions",
		});
		expect(resolveWorkbenchMode("auto", {})).toEqual({
			requestedMode: "auto",
			mode: "local",
		});
		expect(resolveWorkbenchMode("actions", {})).toEqual({
			requestedMode: "actions",
			mode: "actions",
		});
	});

	test("Actions mode ignores external CODEX_HOME while local mode honors it", async () => {
		const root = await tempWorkbench();
		const externalHome = path.join(root, "external-codex-home");
		const actions = await createWorkbenchContext({
			workbenchRoot: root,
			mode: "actions",
			env: { CODEX_HOME: externalHome },
		});
		expect(actions.runtimeCodexHome).toBe(path.join(root, ".codex"));
		expect(actions.workbenchCodexHome).toBe(path.join(root, ".codex"));
		expect(actions.globalCodexHome).toBe(externalHome);

		const local = await createWorkbenchContext({
			workbenchRoot: root,
			mode: "local",
			env: { CODEX_HOME: externalHome },
		});
		expect(local.runtimeCodexHome).toBe(externalHome);
		expect(local.workbenchCodexHome).toBe(path.join(root, ".codex"));
	});

	test("parses workbench and memories commands without disturbing JSON-RPC commands", () => {
		expect(parseArgs(["workbench", "doctor", "--mode", "actions"], {}))
			.toMatchObject({ type: "workbench-doctor", mode: "actions" });
		expect(parseArgs(["workbench", "tick", "--workbench-root", "/tmp/work"], {}))
			.toMatchObject({ type: "workbench-tick", workbenchRoot: "/tmp/work" });
			expect(parseArgs(["workbench", "run", "morning-brief"], {}))
				.toMatchObject({ type: "workbench-run", taskId: "morning-brief" });
			expect(parseArgs([
				"workbench",
				"prompt",
				"enqueue",
				"review this later",
				"--queue",
				"night",
				"--label",
				"docs",
				"--after",
				"parent-1",
				"--after-status",
				"terminal",
				"--effort",
				"low",
				"--service-tier",
				"default",
			], {})).toMatchObject({
				type: "workbench-prompt-enqueue",
				prompt: "review this later",
				queue: "night",
				labels: ["docs"],
				afterIntentId: "parent-1",
				afterStatus: "terminal",
				effort: "low",
				serviceTier: "default",
			});
			expect(parseArgs(["workbench", "prompt", "list", "--queue", "night", "--status", "pending", "--limit", "2"], {}))
				.toMatchObject({ type: "workbench-prompt-list", queue: "night", status: "pending", limit: 2 });
			expect(parseArgs(["workbench", "prompt", "run-due", "--limit", "1"], {}))
				.toMatchObject({ type: "workbench-prompt-run-due", limit: 1 });
			expect(parseArgs([
				"workbench",
				"handoff",
				"enqueue",
				"test the dashboard locally",
				"--queue",
				"local",
				"--target-host",
				"local-controller",
				"--required-capability",
				"browser",
				"--requester-thread-id",
				"remote-thread",
				"--effort",
				"low",
			], {})).toMatchObject({
				type: "workbench-handoff-enqueue",
				prompt: "test the dashboard locally",
				queue: "local",
				targetHost: "local-controller",
				requiredCapabilities: ["browser"],
				requesterThreadId: "remote-thread",
				effort: "low",
			});
			expect(parseArgs([
				"workbench",
				"handoff",
				"drain",
				"--host-id",
				"range-windows",
				"--capability",
				"browser",
				"--materialize",
				"--prompt-queue",
				"local-followups",
				"--limit",
				"1",
			], {})).toMatchObject({
				type: "workbench-handoff-drain",
				hostId: "range-windows",
				capabilities: ["browser"],
				materialize: true,
				promptQueue: "local-followups",
				limit: 1,
			});
			expect(parseArgs([
				"workbench",
				"deferred",
			"create",
			"--params-json",
			"{\"target\":{\"kind\":\"turn\",\"prompt\":\"review later\"}}",
		], {})).toMatchObject({
			type: "workbench-deferred-create",
			paramsText: "{\"target\":{\"kind\":\"turn\",\"prompt\":\"review later\"}}",
		});
		expect(parseArgs(["workbench", "deferred", "list", "--json"], {}))
			.toMatchObject({ type: "workbench-deferred-list", json: true });
		expect(parseArgs(["workbench", "deferred", "read", "later-1", "--include-output"], {}))
			.toMatchObject({ type: "workbench-deferred-read", intentId: "later-1", includeOutput: true });
		expect(parseArgs(["workbench", "deferred", "pull", "later-1"], {}))
			.toMatchObject({ type: "workbench-deferred-read", intentId: "later-1", includeOutput: true });
		expect(parseArgs(["workbench", "deferred", "collect", "--cursor", "operator", "--json"], {}))
			.toMatchObject({ type: "workbench-deferred-collect", cursor: "operator", json: true });
		expect(parseArgs(["workbench", "deferred", "retry", "later-1", "--run-at", "2026-01-02T00:00:00.000Z"], {}))
			.toMatchObject({
				type: "workbench-deferred-retry",
				intentId: "later-1",
				runAt: "2026-01-02T00:00:00.000Z",
			});
		expect(parseArgs(["workbench", "deferred", "run-due"], {}))
			.toMatchObject({ type: "workbench-deferred-run-due" });
		expect(parseArgs(["workbench", "deferred", "prune", "--older-than-days", "30", "--dry-run"], {}))
			.toMatchObject({ type: "workbench-deferred-prune", olderThanDays: 30, dryRun: true });
		expect(() => parseArgs(["workbench", "backend", "start"], {}))
			.toThrow("toybox service commands have been removed");
		expect(parseArgs(["workbench", "call", "delegation.list"], {}))
			.toMatchObject({ type: "workbench-call", method: "delegation.list" });
		expect(parseArgs(["memories", "transplant", "global-to-workbench", "--apply"], {}))
			.toMatchObject({ type: "memories-transplant", direction: "global-to-workbench", apply: true });
	});

	test("loads migrated workbench config and validates tasks", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `
[workbench]
name = "demo"

[[workbench.surfaces]]
key = "default"
kind = "local"
home_channel_id = "1"

[[workbench.tasks]]
id = "daily"
enabled = true
kind = "command"
command = ["node", "--version"]
schedule = "* * * * *"

[[workbench.reactive]]
id = "repair"
enabled = true
task = "*"
consecutive_failures_gte = 3
kind = "skill"
skill = "skill-repair"
`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "actions", env: {} });
		const config = await loadWorkbenchConfig(context);
		expect(config.name).toBe("demo");
		expect(config.surfaces[0]?.kind).toBe("local");
		expect(config.tasks.map((task) => task.id)).toEqual(["daily"]);
		expect(config.reactive[0]?.skill).toBe("skill-repair");
		expect(context.runtimeCodexHome).toBe(path.join(root, ".codex"));
		expect(context.stateRoot).toBe(path.join(root, ".codex", "workbench", "actions"));
		expect(context.actionsCommitPaths).toEqual([
			path.join(root, ".codex", "memories"),
			path.join(root, ".codex", "feed", "actions"),
			path.join(root, ".codex", "workbench", "actions"),
			path.join(root, ".codex", "sessions"),
		]);
	});

	test("local mode writes command runs only under local state root", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "hello"
enabled = true
kind = "command"
command = ["node", "-e", "console.log('hello')"]
`);
		const context = await createWorkbenchContext({
			workbenchRoot: root,
			mode: "local",
			env: { CODEX_HOME: "/tmp/global-codex-home" },
		});
		const run = await runWorkbenchTaskById(context, "hello", {
			callToybox: async () => {
				throw new Error("unused");
			},
		});
		expect(run.status).toBe("completed");
		expect(run.outputPath).toContain(path.join(".codex", "workbench", "local", "outputs"));
		expect(await readFile(path.join(root, ".codex", "workbench", "local", "runs", `${run.id}.json`), "utf8"))
			.toContain("\"taskId\": \"hello\"");
	});

	test("tick runs due command tasks once and doctor reports health", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "command-due"
enabled = true
kind = "command"
command = ["node", "-e", "console.log('done')"]
schedule = "* * * * *"
`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "actions", env: {} });
		const calls: unknown[] = [];
		const first = await tickWorkbench(context, {
			callToybox: async (_method, params) => {
				calls.push(params);
				return { ok: true };
			},
		});
		const second = await tickWorkbench(context, {
			callToybox: async (_method, params) => {
				calls.push(params);
				return { ok: true };
			},
		});
		expect(first.due).toEqual(["command-due"]);
		expect(second.due).toEqual([]);
		expect(calls).toHaveLength(0);
		const doctor = await collectWorkbenchDoctorInfo(context);
		expect(doctor.taskCount).toBe(1);
		expect(doctor.latestRun?.taskId).toBe("command-due");
		expect(doctor.deferredCount).toBe(1);
		expect(doctor.errors).toEqual([]);
	});

	test("doctor can report matching local systemd workbench tick runner", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "command-due"
enabled = true
kind = "command"
command = ["node", "-e", "console.log('done')"]
schedule = "* * * * *"
`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		const doctor = await collectWorkbenchDoctorInfo(context, {
			runnerProbe: async (args) => {
				if (args[0] === "list-timers") {
					return `Sat 2026-05-30 12:57:32 UTC 59s - - demo-workbench-tick.timer demo-workbench-tick.service\n`;
				}
				const unit = args[1];
				if (unit === "demo-workbench-tick.service") {
					return [
						"ActiveState=inactive",
						"UnitFileState=static",
						`ExecStart={ path=/usr/bin/codex-toys ; argv[]=/usr/bin/codex-toys workbench tick --mode local --workbench-root ${root} ; }`,
					].join("\n");
				}
				if (unit === "demo-workbench-tick.timer") {
					return [
						"ActiveState=active",
						"UnitFileState=enabled",
						"NextElapseUSecRealtime=Sat 2026-05-30 12:57:32 UTC",
						"LastTriggerUSec=Sat 2026-05-30 12:56:32 UTC",
					].join("\n");
				}
				throw new Error(`unexpected probe: ${args.join(" ")}`);
			},
		});
		expect(doctor.runner?.status).toBe("active");
		expect(doctor.runner?.selected?.timer).toBe("demo-workbench-tick.timer");
		expect(doctor.runner?.selected?.runsWorkbenchTick).toBe(true);
		expect(doctor.runner?.selected?.matchesWorkbench).toBe(true);
	});

	test("creates and runs one-shot deferred workbench task intents once", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "hello"
enabled = true
kind = "command"
command = ["node", "-e", "console.log('hello deferred')"]
`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		const intent = await createDeferredRunIntent(context, {
			runAt: "2026-01-01T00:00:00.000Z",
			target: {
				kind: "workbench-task",
				taskId: "hello",
			},
			reason: "one shot",
		});

		const first = await runDueDeferredRuns(context, {
			now: new Date("2026-01-01T00:00:01.000Z"),
			callToybox: async () => {
				throw new Error("unused");
			},
		});
		const second = await runDueDeferredRuns(context, {
			now: new Date("2026-01-01T00:00:02.000Z"),
			callToybox: async () => {
				throw new Error("unused");
			},
		});

		expect(first.executions).toHaveLength(1);
		expect(second.executions).toHaveLength(0);
		const read = await readDeferredRun(context, intent.id);
		expect(read.intent.status).toBe("completed");
		expect(read.attempts).toHaveLength(1);
		expect(read.attempts[0]?.status).toBe("completed");
		expect(read.outputs).toBeUndefined();
		const readWithOutput = await readDeferredRun(context, intent.id, { includeOutput: true });
		expect(readWithOutput.outputs).toHaveLength(1);
		expect(readWithOutput.outputs?.[0]).toMatchObject({
			attemptId: read.attempts[0]?.id,
		});
		expect((readWithOutput.outputs?.[0]?.output as { workbenchRun?: { taskId?: string } }).workbenchRun)
			.toMatchObject({ taskId: "hello" });
		const firstCollect = await collectDeferredRuns(context, { now: new Date("2026-01-01T00:00:03.000Z") });
		const secondCollect = await collectDeferredRuns(context, { now: new Date("2026-01-01T00:00:04.000Z") });
		const namedCollect = await collectDeferredRuns(context, {
			cursor: "operator",
			now: new Date("2026-01-01T00:00:05.000Z"),
		});
		expect(firstCollect.intents).toHaveLength(1);
		expect(firstCollect.cursorState.lastIntentId).toBe(intent.id);
		expect(firstCollect.intents[0]?.outputs).toHaveLength(1);
		expect(secondCollect.intents).toHaveLength(0);
		expect(secondCollect.previousCursor?.lastIntentId).toBe(intent.id);
		expect(namedCollect.intents.map((item) => item.intent.id)).toEqual([intent.id]);
		const workbenchRun = JSON.parse(await readFile(read.attempts[0]!.outputPath!, "utf8"))
			.workbenchRun as { taskId: string; status: string };
		expect(workbenchRun).toMatchObject({
			taskId: "hello",
			status: "completed",
		});
	});

	test("queues prompt intents and gates follow-up prompts on deferred completion", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `[workbench]\nname = "demo"\n`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		const parent = await enqueuePromptQueueIntent(context, {
			id: "parent-prompt",
			runAt: "2026-01-01T00:00:00.000Z",
			prompt: "Parent prompt",
			title: "parent",
			queue: "night",
			labels: ["low-priority"],
			effort: "low",
			serviceTier: "default",
		});
		const child = await enqueuePromptQueueIntent(context, {
			id: "child-prompt",
			runAt: "2026-01-01T00:00:00.000Z",
			prompt: "Child prompt",
			title: "child",
			queue: "night",
			afterIntentId: parent.id,
			afterStatus: "completed",
		});

		expect(parent).toMatchObject({
			id: "parent-prompt",
			target: {
				kind: "turn",
				prompt: "Parent prompt",
				effort: "low",
				serviceTier: "default",
			},
			source: {
				kind: "prompt-queue",
				queue: "night",
				title: "parent",
				labels: ["low-priority"],
			},
		});
		expect(child.dependsOn).toEqual([{
			kind: "deferred-run",
			intentId: parent.id,
			status: "completed",
		}]);
		expect((await listPromptQueueIntents(context, { queue: "night" })).map((intent) => intent.id))
			.toEqual([parent.id, child.id]);

		const callToybox = fakeCompletedTurnToybox();
		const first = await runDuePromptQueueIntents(context, {
			now: new Date("2026-01-01T00:00:01.000Z"),
			callToybox,
		});
		const blockedChild = await readDeferredRun(context, child.id);
		const second = await runDuePromptQueueIntents(context, {
			now: new Date("2026-01-01T00:00:02.000Z"),
			callToybox,
		});

		expect(first.executions.map((execution) => execution.intent.id)).toEqual([parent.id]);
		expect(blockedChild.intent.status).toBe("pending");
		expect(second.executions.map((execution) => execution.intent.id)).toEqual([child.id]);
		expect((await readDeferredRun(context, child.id)).intent.status).toBe("completed");

		const collected = await collectPromptQueueRuns(context, {
			queue: "night",
			now: new Date("2026-01-01T00:00:03.000Z"),
		});
		expect(collected.cursor).toBe("prompt-queue");
		expect(collected.intents.map((item) => item.intent.id)).toEqual([parent.id, child.id]);
		expect(collected.intents[0]?.outputs?.[0]?.output).toMatchObject({
			turn: {
				status: "completed",
				outputText: "done",
			},
		});
	});

	test("queues local handoffs and gates draining on host affinity and capabilities", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `[workbench]\nname = "demo"\n`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		const browserHandoff = await enqueueLocalHandoffIntent(context, {
			id: "browser-handoff",
			runAt: "2026-01-01T00:00:00.000Z",
			prompt: "Open the dashboard and smoke test it.",
			title: "dashboard smoke",
			queue: "local",
			targetHost: "local-controller",
			requiredCapabilities: ["browser"],
			requesterHost: "remote-linux",
			requesterThreadId: "remote-thread",
			effort: "low",
		});
		const hostHandoff = await enqueueLocalHandoffIntent(context, {
			id: "host-handoff",
			runAt: "2026-01-01T00:00:00.000Z",
			prompt: "Install the package locally.",
			title: "local package",
			queue: "local",
			targetHost: "range-windows",
			requiredCapabilities: ["plugin-install"],
		});

		expect(browserHandoff).toMatchObject({
			target: {
				kind: "turn",
				prompt: "Open the dashboard and smoke test it.",
				effort: "low",
			},
			source: {
				kind: "local-handoff",
				queue: "local",
				title: "dashboard smoke",
				targetHost: "local-controller",
				requiredCapabilities: ["browser"],
				requester: {
					host: "remote-linux",
					threadId: "remote-thread",
				},
			},
		});
		expect((await listLocalHandoffIntents(context, { queue: "local" })).map((intent) => intent.id))
			.toEqual([browserHandoff.id, hostHandoff.id]);

		const generic = await runDueDeferredRuns(context, {
			now: new Date("2026-01-01T00:00:01.000Z"),
			callToybox: fakeCompletedTurnToybox(),
		});
		const missingCapability = await drainLocalHandoffQueue(context, {
			now: new Date("2026-01-01T00:00:02.000Z"),
			callToybox: fakeCompletedTurnToybox(),
		});
		const browserDrain = await drainLocalHandoffQueue(context, {
			now: new Date("2026-01-01T00:00:03.000Z"),
			capabilities: ["browser"],
			callToybox: fakeCompletedTurnToybox(),
		});
		const hostDrain = await drainLocalHandoffQueue(context, {
			now: new Date("2026-01-01T00:00:04.000Z"),
			hostId: "range-windows",
			capabilities: ["plugin-install"],
			callToybox: fakeCompletedTurnToybox(),
		});

		expect(generic.executions).toHaveLength(0);
		expect(missingCapability.executions).toHaveLength(0);
		expect(browserDrain.executions.map((execution) => execution.intent.id)).toEqual([browserHandoff.id]);
		expect(hostDrain.executions.map((execution) => execution.intent.id)).toEqual([hostHandoff.id]);
		expect((await readDeferredRun(context, browserHandoff.id)).intent.status).toBe("completed");
		expect((await readDeferredRun(context, hostHandoff.id)).intent.status).toBe("completed");

		const collected = await collectLocalHandoffRuns(context, {
			queue: "local",
			now: new Date("2026-01-01T00:00:05.000Z"),
		});
		expect(collected.cursor).toBe("local-handoff");
		expect(collected.intents.map((item) => item.intent.id)).toEqual([browserHandoff.id, hostHandoff.id]);
	});

	test("materializes local handoffs into prompt queue intents", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `[workbench]\nname = "demo"\n`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		const handoff = await enqueueLocalHandoffIntent(context, {
			id: "materialize-handoff",
			runAt: "2026-01-01T00:00:00.000Z",
			prompt: "Update local plugins and run the browser smoke.",
			title: "local update",
			queue: "local",
			requiredCapabilities: ["browser"],
			model: "gpt-test",
			serviceTier: "default",
		});

		const result = await drainLocalHandoffQueue(context, {
			now: new Date("2026-01-01T00:00:01.000Z"),
			capabilities: ["browser"],
			action: "materialize",
			promptQueue: "local-followups",
			callToybox: async () => {
				throw new Error("materialize should not call the app server");
			},
		});
		const prompts = await listPromptQueueIntents(context, { queue: "local-followups" });

		expect(result.action).toBe("materialize");
		expect(result.executions).toHaveLength(1);
		expect(result.executions[0]?.output).toMatchObject({
			localHandoff: {
				action: "materialized",
				handoffIntentId: handoff.id,
				queue: "local-followups",
			},
		});
		expect((await readDeferredRun(context, handoff.id)).intent.status).toBe("completed");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatchObject({
			target: {
				kind: "turn",
				prompt: "Update local plugins and run the browser smoke.",
				model: "gpt-test",
				serviceTier: "default",
			},
			source: {
				kind: "prompt-queue",
				queue: "local-followups",
				title: "local update",
				details: {
					kind: "local-handoff-materialized",
					handoffIntentId: handoff.id,
				},
			},
		});
	});

	test("retries failed deferred intents as new pending intents without mutating history", async () => {
		const root = await tempWorkbench();
		const marker = path.join(root, "retry-ok");
		const command = [
			"node",
			"-e",
			`const fs = require("fs"); if (!fs.existsSync(${JSON.stringify(marker)})) { console.error("missing marker"); process.exit(2); } console.log("retry ok");`,
		];
		await writeWorkbenchToml(root, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "flaky"
enabled = true
kind = "command"
command = ${JSON.stringify(command)}
`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		const original = await createDeferredRunIntent(context, {
			runAt: "2026-01-01T00:00:00.000Z",
			target: {
				kind: "workbench-task",
				taskId: "flaky",
			},
			reason: "first attempt",
		});

		const failedRun = await runDueDeferredRuns(context, {
			now: new Date("2026-01-01T00:00:01.000Z"),
			callToybox: async () => {
				throw new Error("unused");
			},
		});
		expect(failedRun.executions[0]?.intent.status).toBe("failed");
		const failedRead = await readDeferredRun(context, original.id, { includeOutput: true });
		expect(failedRead.intent.status).toBe("failed");
		expect(failedRead.attempts).toHaveLength(1);
		expect(failedRead.outputs).toHaveLength(1);

		const retry = await retryDeferredRunIntent(
			context,
			original.id,
			{ id: original.id },
			{ now: new Date("2026-01-01T00:00:02.000Z") },
		);
		expect(retry.originalIntent).toMatchObject({
			id: original.id,
			status: "failed",
		});
		expect(retry.intent).toMatchObject({
			status: "pending",
			runAt: "2026-01-01T00:00:02.000Z",
			target: {
				kind: "workbench-task",
				taskId: "flaky",
			},
			createdBy: "workbench-deferred-retry",
			source: {
				kind: "deferred-retry",
				retry: {
					originalIntentId: original.id,
					originalStatus: "failed",
				},
			},
			attemptIds: [],
		});
		expect(retry.intent.id).not.toBe(original.id);

		const unchangedOriginal = await readDeferredRun(context, original.id, { includeOutput: true });
		expect(unchangedOriginal.intent).toEqual(failedRead.intent);
		expect(unchangedOriginal.attempts).toEqual(failedRead.attempts);
		expect(unchangedOriginal.outputs).toEqual(failedRead.outputs);

		await writeFile(marker, "ok");
		const retryRun = await runDueDeferredRuns(context, {
			now: new Date("2026-01-01T00:00:03.000Z"),
			callToybox: async () => {
				throw new Error("unused");
			},
		});
		expect(retryRun.executions).toHaveLength(1);
		expect(retryRun.executions[0]?.intent.id).toBe(retry.intent.id);
		expect(retryRun.executions[0]?.intent.status).toBe("completed");

		const retryRead = await readDeferredRun(context, retry.intent.id, { includeOutput: true });
		expect(retryRead.intent.status).toBe("completed");
		expect(retryRead.attempts).toHaveLength(1);
		expect((retryRead.outputs?.[0]?.output as { workbenchRun?: { taskId?: string; status?: string } }).workbenchRun)
			.toMatchObject({ taskId: "flaky", status: "completed" });
		expect((await readDeferredRun(context, original.id)).attempts).toHaveLength(1);
	});

	test("rejects retry for non-terminal deferred intents", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `[workbench]\nname = "demo"\n`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		const pending = await createDeferredRunIntent(context, {
			id: "pending-retry",
			target: {
				kind: "turn",
				prompt: "not yet",
			},
		});
		await expect(retryDeferredRunIntent(context, pending.id))
			.rejects.toThrow("Only terminal deferred runs can be retried");

		const running = await createDeferredRunIntent(context, {
			id: "running-retry",
			target: {
				kind: "turn",
				prompt: "in flight",
			},
		});
		const runningPath = path.join(
			root,
			".codex",
			"workbench",
			"local",
			"deferred",
			"intents",
			"running-retry.json",
		);
		await writeFile(runningPath, `${JSON.stringify({
			...running,
			status: "running",
			updatedAt: "2026-01-01T00:00:00.000Z",
		}, null, 2)}\n`);

		await expect(retryDeferredRunIntent(context, running.id))
			.rejects.toThrow("Only terminal deferred runs can be retried");
	});

	test("does not run future deferred intents and supports canceling pending work", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "hello"
enabled = true
kind = "command"
command = ["node", "--version"]
`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		const intent = await createDeferredRunIntent(context, {
			runAt: "2026-01-02T00:00:00.000Z",
			target: {
				kind: "workbench-task",
				taskId: "hello",
			},
		});

		const result = await runDueDeferredRuns(context, {
			now: new Date("2026-01-01T23:59:59.000Z"),
			callToybox: async () => {
				throw new Error("unused");
			},
		});
		expect(result.executions).toEqual([]);
		expect((await cancelDeferredRunIntent(context, intent.id)).status).toBe("canceled");
	});

	test("prunes only terminal deferred run history older than the retention window", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "hello"
enabled = true
kind = "command"
command = ["node", "-e", "console.log('prune me')"]
`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		const completed = await createDeferredRunIntent(context, {
			runAt: "2026-01-01T00:00:00.000Z",
			target: {
				kind: "workbench-task",
				taskId: "hello",
			},
		});
		const pending = await createDeferredRunIntent(context, {
			runAt: "2100-01-01T00:00:00.000Z",
			target: {
				kind: "workbench-task",
				taskId: "hello",
			},
		});

		await runDueDeferredRuns(context, {
			now: new Date("2026-01-01T00:00:01.000Z"),
			callToybox: async () => {
				throw new Error("unused");
			},
		});
		const before = await readDeferredRun(context, completed.id);
		const outputPath = before.attempts[0]?.outputPath;
		expect(outputPath).toBeTruthy();
		const dryRun = await pruneDeferredRunHistory(context, {
			olderThanDays: 1,
			dryRun: true,
			now: new Date("2100-01-03T00:00:00.000Z"),
		});
		expect(dryRun.pruned).toBe(1);
		expect(await readFile(outputPath!, "utf8")).toContain("workbenchRun");

		const pruned = await pruneDeferredRunHistory(context, {
			olderThanDays: 1,
			now: new Date("2100-01-03T00:00:00.000Z"),
		});
		expect(pruned.pruned).toBe(1);
		await expect(readDeferredRun(context, completed.id)).rejects.toThrow("Unknown deferred run");
		await expect(readFile(outputPath!, "utf8")).rejects.toThrow();
		expect((await readDeferredRun(context, pending.id)).intent.status).toBe("pending");
	});

	test("runs direct turn deferred intents through app-server pass-through", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `[workbench]\nname = "demo"\n`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		await createDeferredRunIntent(context, {
			runAt: "2026-01-01T00:00:00.000Z",
			target: {
				kind: "turn",
				prompt: "Review the workbench later.",
				cwd: root,
			},
		});
		const calls: Array<{ method: string; params: unknown }> = [];
		const result = await runDueDeferredRuns(context, {
			now: new Date("2026-01-01T00:00:01.000Z"),
			callToybox: async (method, params) => {
				calls.push({ method, params });
				const appMethod = String((params as { method?: unknown }).method);
				if (appMethod === "thread/start") {
					return { thread: { id: "thread-1" } };
				}
				if (appMethod === "turn/start") {
					return { turn: { id: "turn-1" } };
				}
				if (appMethod === "thread/read") {
					return {
						thread: {
							turns: [{
								id: "turn-1",
								status: "completed",
								items: [{
									type: "agentMessage",
									phase: "final_answer",
									text: "Done",
								}],
							}],
						},
					};
				}
				return { ok: true };
			},
		});

		expect(result.executions).toHaveLength(1);
		expect(result.executions[0]?.intent.status).toBe("completed");
		expect(calls.map((call) => (call.params as { method?: string }).method)).toEqual([
			"thread/start",
			"turn/start",
			"thread/read",
		]);
	});

	test("rejects retired deferred target kind", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `[workbench]\nname = "demo"\n`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		const retired = ["auto", "mation"].join("");
		await expect(createDeferredRunIntent(context, {
			target: {
				kind: retired,
				[retired]: "release-check",
			},
		} as never)).rejects.toThrow("Invalid deferred run target kind");
	});

	test("runs direct workflow deferred intents through the workflow host", async () => {
		const root = await tempWorkbench();
		const workflowRoot = path.join(root, "workflows", "release-check");
		await mkdir(workflowRoot, { recursive: true });
		await writeFile(path.join(workflowRoot, "workflow.json"), JSON.stringify({
			script: "check.ts",
			prompt: "inspect",
		}));
		await writeFile(path.join(workflowRoot, "check.ts"), `
export default async function run(context) {
  return {
    status: "skipped",
    reason: context.event.payload.reason
  };
}
`);
		await writeWorkbenchToml(root, `[workbench]\nname = "demo"\n`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		await createDeferredRunIntent(context, {
			runAt: "2026-01-01T00:00:00.000Z",
			target: {
				kind: "workflow",
				workflow: "release-check",
				event: {
					type: "manual.review",
					payload: {
						reason: "later",
					},
				},
			},
		});

		const result = await runDueDeferredRuns(context, {
			now: new Date("2026-01-01T00:00:01.000Z"),
			callToybox: async () => {
				throw new Error("unused");
			},
		});

		expect(result.executions).toHaveLength(1);
		expect(result.executions[0]?.intent.status).toBe("completed");
		expect(result.executions[0]?.output).toMatchObject({
			status: "skipped",
			reason: "later",
		});
	});

	test("keeps local and actions deferred queues separate", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `[workbench]\nname = "demo"\n`);
		const local = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		const actions = await createWorkbenchContext({ workbenchRoot: root, mode: "actions", env: {} });
		await createDeferredRunIntent(local, {
			target: {
				kind: "turn",
				prompt: "local review",
			},
		});
		await createDeferredRunIntent(actions, {
			target: {
				kind: "turn",
				prompt: "actions review",
			},
		});

		expect(await listDeferredRunIntents(local)).toHaveLength(1);
		expect(await listDeferredRunIntents(actions)).toHaveLength(1);
		expect((await listDeferredRunIntents(local))[0]?.target).toMatchObject({
			kind: "turn",
			prompt: "local review",
		});
		expect((await listDeferredRunIntents(actions))[0]?.target).toMatchObject({
			kind: "turn",
			prompt: "actions review",
		});
	});

	test("claims due deferred intents once across overlapping runners", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "slow"
enabled = true
kind = "command"
command = ["node", "-e", "setTimeout(() => console.log('done'), 100)"]
`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		await createDeferredRunIntent(context, {
			runAt: "2026-01-01T00:00:00.000Z",
			target: {
				kind: "workbench-task",
				taskId: "slow",
			},
		});
		const [left, right] = await Promise.all([
			runDueDeferredRuns(context, {
				now: new Date("2026-01-01T00:00:01.000Z"),
				callToybox: async () => {
					throw new Error("unused");
				},
			}),
			runDueDeferredRuns(context, {
				now: new Date("2026-01-01T00:00:01.000Z"),
				callToybox: async () => {
					throw new Error("unused");
				},
			}),
		]);

		expect(left.executions.length + right.executions.length).toBe(1);
	});

	test("workflow tasks run scripts and start turns through toybox", async () => {
		const root = await tempWorkbench();
		const workflowRoot = path.join(root, "workflows", "release-check");
		await mkdir(workflowRoot, { recursive: true });
		await writeFile(path.join(workflowRoot, "workflow.json"), JSON.stringify({
			script: "check.ts",
			prompt: "inspect",
			cwd: "/manifest-cwd",
			skills: ["release-skill"],
		}));
		await writeFile(path.join(workflowRoot, "check.ts"), `
export default async function run(context) {
  const turn = await context.turn.start({
    prompt: context.prompt + " " + context.event.payload.tag
  });
  return {
    status: "started",
    turn
  };
}
`);
		await writeWorkbenchToml(root, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "workflow-task"
enabled = true
kind = "workflow"
workflow = "release-check"
cwd = "/remote-cwd"

[workbench.tasks.event]
type = "upstream.release"

[workbench.tasks.event.payload]
tag = "v1.2.3"
`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		const calls: Array<{ method: string; params: unknown }> = [];
		const run = await runWorkbenchTaskById(context, "workflow-task", {
			callToybox: async (method, params) => {
				calls.push({ method, params });
				const appMethod = String((params as { method?: unknown }).method);
				if (appMethod === "thread/start") {
					return { thread: { id: "thread-1" } };
				}
				if (appMethod === "turn/start") {
					return { turn: { id: "turn-1" } };
				}
				return { ok: true };
			},
		});
		expect(run.status).toBe("completed");
		expect(calls).toEqual([
			expect.objectContaining({
				method: "app.call",
				params: expect.objectContaining({
					method: "thread/start",
					params: expect.objectContaining({
						cwd: "/remote-cwd",
					}),
				}),
			}),
			expect.objectContaining({
				method: "app.call",
				params: expect.objectContaining({
					method: "turn/start",
					params: expect.objectContaining({
						threadId: "thread-1",
						cwd: "/remote-cwd",
					}),
				}),
			}),
		]);
		const output = JSON.parse(await readFile(run.outputPath!, "utf8")) as Record<string, unknown>;
		expect(output).toMatchObject({
			status: "started",
			turn: {
				threadId: "thread-1",
				turnId: "turn-1",
			},
		});
	});

	test("workflow tasks can receive an explicit feed item event", async () => {
		const root = await tempWorkbench();
		const workflowRoot = path.join(root, "workflows", "feed-target");
		await mkdir(workflowRoot, { recursive: true });
		await writeFile(path.join(workflowRoot, "workflow.json"), JSON.stringify({
			script: "target.ts",
		}));
		await writeFile(path.join(workflowRoot, "target.ts"), `
export default async function run(context) {
  return {
    eventType: context.event.type,
    source: context.event.source,
    title: context.event.payload.title
  };
}
`);
		await writeWorkbenchToml(root, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "feed-target"
enabled = true
kind = "workflow"
workflow = "feed-target"

[workbench.tasks.event]
type = "static.event"
`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		const run = await runWorkbenchTaskById(context, "feed-target", {
			callToybox: async () => {
				throw new Error("unused");
			},
			event: {
				id: "feed:item-1",
				type: "feed.item",
				source: "cli-utility-releases",
				occurredAt: "2026-06-01T22:39:32.000Z",
				receivedAt: "2026-06-01T22:40:00.000Z",
				payload: {
					id: "item-1",
					title: "cli-utility v0.1.2",
				},
			},
		});
		expect(run.status).toBe("completed");
		const output = JSON.parse(await readFile(run.outputPath!, "utf8")) as Record<string, unknown>;
		expect(output).toEqual({
			eventType: "feed.item",
			source: "cli-utility-releases",
			title: "cli-utility v0.1.2",
		});
	});

	test("run records disabled tasks as skipped", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "disabled"
enabled = false
kind = "command"
command = ["node", "--version"]
`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		const run = await runWorkbenchTaskById(context, "disabled", {
			callToybox: async () => {
				throw new Error("unused");
			},
		});
		expect(run.status).toBe("skipped");
	});

	test("reactive rules fire after the configured failure threshold", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "watched"
enabled = true
kind = "command"
command = ["node", "--version"]

[[workbench.reactive]]
id = "repair"
enabled = true
task = "watched"
consecutive_failures_gte = 3
kind = "skill"
skill = "missing-repair-skill"
`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "actions", env: {} });
		await mkdir(path.join(context.stateRoot, "runs"), { recursive: true });
		for (const index of [1, 2, 3]) {
			await writeFile(path.join(context.stateRoot, "runs", `failed-${index}.json`), JSON.stringify({
				id: `failed-${index}`,
				taskId: "watched",
				status: "failed",
				kind: "command",
				startedAt: `2026-01-0${index}T00:00:00.000Z`,
				finishedAt: `2026-01-0${index}T00:00:01.000Z`,
				mode: "actions",
			}));
		}
		const result = await tickWorkbench(context, {
			callToybox: async () => {
				throw new Error("unused");
			},
		});
		expect(result.runs.some((run) => run.taskId === "repair")).toBe(true);
		expect(result.runs.find((run) => run.taskId === "repair")?.status).toBe("failed");
	});

	test("rejects invalid task ids, kinds, and schedules", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "bad id"
kind = "command"
command = ["node", "--version"]
schedule = "not-cron"
`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "local", env: {} });
		await expect(loadWorkbenchConfig(context)).rejects.toThrow("Invalid workbench task id");
		const badKind = await tempWorkbench();
		await writeWorkbenchToml(badKind, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "bad-kind"
kind = "unknown"
`);
		await expect(loadWorkbenchConfig(await createWorkbenchContext({ workbenchRoot: badKind, mode: "local", env: {} })))
			.rejects.toThrow("Invalid workbench task kind");
		const retiredKind = await tempWorkbench();
		const retired = ["auto", "mation"].join("");
		await writeWorkbenchToml(retiredKind, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "retired-kind"
kind = "${retired}"
${retired} = "release-check"
`);
		await expect(loadWorkbenchConfig(await createWorkbenchContext({ workbenchRoot: retiredKind, mode: "local", env: {} })))
			.rejects.toThrow("Invalid workbench task kind");
		const badSchedule = await tempWorkbench();
		await writeWorkbenchToml(badSchedule, `
[workbench]
name = "demo"

[[workbench.tasks]]
id = "bad-schedule"
kind = "command"
command = ["node", "--version"]
schedule = "not-cron"
`);
		await expect(loadWorkbenchConfig(await createWorkbenchContext({ workbenchRoot: badSchedule, mode: "local", env: {} })))
			.rejects.toThrow("Invalid workbench task schedule");
	});

	test("actions commit helper is gated outside GitHub Actions", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `[workbench]\nname = "demo"\n`);
		const context = await createWorkbenchContext({ workbenchRoot: root, mode: "actions", env: {} });
		expect(await commitActionsWorkbenchState(context, { env: {} })).toEqual({
			attempted: false,
			committed: false,
			paths: [
				path.join(root, ".codex", "memories"),
				path.join(root, ".codex", "feed", "actions"),
				path.join(root, ".codex", "workbench", "actions"),
				path.join(root, ".codex", "sessions"),
			],
		});
	});

	test("actions commit helper commits staged optional state paths only", async () => {
		const root = await tempWorkbench();
		await writeWorkbenchToml(root, `[workbench]\nname = "demo"\n`);
		await runGit(["init"], root);
		await mkdir(path.join(root, ".codex", "workbench", "actions"), { recursive: true });
		await writeFile(path.join(root, ".codex", "workbench", "actions", "summary.json"), "{}\n");

		const context = await createWorkbenchContext({
			workbenchRoot: root,
			mode: "actions",
			env: { GITHUB_ACTIONS: "true" },
		});
		const result = await commitActionsWorkbenchState(context, {
			env: { GITHUB_ACTIONS: "true" },
			message: "Update test workbench state",
		});

		expect(result.committed).toBe(true);
		expect(await runGit(["log", "-1", "--pretty=%s"], root)).toBe("Update test workbench state");
		expect(await runGit(["log", "-1", "--pretty=%an <%ae>"], root))
			.toBe("codex-toys-actions <codex-toys-actions@users.noreply.github.com>");
		const committedFiles = await runGit(["show", "--name-only", "--pretty=", "HEAD"], root);
		expect(committedFiles).toContain(".codex/workbench/actions/summary.json");
		expect(committedFiles).not.toContain(".codex/memories");
		expect(committedFiles).not.toContain(".codex/sessions");
	});

	test("scaffoldActionsWorkbench creates Actions config, workflows, and gitignore entries", async () => {
		const root = await tempWorkbench();
		await writeFile(path.join(root, ".gitignore"), ".codex/sessions/\n");
		const result = await scaffoldActionsWorkbench({
			workbenchRoot: root,
			forgejo: true,
		});
		expect(result.files.some((file) => file.path.endsWith(".codex/workbench.toml"))).toBe(true);
		expect(await readFile(path.join(root, ".codex", "workbench.toml"), "utf8"))
			.toContain("[workbench]");
		expect(await readFile(path.join(root, ".codex", "config.toml"), "utf8"))
			.toContain("repository-scoped Actions");
		expect(await readFile(path.join(root, ".forgejo", "workflows", "codex-toys-actions.yml"), "utf8"))
			.toContain("codex-toys actions prepare-auth");
		expect(await readFile(path.join(root, ".forgejo", "workflows", "codex-toys-actions.yml"), "utf8"))
			.toContain("codex-toys actions cleanup");
		const workflow = await readFile(path.join(root, ".forgejo", "workflows", "codex-toys-actions.yml"), "utf8");
		expect(workflow).toContain(`image: ${defaultActionsRunnerImage}`);
		expect(workflow).toContain("git config --global --add safe.directory");
		expect(workflow).not.toContain("actions/setup-node");
		expect(workflow).not.toContain("vp dlx codex-toys");
		expect(workflow).toContain("git add -- .codex/memories .codex/workbench/actions");
		expect(workflow).toContain("git add -- .codex/feed/actions");
		expect(workflow).toContain("git add -A -f -- .codex/sessions");
		const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
		expect(gitignore).toContain(".codex/auth.json");
		expect(gitignore).not.toContain(".codex/sessions/");
	});

	test("scaffoldActionsWorkbench accepts custom and setup-based Actions runtimes", async () => {
		const customRoot = await tempWorkbench();
		await scaffoldActionsWorkbench({
			workbenchRoot: customRoot,
			github: true,
			runnerImage: "ghcr.io/example/custom-codex-runner:2026-06",
		});
		const customWorkflow = await readFile(
			path.join(customRoot, ".github", "workflows", "codex-toys-actions.yml"),
			"utf8",
		);
		expect(customWorkflow).toContain("image: ghcr.io/example/custom-codex-runner:2026-06");
		expect(customWorkflow).toContain("codex-toys workbench tick --mode actions");

		const setupRoot = await tempWorkbench();
		await scaffoldActionsWorkbench({
			workbenchRoot: setupRoot,
			github: true,
			runnerImage: null,
		});
		const setupWorkflow = await readFile(
			path.join(setupRoot, ".github", "workflows", "codex-toys-actions.yml"),
			"utf8",
		);
		expect(setupWorkflow).not.toContain("container:");
		expect(setupWorkflow).toContain("actions/setup-node");
		expect(setupWorkflow).toContain("vp dlx codex-toys workbench tick --mode actions");
	});
});

async function tempWorkbench(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "codex-workbench-autonomy-"));
	await mkdir(path.join(root, ".codex"), { recursive: true });
	return root;
}

async function writeWorkbenchToml(root: string, text: string): Promise<void> {
	await mkdir(path.join(root, ".codex"), { recursive: true });
	await writeFile(path.join(root, ".codex", "workbench.toml"), text.trimStart());
}

async function runGit(args: string[], cwd: string): Promise<string> {
	const result = await execFile("git", args, { cwd });
	return result.stdout.trim();
}

function fakeCompletedTurnToybox(): (method: string, params: unknown) => Promise<unknown> {
	let threadCount = 0;
	let turnCount = 0;
	const turnsByThread = new Map<string, string[]>();
	return async (method, params) => {
		if (method !== "app.call") {
			throw new Error(`unexpected toybox method: ${method}`);
		}
		const call = params as { method: string; params?: Record<string, unknown> };
		if (call.method === "thread/start") {
			threadCount += 1;
			const id = `thread-${threadCount}`;
			turnsByThread.set(id, []);
			return { thread: { id, turns: [] } };
		}
		if (call.method === "turn/start") {
			turnCount += 1;
			const id = `turn-${turnCount}`;
			const threadId = String(call.params?.threadId);
			turnsByThread.set(threadId, [...(turnsByThread.get(threadId) ?? []), id]);
			return { turn: { id } };
		}
		if (call.method === "thread/read") {
			const threadId = String(call.params?.threadId);
			return {
				thread: {
					id: threadId,
					turns: (turnsByThread.get(threadId) ?? []).map((id) => ({
						id,
						status: "completed",
						items: [{
							type: "agentMessage",
							phase: "final_answer",
							text: "done",
						}],
					})),
				},
			};
		}
		throw new Error(`unexpected app method: ${call.method}`);
	};
}
