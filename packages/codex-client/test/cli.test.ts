import { describe, expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/cli/args.ts";
import { formatFetchInfo, type FetchInfo } from "../src/cli/fetch.ts";
import { parseJsonParamsText, parseJsonText } from "../src/cli/json.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));

describe("codex-flows CLI args", () => {
	test("parses JSON text with a UTF-8 BOM", () => {
		expect(parseJsonText("\uFEFF{\"ok\":true}", "params")).toEqual({ ok: true });
	});

	test("parses PowerShell-stripped JSON params", () => {
		expect(parseJsonParamsText("{limit:3,sourceKinds:[]}", "params")).toEqual({
			limit: 3,
			sourceKinds: [],
		});
		expect(parseJsonParamsText("{threadId:019e649c-1452}", "params")).toEqual({
			threadId: "019e649c-1452",
		});
	});

	test("parses direct app-server calls", () => {
		expect(parseArgs(["app", "thread/list", "{\"limit\":1}"], {}))
			.toMatchObject({
				type: "app-call",
				method: "thread/list",
				paramsText: "{\"limit\":1}",
				url: "agent://local",
			});
		expect(parseArgs([
			"app",
			"thread/list",
			"--params-json",
			"{\"limit\":20,\"sourceKinds\":[]}",
		], {})).toMatchObject({
			type: "app-call",
			method: "thread/list",
			paramsText: "{\"limit\":20,\"sourceKinds\":[]}",
		});
		expect(parseArgs([
			"app",
			"thread/turns/list",
			"--params-file",
			"params.json",
		], {})).toMatchObject({
			type: "app-call",
			method: "thread/turns/list",
			paramsFile: "params.json",
		});
	});

	test("parses workspace-owned method calls", () => {
		expect(parseArgs(["workspace", "delegation.list"], {})).toMatchObject({
			type: "workspace-call",
			method: "delegation.list",
			url: "agent://local",
		});
		expect(parseArgs([
			"workspace",
			"delegate",
			"start",
			"--cwd",
			"@/workspaces/trading",
			"--prompt",
			"scan the workspace",
			"--title",
			"Trading scan",
			"--group-id",
			"ops",
			"--return-mode",
			"wake_on_group",
			"--wait",
			"--sandbox",
			"danger-full-access",
			"--approval-policy",
			"never",
			"--json",
		], {})).toMatchObject({
			type: "workspace-delegate-start",
			targetCwd: "@/workspaces/trading",
			prompt: "scan the workspace",
			title: "Trading scan",
			groupId: "ops",
			returnMode: "wake_on_group",
			wait: true,
			sandbox: "danger-full-access",
			approvalPolicy: "never",
			json: true,
			timeoutMs: 30 * 60 * 1000,
		});
		expect(parseArgs(["workspace", "delegate", "list", "--json"], {}))
			.toMatchObject({
				type: "workspace-delegate-list",
				json: true,
			});
		expect(parseArgs([
			"--ssh",
			"devbox",
			"--cwd",
			"/home/peezy",
			"workspace",
			"delegate",
			"start",
			"--target-cwd",
			"@/repos/patch.moi",
			"inspect patch status",
		], {})).toMatchObject({
			type: "workspace-delegate-start",
			sshTarget: "devbox",
			cwd: "/home/peezy",
			targetCwd: "@/repos/patch.moi",
			prompt: "inspect patch status",
		});
	});

	test("rejects removed workspace backend setup commands", () => {
		expect(() => parseArgs(["workspace", "backend", "init", "local", "--overwrite"], {}))
			.toThrow("workspace backend service commands have been removed");
		expect(() => parseArgs(["workspace", "backend", "status", "--json"], {}))
			.toThrow("workspace backend service commands have been removed");
		expect(() => parseArgs(["workspace", "backend", "start"], {}))
			.toThrow("workspace backend service commands have been removed");
	});

	test("parses agent and SSH preflight commands", () => {
		expect(() => parseArgs(["remote", "status", "--json"], {}))
			.toThrow("remote supports only preflight");
		expect(parseArgs([
			"--ssh",
			"devbox",
			"--cwd",
			"/work",
			"remote",
			"preflight",
			"--json",
		], {})).toMatchObject({
			type: "remote-preflight",
			cwd: "/work",
			sshTarget: "devbox",
			json: true,
		});
		expect(parseArgs([
			"--cwd",
			"/work",
			"agent",
			"serve",
			"--codex-command",
			"/opt/codex",
		], {})).toMatchObject({
			type: "agent-serve",
			cwd: "/work",
			remoteCodexCommand: "/opt/codex",
		});
		expect(() => parseArgs(["remote", "turn", "start", "--prompt", "hello"], {}))
			.toThrow("remote supports only preflight");
		});

		test("parses turn run as the core prompt primitive", () => {
			expect(parseArgs([
				"--ssh",
				"devbox",
				"--cwd",
				"/repo",
				"--agent-command",
				"/opt/codex-flows",
				"--codex-command",
				"/opt/codex",
				"--codex-arg",
				"-s",
				"--codex-arg",
				"danger-full-access",
				"turn",
				"run",
				"scan current folder",
				"--wait",
				"--sandbox",
				"danger-full-access",
				"--approval-policy",
				"never",
			], {})).toMatchObject({
				type: "turn-run",
				prompt: "scan current folder",
				sshTarget: "devbox",
				cwd: "/repo",
				agentCommand: "/opt/codex-flows",
				remoteCodexCommand: "/opt/codex",
				remoteCodexArgs: ["-s", "danger-full-access"],
				wait: true,
				sandbox: "danger-full-access",
				approvalPolicy: "never",
			});
		});

	test("parses turn automation commands", () => {
		expect(parseArgs([
			"--ssh",
			"devbox",
			"--cwd",
			"/repo",
			"automation",
			"run",
			"check-release",
			"--event",
			"event.json",
			"--prompt",
			"default prompt",
			"--via",
			"workspace",
			"--sandbox",
			"danger-full-access",
			"--approval-policy",
			"never",
			"--json",
		], {})).toMatchObject({
			type: "automation-run",
			target: "check-release",
			eventPath: "event.json",
			prompt: "default prompt",
			via: "workspace",
			sshTarget: "devbox",
			cwd: "/repo",
			sandbox: "danger-full-access",
			approvalPolicy: "never",
			json: true,
			timeoutMs: 30 * 60 * 1000,
		});
		expect(parseArgs([
			"--ssh",
			"devbox",
			"--cwd",
			"/repo",
			"automation",
			"list",
			"--workspace-root",
			"/work",
		], {}))
			.toMatchObject({
				type: "automation-list",
				workspaceRoot: "/work",
				sshTarget: "devbox",
				cwd: "/repo",
			});
		expect(parseArgs(["turn", "run", "scan", "--wait"], {}))
			.toMatchObject({
				type: "turn-run",
				timeoutMs: 30 * 60 * 1000,
			});
	});

	test("parses SSH provider options on app, workspace, and fetch commands", () => {
		const remote = {
			sshTarget: "devbox",
			cwd: "/repo",
			remotePathPrepend: "/opt/node/bin",
			agentCommand: "/opt/codex-flows",
		};
		expect(parseArgs([
			"--ssh",
			"devbox",
			"--cwd",
			"/repo",
			"--remote-path-prepend",
			"/opt/node/bin",
			"--agent-command",
			"/opt/codex-flows",
			"fetch",
		], {})).toMatchObject({ type: "fetch", ...remote });
		expect(parseArgs([
			"--ssh=devbox",
			"--cwd=/repo",
			"app",
			"thread/list",
		], {})).toMatchObject({
			type: "app-call",
			sshTarget: "devbox",
			cwd: "/repo",
		});
		expect(parseArgs([
			"--ssh",
			"devbox",
			"--cwd",
			"/repo",
			"workspace",
			"delegation.list",
		], {})).toMatchObject({
			type: "workspace-call",
			sshTarget: "devbox",
			cwd: "/repo",
		});
	});

	test("parses workspace function commands", () => {
		expect(parseArgs(["functions", "list", "--json"], {})).toMatchObject({
			type: "functions-list",
			json: true,
		});
		expect(parseArgs(["functions", "describe", "portfolioSnapshot", "--json"], {}))
			.toMatchObject({
				type: "functions-describe",
				name: "portfolioSnapshot",
				json: true,
			});
		expect(parseArgs([
			"--ssh",
			"devbox",
			"--cwd",
			"/repo",
			"functions",
			"call",
			"portfolioSnapshot",
			"--params-json",
			"{\"account\":\"demo\"}",
			"--json",
		], {})).toMatchObject({
			type: "functions-call",
			name: "portfolioSnapshot",
			paramsText: "{\"account\":\"demo\"}",
			sshTarget: "devbox",
			cwd: "/repo",
			json: true,
		});
	});

	test("executes SSH workspace function commands", async () => {
		const fakeSsh = await createFunctionFakeSshCommand();
		const env = { CODEX_FLOWS_SSH_COMMAND: fakeSsh };

		const list = await runCli([
			"--ssh",
			"devbox",
			"--cwd",
			"/repo",
			"functions",
			"list",
			"--json",
		], env);
		expect(list.exitCode).toBe(0);
		expect(JSON.parse(list.stdout)).toEqual({
			functions: [{
				name: "portfolioSnapshot",
				description: "Read portfolio.",
				sideEffects: "read-only",
			}],
		});

		const describe = await runCli([
			"--ssh",
			"devbox",
			"--cwd",
			"/repo",
			"functions",
			"describe",
			"portfolioSnapshot",
			"--json",
		], env);
		expect(describe.exitCode).toBe(0);
		expect(JSON.parse(describe.stdout)).toMatchObject({
			function: { name: "portfolioSnapshot" },
		});

		const call = await runCli([
			"--ssh",
			"devbox",
			"--cwd",
			"/repo",
			"functions",
			"call",
			"portfolioSnapshot",
			"--params-json",
			"{\"account\":\"demo\"}",
			"--json",
		], env);
		expect(call.exitCode).toBe(0);
		expect(JSON.parse(call.stdout)).toEqual({
			result: { account: "demo", equity: 456 },
		});
	});

	test("parses app-server pass-through through the agent", () => {
			expect(parseArgs([
				"workspace",
				"app",
				"thread/list",
				"{\"limit\":2}",
			], {})).toMatchObject({
				type: "workspace-app-call",
				method: "thread/list",
				paramsText: "{\"limit\":2}",
			});
			expect(parseArgs([
				"workspace",
				"app",
				"thread/list",
				"--params-file",
				"params.json",
			], {})).toMatchObject({
				type: "workspace-app-call",
				method: "thread/list",
				paramsFile: "params.json",
			});
		});

	test("parses Actions helper commands and workspace Actions scaffolding", () => {
		expect(parseArgs(["actions", "prepare-auth", "--workspace-root", "/work"], {}))
			.toEqual({
				type: "actions-prepare-auth",
				workspaceRoot: "/work",
				pretty: true,
			});
		expect(parseArgs(["actions", "cleanup"], {})).toEqual({
			type: "actions-cleanup",
			workspaceRoot: undefined,
			pretty: true,
		});
		expect(() => parseArgs(["actions", "dispatch", "--event", "event.json"], {}))
			.toThrow("actions requires prepare-auth or cleanup");
		expect(parseArgs([
			"workspace",
			"init",
			"actions",
			"--forgejo",
			"--overwrite",
		], {})).toEqual({
			type: "workspace-init-actions",
			workspaceRoot: undefined,
			forgejo: true,
			github: false,
			overwrite: true,
			pretty: true,
		});
	});

	test("executes Actions prepare-auth and cleanup commands against a temp workspace", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codex-actions-cli-"));
		await mkdir(path.join(root, ".codex", "sessions"), { recursive: true });
		await mkdir(path.join(root, ".codex", "memories"), { recursive: true });
		await writeFile(path.join(root, ".codex", "sessions", "one.jsonl"), "{}");
		await writeFile(path.join(root, ".codex", "memories", "raw_memories.md"), "keep\n");

		const prepare = await runCli([
			"--workspace-root",
			root,
			"actions",
			"prepare-auth",
		], { CODEX_AUTH_JSON_B64: "", CODEX_AUTH_JSON: "{\"token\":\"cli\"}" });
		expect(prepare.exitCode).toBe(0);
		expect(JSON.parse(prepare.stdout)).toMatchObject({
			source: "CODEX_AUTH_JSON",
			wrote: true,
		});
		expect(JSON.parse(await readFile(path.join(root, ".codex", "auth.json"), "utf8")))
			.toEqual({ token: "cli" });

		const cleanup = await runCli([
			"--workspace-root",
			root,
			"actions",
			"cleanup",
		]);
		expect(cleanup.exitCode).toBe(0);
		expect(JSON.parse(cleanup.stdout).removed).toContain("auth.json");
		expect(JSON.parse(cleanup.stdout).removed).toContain("sessions");
		expect(await readFile(path.join(root, ".codex", "memories", "raw_memories.md"), "utf8"))
			.toBe("keep\n");
	});

	test("parses thread transplant commands", () => {
		expect(parseArgs(["threads", "locate", "thread-1", "--codex-home", "/source", "--json"], {}))
			.toEqual({
				type: "threads-locate",
				threadId: "thread-1",
				codexHome: "/source",
				json: true,
			});
		expect(parseArgs(["threads", "inspect", "thread-1", "--codex-home=/source", "--json"], {}))
			.toEqual({
				type: "threads-inspect",
				threadIdOrPath: "thread-1",
				codexHome: "/source",
				json: true,
			});
		expect(parseArgs(["threads", "inspect", "/rollout.jsonl", "--json"], {})).toEqual({
			type: "threads-inspect",
			threadIdOrPath: "/rollout.jsonl",
			json: true,
		});
		expect(parseArgs([
			"threads",
			"install-rollout",
			"/rollout.jsonl",
			"--codex-home",
			"/target",
			"--replace",
		], {})).toEqual({
			type: "threads-install-rollout",
			rolloutPath: "/rollout.jsonl",
			codexHome: "/target",
			replace: true,
			json: false,
		});
		expect(parseArgs([
			"threads",
			"transplant",
			"thread-1",
			"--from-codex-home",
			"/source",
			"--to-codex-home=/target",
			"--replace",
			"--json",
		], {})).toEqual({
			type: "threads-transplant",
			threadId: "thread-1",
			fromCodexHome: "/source",
			toCodexHome: "/target",
			replace: true,
			json: true,
		});
	});

	test("parses pack commands", () => {
		expect(parseArgs(["pack", "inspect", "owner/repo", "--ref", "main", "--json"], {}))
			.toEqual({
				type: "pack-inspect",
				source: "owner/repo",
				ref: "main",
				json: true,
			});
		expect(parseArgs([
			"--workspace-root",
			"/workspace",
			"pack",
			"add",
			"./pack",
			"--apply",
			"--overwrite",
			"--include",
			"tdd",
			"--exclude=repo-policy",
		], {})).toEqual({
			type: "pack-add",
			source: "./pack",
			ref: undefined,
			workspaceRoot: "/workspace",
			apply: true,
			overwrite: true,
			include: ["tdd"],
			exclude: ["repo-policy"],
			json: false,
		});
		expect(parseArgs(["pack", "doctor", "--json"], {})).toEqual({
			type: "pack-doctor",
			workspaceRoot: undefined,
			json: true,
		});
		expect(parseArgs(["pack", "list"], {})).toEqual({
			type: "pack-list",
			workspaceRoot: undefined,
			json: false,
		});
	});

	test("rejects invalid method names", () => {
		expect(() => parseArgs(["workspace", "not a method"], {}))
			.toThrow("workspace method must be a JSON-RPC method name");
	});

	test("parses neofetch-style fetch command", () => {
		expect(parseArgs(["--no-color", "fetch"], {})).toEqual({
			type: "fetch",
			appUrl: "agent://local",
			workspaceUrl: "agent://local",
			timeoutMs: 1500,
			color: false,
			json: false,
		});
		expect(parseArgs(["--json", "neofetch"], {})).toMatchObject({
			type: "fetch",
			json: true,
		});
		expect(parseArgs(["--ssh", "devbox", "--cwd", "/repo", "fetch"], {}))
			.toMatchObject({
				type: "fetch",
				timeoutMs: 90_000,
				sshTarget: "devbox",
				cwd: "/repo",
			});
	});

	test("formats fetch output without ANSI colors", () => {
		const info: FetchInfo = {
			package: "@peezy.tech/codex-flows",
			version: "0.3.1",
			runtime: "node 24.15.0",
			node: "24.0.0",
			platform: "linux",
			arch: "x64",
			shell: "/bin/bash",
			cwd: "/workspace",
			codexCommand: "/tmp/codex",
			agentUrl: "agent://local",
			codexHome: "/tmp/codex-home",
			agent: {
				transport: "local",
				status: "connected",
				url: "agent://local",
				server: {
					name: "codex-flows-agent",
					version: "0.1.0",
				},
				capabilities: {
					workspaceMethods: 8,
				},
				threads: {
					total: 2,
					active: 1,
					idle: 1,
					other: 0,
					latest: [
						{
							id: "thread_1234567890",
							label: "Implement CLI",
							status: "active",
						},
					],
				},
			},
		};
		const output = formatFetchInfo(info, { color: false });
		expect(output).toContain("codex-flows");
		expect(output).toContain("package      @peezy.tech/codex-flows@0.3.1");
		expect(output).toContain("agent        agent://local");
		expect(output).toContain("agent status local connected");
		expect(output).toContain("threads      2 listed, 1 active, 1 idle");
		expect(output).not.toContain("\x1b[");
	});
});

