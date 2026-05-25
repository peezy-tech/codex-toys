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
	parseTurnAutomationDecision,
	resolveTurnAutomationTarget,
	runTurnAutomationScript,
} from "../src/cli/turn-automation.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "../../..");

describe("turn automation", () => {
	test("uses default prompt for module runner decisions", () => {
		expect(parseTurnAutomationDecision(
			`TURN_AUTOMATION_MODULE_RESULT ${JSON.stringify({ action: "turn" })}\n`,
			"default prompt",
		)).toEqual({
			action: "turn",
			prompt: "default prompt",
		});
	});

	test("runs module-style scripts and passes prompt context", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "codex-flows-automation-"));
		const scriptPath = path.join(dir, "check.ts");
		await writeFile(scriptPath, `
export default function run(context) {
  return {
    action: "turn",
    prompt: context.prompt + " for " + context.event.payload.tag,
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
		expect(run.decision).toEqual({
			action: "turn",
			prompt: "inspect for v1.2.3",
			cwd: "/repo",
			skills: ["release-operator"],
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
		await writeFile(path.join(automationRoot, "check.ts"), "export default () => ({ action: 'skip' });");
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

	test("CLI starts a native turn through a workspace backend", async () => {
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
export default function run(context) {
  return {
    action: "turn",
    prompt: "inspect " + context.event.payload.tag,
    cwd: "/repo",
    permissions: "trusted",
    responsesapiClientMetadata: { automation: "release-check" }
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
			expect(parsed.decision).toMatchObject({
				action: "turn",
				prompt: "inspect v1.2.3",
				cwd: "/repo",
				permissions: "trusted",
			});
			expect(parsed.turn).toMatchObject({
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
export default function run(context) {
  return {
    action: "turn",
    prompt: context.prompt + " " + context.event.payload.tag
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
			expect(parsed.decision).toMatchObject({
				action: "turn",
				prompt: "default manifest prompt v2.0.0",
				cwd: "/manifest-cwd",
				skills: ["release-skill"],
			});
			expect(parsed.turn).toMatchObject({
				threadId: "thread-1",
				turnId: "turn-1",
			});
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
				result: fakeWorkspaceResult(method, params),
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
		if (appMethod === "thread/start") {
			return { thread: { id: "thread-1" } };
		}
		if (appMethod === "turn/start") {
			return { turn: { id: "turn-1" } };
		}
	}
	return {};
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
