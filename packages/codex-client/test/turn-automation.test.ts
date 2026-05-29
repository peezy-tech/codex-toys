import { describe, expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
	listTurnAutomations,
	parseTurnAutomationResult,
	resolveTurnAutomationTarget,
	runTurnAutomationScript,
} from "../src/cli/turn-automation.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");

describe("turn automation", () => {
	test("treats action-shaped module returns as plain JSON results", () => {
		expect(parseTurnAutomationResult(
			`TURN_AUTOMATION_MODULE_RESULT ${JSON.stringify({ action: "ignored" })}\n`,
		)).toEqual({
			result: { action: "ignored" },
		});
	});

	test("runs module-style scripts and passes prompt context", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "codex-flows-automation-"));
		const scriptPath = path.join(dir, "check.ts");
		await writeFile(scriptPath, `
export default function run(context) {
  return {
    status: "ready",
    promptText: context.prompt + " for " + context.event.payload.tag,
    cwd: context.cwd,
    skills: ["release-operator"]
  };
}
`);
		const run = await runTurnAutomationScript({
			scriptPath,
			event: { type: "upstream.release", payload: { tag: "v1.2.3" } },
			prompt: "inspect",
			cwd: "/repo",
			timeoutMs: 5_000,
		});
		expect(run.result).toEqual({
			status: "ready",
			promptText: "inspect for v1.2.3",
			cwd: "/repo",
			skills: ["release-operator"],
		});
	});

	test("runs module scripts with a programmable host API", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "codex-flows-automation-host-"));
		const scriptPath = path.join(dir, "check.ts");
		await writeFile(scriptPath, `
export default async function run(ctx) {
  const echo = await ctx.app.call("demo.echo", { tag: ctx.event.payload.tag });
  return {
    status: "completed",
    echo
  };
}
`);
		const run = await runTurnAutomationScript({
			scriptPath,
			event: { type: "upstream.release", payload: { tag: "v1.2.3" } },
			timeoutMs: 5_000,
			host: async (call) => {
				expect(call).toEqual({
					method: "app.call",
					params: {
						method: "demo.echo",
						params: { tag: "v1.2.3" },
					},
				});
				return { ok: true, tag: "v1.2.3" };
			},
		});
		expect(run.result).toEqual({
			status: "completed",
			echo: { ok: true, tag: "v1.2.3" },
		});
	});

	test("fails module-style scripts that throw", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "codex-flows-automation-"));
		const scriptPath = path.join(dir, "check.ts");
		await writeFile(scriptPath, `
export default function run() {
  throw new Error("boom");
}
`);
		await expect(runTurnAutomationScript({
			scriptPath,
			timeoutMs: 5_000,
		})).rejects.toThrow("boom");
	});

	test("discovers named automation manifests", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "codex-flows-automation-root-"));
		const automationRoot = path.join(root, "automations", "release-check");
		await mkdir(automationRoot, { recursive: true });
		await writeFile(path.join(automationRoot, "check.ts"), "export default () => ({ status: 'skipped' });");
		await writeFile(path.join(automationRoot, "prompt.md"), "Inspect the release.\n");
		await writeFile(path.join(automationRoot, "automation.json"), JSON.stringify({
			name: "release-check",
			description: "Check upstream releases",
			script: "check.ts",
			promptFile: "prompt.md",
			cwd: "../repo",
			skills: ["turn-automation-author"],
		}));
		const automations = await listTurnAutomations({ cwd: root });
		expect(automations).toHaveLength(1);
		expect(automations[0]).toMatchObject({
			name: "release-check",
			prompt: "Inspect the release.\n",
			skills: ["turn-automation-author"],
		});
		const target = await resolveTurnAutomationTarget("release-check", { cwd: root });
		expect(target).toMatchObject({
			prompt: "Inspect the release.\n",
			skills: ["turn-automation-author"],
		});
		expect(target.scriptPath).toBe(path.join(automationRoot, "check.ts"));
		await expect(resolveTurnAutomationTarget("./automations/release-check/check.ts", { cwd: root }))
			.rejects.toThrow("must be a named automation");
	});

	test("resolves workspace-root cwd aliases in automation manifests", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "codex-flows-automation-workspace-root-"));
		const automationRoot = path.join(root, ".codex", "automations", "release-check");
		await mkdir(automationRoot, { recursive: true });
		await writeFile(path.join(automationRoot, "check.ts"), `
export default function run(context) {
  return {
    status: "ready",
    cwd: context.cwd,
    workspaceRoot: context.workspaceRoot
  };
}
`);
		await writeFile(path.join(automationRoot, "automation.json"), JSON.stringify({
			name: "release-check",
			script: "check.ts",
			cwd: "@/fork",
		}));
		const target = await resolveTurnAutomationTarget("release-check", { cwd: root });
		expect(target.cwd).toBe(path.join(root, "fork"));
		const run = await runTurnAutomationScript({
			scriptPath: target.scriptPath,
			automation: target.automation,
			cwd: target.cwd,
			timeoutMs: 5_000,
		});
		expect(run.result).toMatchObject({
			status: "ready",
			cwd: path.join(root, "fork"),
			workspaceRoot: root,
		});
	});

	test("rejects workspace-root cwd aliases that escape the workspace", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "codex-flows-automation-bad-workspace-root-"));
		const automationRoot = path.join(root, ".codex", "automations", "release-check");
		await mkdir(automationRoot, { recursive: true });
		await writeFile(path.join(automationRoot, "check.ts"), "export default () => ({ status: 'skipped' });");
		await writeFile(path.join(automationRoot, "automation.json"), JSON.stringify({
			name: "release-check",
			script: "check.ts",
			cwd: "@/../outside",
		}));
		await expect(resolveTurnAutomationTarget("release-check", { cwd: root }))
			.rejects.toThrow("must stay inside workspace root");
	});

	test("CLI scripts start native turns through the programmable host", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "codex-flows-automation-cli-"));
		const automationRoot = path.join(root, "automations", "release-check");
		const scriptPath = path.join(automationRoot, "check.ts");
		const eventPath = path.join(root, "event.json");
		await mkdir(automationRoot, { recursive: true });
		await writeFile(eventPath, JSON.stringify({
			type: "upstream.release",
			payload: { tag: "v1.2.3" },
		}));
		await writeFile(path.join(automationRoot, "automation.json"), JSON.stringify({
			name: "release-check",
			script: "check.ts",
		}));
		await writeFile(scriptPath, `
export default async function run(context) {
  const turn = await context.turn.start({
    prompt: "inspect " + context.event.payload.tag,
    cwd: "/repo",
    permissions: "trusted",
    responsesapiClientMetadata: { automation: "release-check" }
  });
  return {
    status: "started",
    turn
  };
}
`);
		const backend = await startFakeWorkspaceBackend();
		try {
			const result = await runCli([
				"--workspace-root",
				root,
				"--workspace-url",
				backend.url,
				"automation",
				"run",
				"release-check",
				"--event",
				eventPath,
				"--via",
				"workspace",
				"--json",
			]);
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			const automationResult = record(parsed.result);
			expect(automationResult).toMatchObject({
				status: "started",
			});
			expect(automationResult.turn).toMatchObject({
				via: "workspace",
				threadId: "thread-1",
				turnId: "turn-1",
			});
			expect(backend.methods).toEqual([
				"workspace.initialize",
				"thread/start",
				"turn/start",
			]);
			expect(backend.appCalls).toEqual([
				expect.objectContaining({
					method: "thread/start",
					params: expect.objectContaining({
						cwd: "/repo",
						permissions: "trusted",
					}),
				}),
				expect.objectContaining({
					method: "turn/start",
					params: expect.objectContaining({
						threadId: "thread-1",
						cwd: "/repo",
						permissions: "trusted",
						responsesapiClientMetadata: { automation: "release-check" },
					}),
				}),
			]);
		} finally {
			await backend.close();
		}
	});

	test("CLI automation scripts can fan out turns and return gathered results", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "codex-flows-automation-cli-fanout-"));
		const automationRoot = path.join(root, "automations", "fanout-check");
		await mkdir(automationRoot, { recursive: true });
		await writeFile(path.join(automationRoot, "automation.json"), JSON.stringify({
			name: "fanout-check",
			script: "check.ts",
			cwd: "/repo",
		}));
		await writeFile(path.join(automationRoot, "check.ts"), `
export default async function run(ctx) {
  const turns = await Promise.all(["linux", "mac"].map((id) =>
    ctx.turn.start({ id, prompt: "check " + id })
  ));
  const results = await ctx.turn.waitAll(turns, { timeoutMs: 1000, pollIntervalMs: 1 });
  return {
    status: "completed",
    rows: results.map((item) => ({
      id: item.id,
      threadId: item.threadId,
      turnId: item.turnId,
      outputText: item.outputText
    }))
  };
}
`);
		const backend = await startFakeWorkspaceBackend();
		try {
			const result = await runCli([
				"--workspace-root",
				root,
				"--workspace-url",
				backend.url,
				"automation",
				"run",
				"fanout-check",
				"--via",
				"workspace",
				"--json",
			]);
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			expect(parsed.turn).toBeUndefined();
			const automationResult = record(parsed.result);
			expect(automationResult.status).toBe("completed");
			const rows = (automationResult.rows as Array<Record<string, unknown>>);
			expect(rows).toEqual([
				expect.objectContaining({
					id: "linux",
					outputText: "done linux",
				}),
				expect.objectContaining({
					id: "mac",
					outputText: "done mac",
				}),
			]);
			expect(new Set(rows.map((row) => row.threadId)).size).toBe(2);
			expect(new Set(rows.map((row) => row.turnId)).size).toBe(2);
			expect(backend.methods.filter((method) => method === "thread/start")).toHaveLength(2);
			expect(backend.methods.filter((method) => method === "turn/start")).toHaveLength(2);
			expect(backend.methods.filter((method) => method === "thread/read")).toHaveLength(2);
		} finally {
			await backend.close();
		}
	});

	test("CLI runs named automation manifests", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "codex-flows-automation-cli-named-"));
		const automationRoot = path.join(root, "automations", "release-check");
		const eventPath = path.join(root, "event.json");
		await mkdir(automationRoot, { recursive: true });
		await writeFile(eventPath, JSON.stringify({
			type: "upstream.release",
			payload: { tag: "v2.0.0" },
		}));
		await writeFile(path.join(automationRoot, "automation.json"), JSON.stringify({
			script: "check.ts",
			prompt: "default manifest prompt",
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
		const backend = await startFakeWorkspaceBackend();
		try {
			const result = await runCli([
				"--workspace-root",
				root,
				"--workspace-url",
				backend.url,
				"automation",
				"run",
				"release-check",
				"--event",
				eventPath,
				"--via",
				"workspace",
				"--json",
			]);
			expect(result.exitCode).toBe(0);
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			const automationResult = record(parsed.result);
			expect(automationResult).toMatchObject({
				status: "started",
			});
			expect(automationResult.turn).toMatchObject({
				threadId: "thread-1",
				turnId: "turn-1",
			});
			expect(backend.appCalls).toEqual([
				expect.objectContaining({
					method: "thread/start",
					params: expect.objectContaining({
						cwd: "/manifest-cwd",
					}),
				}),
				expect.objectContaining({
					method: "turn/start",
					params: expect.objectContaining({
						threadId: "thread-1",
						cwd: "/manifest-cwd",
					}),
				}),
			]);
		} finally {
			await backend.close();
		}
	});
});

