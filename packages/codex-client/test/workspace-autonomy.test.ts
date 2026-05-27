import { describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import {
	collectWorkspaceDoctorInfo,
	createWorkspaceContext,
	loadWorkspaceConfig,
	resolveWorkspaceMode,
	runWorkspaceTaskById,
	scaffoldActionsWorkspace,
	tickWorkspace,
	commitActionsWorkspaceState,
} from "../src/cli/workspace-autonomy.ts";
import {
	collectWorkspaceBackendSetupInfo,
	initLocalWorkspaceBackend,
	startLocalWorkspaceBackend,
} from "../src/cli/workspace-backend-setup.ts";

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
		expect(parseArgs(["workspace", "backend", "init", "local", "--overwrite"], {}))
			.toMatchObject({ type: "workspace-backend-init-local", overwrite: true });
		expect(parseArgs(["workspace", "backend", "status", "--json"], {}))
			.toMatchObject({ type: "workspace-backend-status", json: true });
		expect(parseArgs(["workspace", "backend", "start", "--dry-run"], {}))
			.toMatchObject({ type: "workspace-backend-start", dryRun: true });
		expect(parseArgs(["workspace", "call", "delegation.list"], {}))
			.toMatchObject({ type: "workspace-call", method: "delegation.list" });
		expect(parseArgs(["memories", "transplant", "global-to-workspace", "--apply"], {}))
			.toMatchObject({ type: "memories-transplant", direction: "global-to-workspace", apply: true });
	});

	test("initializes local backend setup and prepares start command", async () => {
		const root = await tempWorkspace();
		const context = await createWorkspaceContext({
			workspaceRoot: root,
			mode: "local",
			env: { CODEX_HOME: path.join(root, "codex-home") },
		});
		const init = await initLocalWorkspaceBackend(context);
		expect(init.action).toBe("created");
		expect(await readFile(path.join(root, ".codex", "workspace", "backend.local.env"), "utf8"))
			.toContain("CODEX_WORKSPACE_BACKEND_LOCAL_APP_SERVER=1");
		expect(await readFile(path.join(root, ".gitignore"), "utf8"))
			.toContain(".codex/workspace/local/");

		const info = await collectWorkspaceBackendSetupInfo(context, {});
		expect(info.envExists).toBe(true);
		expect(info.workspaceBackendUrl).toBe("ws://127.0.0.1:3586");
		expect(info.hookSpool.path).toBe(path.join(root, ".codex", "workspace", "local", "hook-spool"));

		const start = await startLocalWorkspaceBackend(context, {
			dryRun: true,
			env: {},
			command: "backend-bin",
		});
		expect(start.command).toEqual([
			"backend-bin",
			"serve",
			"--host",
			"127.0.0.1",
			"--port",
			"3586",
			"--cwd",
			root,
			"--local-app-server",
		]);
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
			callWorkspaceBackend: async () => {
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
			callWorkspaceBackend: async (_method, params) => {
				calls.push(params);
				return { ok: true };
			},
		});
		const second = await tickWorkspace(context, {
			callWorkspaceBackend: async (_method, params) => {
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
		expect(doctor.errors).toEqual([]);
	});

	test("automation tasks run scripts and start turns through workspace backend", async () => {
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
			callWorkspaceBackend: async (method, params) => {
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
				method: "appServer.call",
				params: expect.objectContaining({
					method: "thread/start",
					params: expect.objectContaining({
						cwd: "/remote-cwd",
					}),
				}),
			}),
			expect.objectContaining({
				method: "appServer.call",
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
			callWorkspaceBackend: async () => {
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
			callWorkspaceBackend: async () => {
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
		expect(await readFile(path.join(root, ".forgejo", "workflows", "codex-flows-actions.yml"), "utf8"))
			.toContain("codex-flows actions prepare-auth");
		expect(await readFile(path.join(root, ".forgejo", "workflows", "codex-flows-actions.yml"), "utf8"))
			.toContain("codex-flows actions cleanup");
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