async function runCli(
	args: string[],
	env: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = spawn(process.execPath, [
		"--import",
		import.meta.resolve("tsx"),
		path.resolve(testDir, "../src/cli/index.ts"),
		...args,
	], {
		env: {
			...process.env,
			...env,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(proc.stdout),
		collectText(proc.stderr),
		exitCodeFor(proc),
	]);
	return { exitCode: exitCode ?? 1, stdout, stderr };
}

async function createFunctionFakeSshCommand(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "codex-functions-cli-"));
	const command = path.join(dir, "ssh.mjs");
	await writeFile(command, functionFakeSshScript());
	await chmod(command, 0o755);
	return command;
}

function functionFakeSshScript(): string {
	return `#!/usr/bin/env node
import { stdin, stdout } from "node:process";

process.on("SIGTERM", () => process.exit(0));

let buffer = "";
stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line) handle(line);
		newline = buffer.indexOf("\\n");
	}
});

function handle(line) {
	const message = JSON.parse(line);
	stdout.write(JSON.stringify({
		jsonrpc: "2.0",
		id: message.id,
		result: resultFor(message.method, message.params),
	}) + "\\n");
}

function resultFor(method, params) {
	if (method === "workspace.initialize") {
		return {
			ok: true,
			serverInfo: { name: "fake-agent", version: "0.1.0" },
			capabilities: {
				appServerPassThrough: true,
				workspaceMethods: ["functions.list", "functions.describe", "functions.call"],
				workspaceMethodMetadata: [],
			},
		};
	}
	if (method === "functions.list") {
		return {
			functions: [{
				name: "portfolioSnapshot",
				description: "Read portfolio.",
				sideEffects: "read-only",
			}],
		};
	}
	if (method === "functions.describe") {
		return {
			function: {
				name: params.name,
				description: "Read portfolio.",
				sideEffects: "read-only",
			},
		};
	}
	if (method === "functions.call") {
		return {
			result: {
				account: params.params.account,
				equity: 456,
			},
		};
	}
	return {};
}

setInterval(() => {}, 1_000);
`;
}

async function collectText(stream: NodeJS.ReadableStream | null): Promise<string> {
	let output = "";
	if (!stream) {
		return output;
	}
	for await (const chunk of stream) {
		output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
	}
	return output;
}

function exitCodeFor(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
}