async function runCli(args: string[]): Promise<{
	exitCode: number | null;
	stdout: string;
	stderr: string;
}> {
	const subprocess = spawn(
		process.execPath,
		["--import", "tsx", "packages/codex-client/src/cli/index.ts", ...args],
		{ cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(subprocess.stdout),
		collectText(subprocess.stderr),
		exitCodeFor(subprocess),
	]);
	return { stdout, stderr, exitCode };
}

async function startFakeWorkspaceBackend(): Promise<{
	url: string;
	methods: string[];
	appCalls: Array<{ method: string; params: unknown }>;
	close(): Promise<void>;
}> {
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise<void>((resolve) => wss.once("listening", resolve));
	const address = wss.address() as AddressInfo;
	const methods: string[] = [];
	const appCalls: Array<{ method: string; params: unknown }> = [];
	const state = {
		threadCounter: 0,
		turnCounter: 0,
		turnsByThread: new Map<string, unknown[]>(),
	};
	wss.on("connection", (socket) => {
		socket.on("message", (data) => {
			const message = JSON.parse(data.toString()) as Record<string, unknown>;
			const method = String(message.method);
			const params = record(message.params);
			methods.push(method === "appServer.call"
				? String(params.method)
				: method);
			if (method === "appServer.call") {
				appCalls.push({
					method: String(params.method),
					params: params.params,
				});
			}
			socket.send(JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: fakeWorkspaceResult(method, params, state),
			}));
		});
	});
	return {
		url: `ws://127.0.0.1:${address.port}`,
		methods,
		appCalls,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				wss.close((error) => error ? reject(error) : resolve());
			});
		},
	};
}

