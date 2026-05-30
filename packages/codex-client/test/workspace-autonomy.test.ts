import { describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import {
	cancelDeferredRunIntent,
	collectDeferredRuns,
	collectWorkspaceDoctorInfo,
	createDeferredRunIntent,
	createWorkspaceContext,
	listDeferredRunIntents,
	loadWorkspaceConfig,
	pruneDeferredRunHistory,
	readDeferredRun,
	resolveWorkspaceMode,
	runDueDeferredRuns,
	runWorkspaceTaskById,
	scaffoldActionsWorkspace,
	tickWorkspace,
	commitActionsWorkspaceState,
} from "../src/cli/workspace-autonomy.ts";

describe("workspace autonomy", () => {
	test("resolves auto mode from GitHub Actions", () => {
		expect(resolveWorkspaceMode("auto", { GITHUB_ACTIONS: "true" })).toEqual({
			requestedMode: "auto",
			mode: "actions",
		});
		expect(resolveWorkspaceMode("auto", {})).toEqual({
			requestedMode: "auto",
			mode: "local",
		});
		expect(resolveWorkspaceMode("actions", {})).toEqual({
			requestedMode: "actions",
			mode: "actions",
		});
	});

	test("Actions mode ignores external CODEX_HOME while local mode honors it", async () => {
		const root = await tempWorkspace();
		const externalHome = path.join(root, "external-codex-home");
		const actions = await createWorkspaceContext({
			workspaceRoot: root,
			mode: "actions",
			env: { CODEX_HOME: externalHome },
		});
		expect(actions.runtimeCodexHome).toBe(path.join(root, ".codex"));
		expect(actions.workspaceCodexHome).toBe(path.join(root, ".codex"));
		expect(actions.globalCodexHome).toBe(externalHome);

		const local = await createWorkspaceContext({
			workspaceRoot: root,
			mode: "local",
			env: { CODEX_HOME: externalHome },
		});
		expect(local.runtimeCodexHome).toBe(externalHome);
		expect(local.workspaceCodexHome).toBe(path.join(root, ".codex"));
	});

	test("parses workspace and memories commands without disturbing JSON-RPC commands", () => {
		expect(parseArgs(["workspace", "doctor", "--mode", "actions"], {}))
			.toMatchObject({ type: "workspace-doctor", mode: "actions" });
		expect(parseArgs(["workspace", "tick", "--workspace-root", "/tmp/work"], {}))
			.toMatchObject({ type: "workspace-tick", workspaceRoot: "/tmp/work" });
		expect(parseArgs(["workspace", "run", "morning-brief"], {}))
			.toMatchObject({ type: "workspace-run", taskId: "morning-brief" });
		expect(parseArgs([
			"workspace",
			"deferred",
			"create",
			"--params-json",
			"{\"target\":{\"kind\":\"turn\",\"prompt\":\"review later\"}}",
		], {})).toMatchObject({
			type: "workspace-deferred-create",
			paramsText: "{\"target\":{\"kind\":\"turn\",\"prompt\":\"review later\"}}",
		});
		expect(parseArgs(["workspace", "deferred", "list", "--json"], {}))
			.toMatchObject({ type: "workspace-deferred-list", json: true });
		expect(parseArgs(["workspace", "deferred", "read", "later-1", "--include-output"], {}))
			.toMatchObject({ type: "workspace-deferred-read", intentId: "later-1", includeOutput: true });
		expect(parseArgs(["workspace", "deferred", "pull", "later-1"], {}))
			.toMatchObject({ type: "workspace-deferred-read", intentId: "later-1", includeOutput: true });
		expect(parseArgs(["workspace", "deferred", "collect", "--cursor", "operator", "--json"], {}))
			.toMatchObject({ type: "workspace-deferred-collect", cursor: "operator", json: true });
		expect(parseArgs(["workspace", "deferred", "run-due"], {}))
			.toMatchObject({ type: "workspace-deferred-run-due" });
		expect(parseArgs(["workspace", "deferred", "prune", "--older-than-days", "30", "--dry-run"], {}))
			.toMatchObject({ type: "workspace-deferred-prune", olderThanDays: 30, dryRun: true });
		expect(() => parseArgs(["workspace", "backend", "start"], {}))
			.toThrow("toybox service commands have been removed");
		expect(parseArgs(["workspace", "call", "delegation.list"], {}))
			.toMatchObject({ type: "workspace-call", method: "delegation.list" });
		expect(parseArgs(["memories", "transplant", "global-to-workspace", "--apply"], {}))
			.toMatchObject({ type: "memories-transplant", direction: "global-to-workspace", apply: true });
	});

	test("loads migrated workspace config and validates tasks", async () => {
		const root = await tempWorkspace();
		await writeWorkspaceToml(root, `
[workspace]
name = "demo"

[[workspace.surfaces]]
key = "default"
kind = "local"
home_channel_id = "1"

[[workspace.tasks]]
id = "daily"
enabled = true
kind = "command"
command = ["node", "--version"]
schedule = "* * * * *"

[[workspace.reactive]]
id = "repair"
enabled = true
task = "*"
consecutive_failures_gte = 3
kind = "skill"
skill = "skill-repair"
`);
		const context = await createWorkspaceContext({ workspaceRoot: root, mode: "actions", env: {} });
		const config = await loadWorkspaceConfig(context);
		expect(config.name).toBe("demo");
		expect(config.surfaces[0]?.kind).toBe("local");
		expect(config.tasks.map((task) => task.id)).toEqual(["daily"]);
		expect(config.reactive[0]?.skill).toBe("skill-repair");
		expect(context.runtimeCodexHome).toBe(path.join(root, ".codex"));
		expect(context.stateRoot).toBe(path.join(root, ".codex", "workspace", "actions"));
		expect(context.actionsCommitPaths).toEqual([
			path.join(root, ".codex", "memories"),
			path.join(root, ".codex", "workspace", "actions"),
		]);
	});

	test("local mode writes command runs only under local state root", async () => {
		const root = await tempWorkspace();
		await writeWorkspaceToml(root, `
[workspace]
name = "demo"

[[workspace.tasks]]
id = "hello"
enabled = true
kind = "command"
command = ["node", "-e", "console.log('hello')"]
`);
		const context = await createWorkspaceContext({
			workspaceRoot: root,
			mode: "local",
			env: { CODEX_HOME: "/tmp/global-codex-home" },
		});
		const run = await runWorkspaceTaskById(context, "hello", {
			callToybox: async () => {
				throw new Error("unused");
			},
		});
		expect(run.status).toBe("completed");
		expect(run.outputPath).toContain(path.join(".codex", "workspace", "local", "outputs"));
		expect(await readFile(path.join(root, ".codex", "workspace", "local", "runs", `${run.id}.json`), "utf8"))
			.toContain("\"taskId\": \"hello\"");
	});

	test("tick runs due command tasks once and doctor reports health", async () => {
		const root = await tempWorkspace();
		await writeWorkspaceToml(root, `
[workspace]
name = "demo"

[[workspace.tasks]]
id = "command-due"
enabled = true
kind = "command"
command = ["node", "-e", "console.log('done')"]
schedule = "* * * * *"
`);
		const context = await createWorkspaceContext({ workspaceRoot: root, mode: "actions", env: {} });
		const calls: unknown[] = [];
		const first = await tickWorkspace(context, {
			callToybox: async (_method, params) => {
				calls.push(params);
				return { ok: true };
			},
		});
		const second = await tickWorkspace(context, {
			callToybox: async (_method, params) => {
				calls.push(params);
				return { ok: true };
			},
		});
		expect(first.due).toEqual(["command-due"]);
		expect(second.due).toEqual([]);
		expect(calls).toHaveLength(0);
		const doctor = await collectWorkspaceDoctorInfo(context);
		expect(doctor.taskCount).toBe(1);
		expect(doctor.latestRun?.taskId).toBe("command-due");
		expect(doctor.deferredCount).toBe(1);
		expect(doctor.errors).toEqual([]);
	});

	test("creates and runs one-shot deferred workspace task intents once", async () => {
		const root = await tempWorkspace();
		await writeWorkspaceToml(root, `
[workspace]
name = "demo"

[[workspace.tasks]]
id = "hello"
enabled = true
kind = "command"
command = ["node", "-e", "console.log('hello deferred')"]
`);
		const context = await createWorkspaceContext({ workspaceRoot: root, mode: "local", env: {} });
		const intent = await createDeferredRunIntent(context, {
			runAt: "2026-01-01T00:00:00.000Z",
			target: {
				kind: "workspace-task",
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
		expect((readWithOutput.outputs?.[0]?.output as { workspaceRun?: { taskId?: string } }).workspaceRun)
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
		const workspaceRun = JSON.parse(await readFile(read.attempts[0]!.outputPath!, "utf8"))
			.workspaceRun as { taskId: string; status: string };
		expect(workspaceRun).toMatchObject({
			taskId: "hello",
			status: "completed",
		});
	});

	test("does not run future deferred intents and supports canceling pending work", async () => {
		const root = await tempWorkspace();
		await writeWorkspaceToml(root, `
[workspace]
name = "demo"

[[workspace.tasks]]
id = "hello"
enabled = true
kind = "command"
command = ["node", "--version"]
`);
		const context = await createWorkspaceContext({ workspaceRoot: root, mode: "local", env: {} });
		const intent = await createDeferredRunIntent(context, {
			runAt: "2026-01-02T00:00:00.000Z",
			target: {
				kind: "workspace-task",
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
		const root = await tempWorkspace();
		await writeWorkspaceToml(root, `
[workspace]
name = "demo"

[[workspace.tasks]]
id = "hello"
enabled = true
kind = "command"
command = ["node", "-e", "console.log('prune me')"]
`);
		const context = await createWorkspaceContext({ workspaceRoot: root, mode: "local", env: {} });
		const completed = await createDeferredRunIntent(context, {
			runAt: "2026-01-01T00:00:00.000Z",
			target: {
				kind: "workspace-task",
				taskId: "hello",
			},
		});
		const pending = await createDeferredRunIntent(context, {
			runAt: "2100-01-01T00:00:00.000Z",
			target: {
				kind: "workspace-task",
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
		expect(await readFile(outputPath!, "utf8")).toContain("workspaceRun");

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
		const root = await tempWorkspace();
		await writeWorkspaceToml(root, `[workspace]\nname = "demo"\n`);
		const context = await createWorkspaceContext({ workspaceRoot: root, mode: "local", env: {} });
		await createDeferredRunIntent(context, {
			runAt: "2026-01-01T00:00:00.000Z",
			target: {
				kind: "turn",
				prompt: "Review the workspace later.",
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

	test("runs direct automation deferred intents through the turn automation host", async () => {
		const root = await tempWorkspace();
		const automationRoot = path.join(root, "automations", "release-check");
		await mkdir(automationRoot, { recursive: true });
		await writeFile(path.join(automationRoot, "automation.json"), JSON.stringify({
			script: "check.ts",
			prompt: "inspect",
		}));
		await writeFile(path.join(automationRoot, "check.ts"), `
export default async function run(context) {
  return {
    status: "skipped",
    reason: context.event.payload.reason
  };
}
`);
		await writeWorkspaceToml(root, `[workspace]\nname = "demo"\n`);
		const context = await createWorkspaceContext({ workspaceRoot: root, mode: "local", env: {} });
		await createDeferredRunIntent(context, {
			runAt: "2026-01-01T00:00:00.000Z",
			target: {
				kind: "automation",
				automation: "release-check",
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
		const root = await tempWorkspace();
		await writeWorkspaceToml(root, `[workspace]\nname = "demo"\n`);
		const local = await createWorkspaceContext({ workspaceRoot: root, mode: "local", env: {} });
		const actions = await createWorkspaceContext({ workspaceRoot: root, mode: "actions", env: {} });
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
		const root = await tempWorkspace();
		await writeWorkspaceToml(root, `
[workspace]
name = "demo"

[[workspace.tasks]]
id = "slow"
enabled = true
kind = "command"
command = ["node", "-e", "setTimeout(() => console.log('done'), 100)"]
`);
		const context = await createWorkspaceContext({ workspaceRoot: root, mode: "local", env: {} });
		await createDeferredRunIntent(context, {
			runAt: "2026-01-01T00:00:00.000Z",
			target: {
				kind: "workspace-task",
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

	test("automation tasks run scripts and start turns through toybox", async () => {
		const root = await tempWorkspace();
		const automationRoot = path.join(root, "automations", "release-check");
		await mkdir(automationRoot, { recursive: true });
		await writeFile(path.join(automationRoot, "automation.json"), JSON.stringify({
			script: "check.ts",
			prompt: "inspect",
			cwd: "/manifest-cwd",
			skills: ["release-skill"],
		}));
		await writeFile(path.join(automationRoot, "check.ts"), `
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
		await writeWorkspaceToml(root, `
[workspace]
name = "demo"

[[workspace.tasks]]
id = "automation-task"
enabled = true
kind = "automation"
automation = "release-check"
cwd = "/remote-cwd"

[workspace.tasks.event]
type = "upstream.release"

[workspace.tasks.event.payload]
tag = "v1.2.3"
`);
		const context = await createWorkspaceContext({ workspaceRoot: root, mode: "local", env: {} });
		const calls: Array<{ method: string; params: unknown }> = [];
		const run = await runWorkspaceTaskById(context, "automation-task", {
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

	test("run records disabled tasks as skipped", async () => {
		const root = await tempWorkspace();
		await writeWorkspaceToml(root, `
[workspace]
name = "demo"

[[workspace.tasks]]
id = "disabled"
enabled = false
kind = "command"
command = ["node", "--version"]
`);
		const context = await createWorkspaceContext({ workspaceRoot: root, mode: "local", env: {} });
		const run = await runWorkspaceTaskById(context, "disabled", {
			callToybox: async () => {
				throw new Error("unused");
			},
		});
		expect(run.status).toBe("skipped");
	});

	test("reactive rules fire after the configured failure threshold", async () => {
		const root = await tempWorkspace();
		await writeWorkspaceToml(root, `
[workspace]
name = "demo"

[[workspace.tasks]]
id = "watched"
enabled = true
kind = "command"
command = ["node", "--version"]

[[workspace.reactive]]
id = "repair"
enabled = true
task = "watched"
consecutive_failures_gte = 3
kind = "skill"
skill = "missing-repair-skill"
`);
		const context = await createWorkspaceContext({ workspaceRoot: root, mode: "actions", env: {} });
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
		const result = await tickWorkspace(context, {
			callToybox: async () => {
				throw new Error("unused");
			},
		});
		expect(result.runs.some((run) => run.taskId === "repair")).toBe(true);
		expect(result.runs.find((run) => run.taskId === "repair")?.status).toBe("failed");
	});

	test("rejects invalid task ids, kinds, and schedules", async () => {
		const root = await tempWorkspace();
		await writeWorkspaceToml(root, `
[workspace]
name = "demo"

[[workspace.tasks]]
id = "bad id"
kind = "command"
command = ["node", "--version"]
schedule = "not-cron"
`);
		const context = await createWorkspaceContext({ workspaceRoot: root, mode: "local", env: {} });
		await expect(loadWorkspaceConfig(context)).rejects.toThrow("Invalid workspace task id");
		const badKind = await tempWorkspace();
		await writeWorkspaceToml(badKind, `
[workspace]
name = "demo"

[[workspace.tasks]]
id = "bad-kind"
kind = "unknown"
`);
		await expect(loadWorkspaceConfig(await createWorkspaceContext({ workspaceRoot: badKind, mode: "local", env: {} })))
			.rejects.toThrow("Invalid workspace task kind");
		const badSchedule = await tempWorkspace();
		await writeWorkspaceToml(badSchedule, `
[workspace]
name = "demo"

[[workspace.tasks]]
id = "bad-schedule"
kind = "command"
command = ["node", "--version"]
schedule = "not-cron"
`);
		await expect(loadWorkspaceConfig(await createWorkspaceContext({ workspaceRoot: badSchedule, mode: "local", env: {} })))
			.rejects.toThrow("Invalid workspace task schedule");
	});

	test("actions commit helper is gated outside GitHub Actions", async () => {
		const root = await tempWorkspace();
		await writeWorkspaceToml(root, `[workspace]\nname = "demo"\n`);
		const context = await createWorkspaceContext({ workspaceRoot: root, mode: "actions", env: {} });
		expect(await commitActionsWorkspaceState(context, { env: {} })).toEqual({
			attempted: false,
			committed: false,
			paths: [
				path.join(root, ".codex", "memories"),
				path.join(root, ".codex", "workspace", "actions"),
			],
		});
	});

	test("scaffoldActionsWorkspace creates Actions config, workflows, and gitignore entries", async () => {
		const root = await tempWorkspace();
		const result = await scaffoldActionsWorkspace({
			workspaceRoot: root,
			forgejo: true,
		});
		expect(result.files.some((file) => file.path.endsWith(".codex/workspace.toml"))).toBe(true);
		expect(await readFile(path.join(root, ".codex", "workspace.toml"), "utf8"))
			.toContain("[workspace]");
		expect(await readFile(path.join(root, ".codex", "config.toml"), "utf8"))
			.toContain("repository-scoped Actions");
		expect(await readFile(path.join(root, ".forgejo", "workflows", "codex-toys-actions.yml"), "utf8"))
			.toContain("codex-toys actions prepare-auth");
		expect(await readFile(path.join(root, ".forgejo", "workflows", "codex-toys-actions.yml"), "utf8"))
			.toContain("codex-toys actions cleanup");
		expect(await readFile(path.join(root, ".gitignore"), "utf8"))
			.toContain(".codex/auth.json");
	});
});

async function tempWorkspace(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "codex-workspace-autonomy-"));
	await mkdir(path.join(root, ".codex"), { recursive: true });
	return root;
}

async function writeWorkspaceToml(root: string, text: string): Promise<void> {
	await mkdir(path.join(root, ".codex"), { recursive: true });
	await writeFile(path.join(root, ".codex", "workspace.toml"), text.trimStart());
}