function fakeWorkspaceResult(
	method: string,
	params: Record<string, unknown>,
	state: {
		threadCounter: number;
		turnCounter: number;
		turnsByThread: Map<string, unknown[]>;
	},
): unknown {
	if (method === "workspace.initialize") {
		return {
			ok: true,
			serverInfo: { name: "fake-workspace-backend", version: "0.1.0" },
			capabilities: {
				appServerPassThrough: true,
				workspaceMethods: [],
			},
		};
	}
	if (method === "appServer.call") {
		const appMethod = String(params.method);
		const appParams = record(params.params);
		if (appMethod === "thread/start") {
			const threadId = `thread-${++state.threadCounter}`;
			state.turnsByThread.set(threadId, []);
			return { thread: { id: threadId } };
		}
		if (appMethod === "turn/start") {
			const threadId = String(appParams.threadId);
			const turnId = `turn-${++state.turnCounter}`;
			const prompt = promptText(appParams);
			const turn = {
				id: turnId,
				status: "completed",
				itemsView: "full",
				error: null,
				startedAt: 0,
				completedAt: 1,
				durationMs: 1,
				items: [
					{
						type: "agentMessage",
						id: `${turnId}-message`,
						text: `done ${prompt.replace(/^check\s+/, "")}`,
						phase: "final_answer",
						memoryCitation: null,
					},
				],
			};
			state.turnsByThread.set(threadId, [
				...(state.turnsByThread.get(threadId) ?? []),
				turn,
			]);
			return { turn };
		}
		if (appMethod === "thread/read") {
			const threadId = String(appParams.threadId);
			return {
				thread: {
					id: threadId,
					turns: state.turnsByThread.get(threadId) ?? [],
				},
			};
		}
	}
	return {};
}

function promptText(params: Record<string, unknown>): string {
	const input = Array.isArray(params.input) ? params.input : [];
	const first = record(input[0]);
	return typeof first.text === "string" ? first.text : "";
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function collectText(stream: NodeJS.ReadableStream | null): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = "";
		if (!stream) {
			resolve(output);
			return;
		}
		stream.setEncoding("utf8");
		stream.on("data", (chunk: string) => {
			output += chunk;
		});
		stream.once("error", reject);
		stream.once("end", () => resolve(output));
	});
}

function exitCodeFor(subprocess: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		subprocess.once("error", reject);
		subprocess.once("exit", (code) => resolve(code));
	});
}
