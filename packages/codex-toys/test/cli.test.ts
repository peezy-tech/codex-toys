import { describe, expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/cli/args.ts";
import { buildKitSetupPrompt } from "../src/cli/kit-setup.ts";
import { formatFetchInfo, type FetchInfo } from "@codex-toys/workbench";
import { parseJsonParamsText, parseJsonText } from "@codex-toys/bridge/json";

const testDir = path.dirname(fileURLToPath(import.meta.url));

describe("codex-toys CLI args", () => {
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
				url: "runtime://local",
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

	test("parses workbench-owned method calls", () => {
		expect(parseArgs(["workbench", "functions.list"], {})).toMatchObject({
			type: "workbench-call",
			method: "functions.list",
			url: "runtime://local",
		});
		expect(parseArgs([
			"workbench",
			"dispatch",
			"read",
			"dispatch-1",
			"--include-output",
			"--json",
		], {})).toMatchObject({
			type: "workbench-dispatch-read",
			intentId: "dispatch-1",
			includeOutput: true,
			json: true,
		});
		expect(() => parseArgs(["workbench", "deferred", "list"], {}))
			.toThrow("workbench deferred commands have been removed");
		expect(() => parseArgs(["workbench", "defer", "list"], {}))
			.toThrow("workbench deferred commands have been removed");
		expect(parseArgs(["workbench", "overview", "--json"], {}))
			.toMatchObject({
				type: "workbench-overview",
				json: true,
				timeoutMs: 5_000,
			});
	});

	test("rejects removed toybox setup commands", () => {
		expect(() => parseArgs(["workbench", "backend", "init", "local", "--overwrite"], {}))
			.toThrow("workbench backend commands have been removed");
		expect(() => parseArgs(["workbench", "backend", "status", "--json"], {}))
			.toThrow("workbench backend commands have been removed");
		expect(() => parseArgs(["workbench", "backend", "start"], {}))
			.toThrow("workbench backend commands have been removed");
	});

	test("parses runtime and SSH preflight commands", () => {
		expect(() => parseArgs(["remote", "status", "--json"], {}))
			.toThrow("Unknown command: remote");
		expect(parseArgs([
			"--ssh",
			"devbox",
			"--cwd",
			"/work",
			"runtime",
			"preflight",
			"--json",
		], {})).toMatchObject({
			type: "runtime-preflight",
			cwd: "/work",
			sshTarget: "devbox",
			json: true,
		});
		expect(parseArgs([
			"--cwd",
			"/work",
			"runtime",
			"serve",
			"--codex-command",
			"/opt/codex",
		], {})).toMatchObject({
			type: "runtime-serve",
			cwd: "/work",
			remoteCodexCommand: "/opt/codex",
		});
		expect(() => parseArgs(["remote", "turn", "start", "--prompt", "hello"], {}))
			.toThrow("Unknown command: remote");
		});

	test("parses host overview commands", () => {
		expect(parseArgs(["host", "overview", "--json"], {})).toMatchObject({
			type: "host-overview",
			url: "runtime://local",
			json: true,
		});
		expect(parseArgs([
			"--ssh",
			"devbox",
			"--cwd",
			"/home/peezy",
			"runtime",
			"host-overview",
			"--json",
		], {})).toMatchObject({
			type: "host-overview",
			sshTarget: "devbox",
			cwd: "/home/peezy",
			json: true,
		});
		expect(() => parseArgs(["host", "status"], {})).toThrow("host requires overview");
	});

		test("parses turn run as the core prompt primitive", () => {
			expect(() =>
				parseArgs([
					"--ssh",
					"devbox",
					"--cwd",
					"/repo",
					"turn",
					"run",
					"scan current folder",
				], {})
			).toThrow("SSH turn run requires --wait");

			expect(parseArgs([
				"--ssh",
				"devbox",
				"--cwd",
				"/repo",
				"--runtime-command",
				"/opt/codex-toys",
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
				toyboxCommand: "/opt/codex-toys",
				remoteCodexCommand: "/opt/codex",
				remoteCodexArgs: ["-s", "danger-full-access"],
				wait: true,
				sandbox: "danger-full-access",
				approvalPolicy: "never",
			});
		});

	test("parses workflow commands", () => {
		expect(parseArgs([
			"--ssh",
			"devbox",
			"--cwd",
			"/repo",
			"workflow",
			"run",
			"check-release",
			"--event",
			"event.json",
			"--prompt",
			"default prompt",
			"--via",
			"workbench",
			"--sandbox",
			"danger-full-access",
			"--approval-policy",
			"never",
			"--json",
		], {})).toMatchObject({
			type: "workflow-run",
			target: "check-release",
			eventPath: "event.json",
			prompt: "default prompt",
			via: "workbench",
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
			"workflow",
			"list",
			"--workbench-root",
			"/work",
		], {}))
			.toMatchObject({
				type: "workflow-list",
				workbenchRoot: "/work",
				sshTarget: "devbox",
				cwd: "/repo",
			});
		expect(parseArgs([
			"workflow",
			"run",
			"--script",
			"./workflow.mjs",
			"--prompt",
			"inline prompt",
		], {})).toMatchObject({
			type: "workflow-run",
			scriptPath: "./workflow.mjs",
			scriptStdin: false,
			prompt: "inline prompt",
		});
		expect(parseArgs([
			"workflow",
			"run",
			"--script-stdin",
		], {})).toMatchObject({
			type: "workflow-run",
			scriptStdin: true,
		});
		expect(() => parseArgs([
			"workflow",
			"run",
			"check-release",
			"--script",
			"./workflow.mjs",
		], {})).toThrow("exactly one");
		const retiredCommand = ["auto", "mation"].join("");
		expect(() => parseArgs([retiredCommand, "list"], {}))
			.toThrow("Unknown command");
		expect(parseArgs(["turn", "run", "scan", "--wait"], {}))
			.toMatchObject({
				type: "turn-run",
				timeoutMs: 30 * 60 * 1000,
			});
	});

	test("parses SSH provider options on app, workbench, and fetch commands", () => {
		const remote = {
			sshTarget: "devbox",
			cwd: "/repo",
			remotePathPrepend: "/opt/node/bin",
			toyboxCommand: "/opt/codex-toys",
		};
		expect(parseArgs([
			"--ssh",
			"devbox",
			"--cwd",
			"/repo",
			"--remote-path-prepend",
			"/opt/node/bin",
			"--runtime-command",
			"/opt/codex-toys",
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
			"workbench",
			"functions.list",
		], {})).toMatchObject({
			type: "workbench-call",
			sshTarget: "devbox",
			cwd: "/repo",
		});
	});

	test("parses workbench function commands", () => {
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

	test("executes SSH workbench function commands", async () => {
		const fakeSsh = await createFunctionFakeSshCommand();
		const env = { CODEX_TOYS_SSH_COMMAND: fakeSsh };

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

		const hostOverview = await runCli([
			"--ssh",
			"devbox",
			"--cwd",
			"/repo",
			"runtime",
			"host-overview",
			"--json",
		], env);
		expect(hostOverview.exitCode).toBe(0);
		expect(JSON.parse(hostOverview.stdout)).toMatchObject({
			ok: true,
			disk: { status: "ok" },
			versions: {
				packages: expect.arrayContaining([
					expect.objectContaining({ name: "node" }),
					expect.objectContaining({ name: "codex-toys" }),
				]),
			},
		});
	});

	test("parses app-server pass-through through the runtime", () => {
			expect(parseArgs([
				"workbench",
				"app",
				"thread/list",
				"{\"limit\":2}",
			], {})).toMatchObject({
				type: "workbench-app-call",
				method: "thread/list",
				paramsText: "{\"limit\":2}",
			});
			expect(parseArgs([
				"workbench",
				"app",
				"thread/list",
				"--params-file",
				"params.json",
			], {})).toMatchObject({
				type: "workbench-app-call",
				method: "thread/list",
				paramsFile: "params.json",
			});
		});

	test("parses Actions helper commands and workbench Actions scaffolding", () => {
		expect(parseArgs(["actions", "prepare-auth", "--workbench-root", "/work"], {}))
			.toEqual({
				type: "actions-prepare-auth",
				workbenchRoot: "/work",
				pretty: true,
			});
		expect(parseArgs(["actions", "cleanup"], {})).toEqual({
			type: "actions-cleanup",
			workbenchRoot: undefined,
			pretty: true,
		});
		expect(() => parseArgs(["actions", "dispatch", "--event", "event.json"], {}))
			.toThrow("actions requires prepare-auth or cleanup");
		expect(parseArgs([
			"workbench",
			"init",
			"actions",
			"--forgejo",
			"--overwrite",
		], {})).toEqual({
			type: "workbench-init-actions",
			workbenchRoot: undefined,
			forgejo: true,
			github: false,
			runnerImage: undefined,
			overwrite: true,
			pretty: true,
		});
		expect(parseArgs([
			"workbench",
			"init",
			"actions",
			"--github",
			"--image",
			"ghcr.io/example/custom-codex-runner:2026-06",
		], {})).toEqual({
			type: "workbench-init-actions",
			workbenchRoot: undefined,
			forgejo: false,
			github: true,
			runnerImage: "ghcr.io/example/custom-codex-runner:2026-06",
			overwrite: false,
			pretty: true,
		});
		expect(parseArgs([
			"workbench",
			"init",
			"actions",
			"--github",
			"--no-image",
		], {})).toEqual({
			type: "workbench-init-actions",
			workbenchRoot: undefined,
			forgejo: false,
			github: true,
			runnerImage: null,
			overwrite: false,
			pretty: true,
		});
	});

	test("executes Actions prepare-auth and cleanup commands against a temp workbench", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codex-actions-cli-"));
		await mkdir(path.join(root, ".codex", "sessions"), { recursive: true });
		await mkdir(path.join(root, ".codex", "memories"), { recursive: true });
		await writeFile(path.join(root, ".codex", "sessions", "one.jsonl"), "{}");
		await writeFile(path.join(root, ".codex", "memories", "raw_memories.md"), "keep\n");

		const prepare = await runCli([
			"--workbench-root",
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
			"--workbench-root",
			root,
			"actions",
			"cleanup",
		]);
		expect(cleanup.exitCode).toBe(0);
		expect(JSON.parse(cleanup.stdout).removed).toContain("auth.json");
		expect(JSON.parse(cleanup.stdout).removed).not.toContain("sessions");
		expect(await readFile(path.join(root, ".codex", "sessions", "one.jsonl"), "utf8"))
			.toBe("{}");
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
			preserveCwd: false,
			json: false,
		});
		expect(parseArgs([
			"threads",
			"transplant",
			"thread-1",
			"--from-codex-home",
			"/source",
			"--to-codex-home=/target",
			"--cwd",
			"/project",
			"--replace",
			"--preserve-cwd",
			"--json",
		], {})).toEqual({
			type: "threads-transplant",
			threadId: "thread-1",
			fromCodexHome: "/source",
			toCodexHome: "/target",
			replace: true,
			cwd: "/project",
			preserveCwd: true,
			json: true,
		});
	});

	test("parses kit commands", () => {
		expect(parseArgs(["kit", "inspect", "owner/repo", "--ref", "main", "--json"], {}))
			.toEqual({
				type: "kit-inspect",
				source: "owner/repo",
				ref: "main",
				json: true,
			});
		expect(parseArgs([
			"--workbench-root",
			"/workbench",
			"kit",
			"setup",
			"./kit",
			"--wait",
			"--prompt",
			"use the local baseline",
		], {})).toMatchObject({
			type: "kit-setup",
			source: "./kit",
			workbenchRoot: "/workbench",
			wait: true,
			prompt: "use the local baseline",
			timeoutMs: 30 * 60 * 1000,
		});
		expect(() => parseArgs([
			"--ssh",
			"devbox",
			"kit",
			"setup",
			"./kit",
		], {})).toThrow("kit setup currently supports local workbenches only");
		expect(() => parseArgs([
			"kit",
			"setup",
			"./kit",
			"--include",
			"setup",
		], {})).toThrow("does not support --include or --exclude");
		expect(parseArgs([
			"--workbench-root",
			"/workbench",
			"kit",
			"add",
			"./kit",
			"--apply",
			"--overwrite",
			"--include",
			"tdd",
			"--exclude=repo-policy",
		], {})).toEqual({
			type: "kit-add",
			source: "./kit",
			ref: undefined,
			workbenchRoot: "/workbench",
			apply: true,
			overwrite: true,
			include: ["tdd"],
			exclude: ["repo-policy"],
			json: false,
		});
		expect(buildKitSetupPrompt({
			source: "./kit",
			workbenchRoot: "/workbench",
			operatorPrompt: "use the local baseline",
		})).toContain("Do not create, generate, or substitute validation scripts.");
		expect(parseArgs(["kit", "doctor", "--json"], {})).toEqual({
			type: "kit-doctor",
			workbenchRoot: undefined,
			json: true,
		});
		expect(parseArgs(["kit", "list"], {})).toEqual({
			type: "kit-list",
			workbenchRoot: undefined,
			json: false,
		});
	});

	test("rejects invalid method names", () => {
		expect(() => parseArgs(["workbench", "not a method"], {}))
			.toThrow("workbench method must be a JSON-RPC method name");
	});

	test("parses neofetch-style fetch command", () => {
		expect(parseArgs(["--no-color", "fetch"], {})).toEqual({
			type: "fetch",
			appUrl: "runtime://local",
			workbenchUrl: "runtime://local",
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
			package: "codex-toys",
			version: "0.3.1",
			runtime: "node 24.15.0",
			node: "24.0.0",
			platform: "linux",
			arch: "x64",
			shell: "/bin/bash",
			cwd: "/workbench",
			codexCommand: "/tmp/codex",
			runtimeUrl: "runtime://local",
			codexHome: "/tmp/codex-home",
			runtimeTransport: {
				transport: "local",
				status: "connected",
				url: "runtime://local",
				server: {
					name: "codex-toys-runtime",
					version: "0.1.0",
				},
				capabilities: {
					methods: 8,
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
		expect(output).toContain("codex-toys");
		expect(output).toContain("package      codex-toys@0.3.1");
		expect(output).toContain("runtime transport runtime://local");
		expect(output).toContain("runtime status local connected");
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
	if (method === "toybox.initialize") {
		return {
			ok: true,
			serverInfo: { name: "fake-runtime", version: "0.1.0" },
			capabilities: {
				appPassThrough: true,
				toyboxMethods: ["functions.list", "functions.describe", "functions.call", "host.overview"],
				toyboxMethodMetadata: [],
			},
		};
	}
	if (method === "host.overview") {
		return {
			ok: true,
			status: "ok",
			generatedAt: "2026-05-30T00:00:00.000Z",
			system: { platform: "linux", arch: "x64", uptimeSeconds: 100 },
			disk: {
				ok: true,
				status: "ok",
				summary: "/ 10 GiB available",
				filesystems: [{
					path: "/",
					totalBytes: 20,
					freeBytes: 10,
					availableBytes: 10,
					usedBytes: 10,
					usedPercent: 50,
				}],
			},
			memory: {
				ok: true,
				status: "ok",
				summary: "1 GiB free",
				totalBytes: 2,
				freeBytes: 1,
				usedBytes: 1,
				usedPercent: 50,
			},
			docker: { ok: true, status: "ok", summary: "docker 26.0.0", serverVersion: "26.0.0" },
			systemd: { ok: true, status: "ok", summary: "no failed systemd units", failedUnits: [], truncated: false },
			tailscale: { ok: true, status: "ok", summary: "tailscale healthy", backendState: "Running", online: true, health: [] },
			versions: {
				ok: true,
				status: "ok",
				summary: "node v24.0.0; codex-toys 0.140.2",
				packages: [
					{ name: "node", ok: true, status: "ok", version: "v24.0.0" },
					{ name: "codex-toys", ok: true, status: "ok", version: "0.140.2" },
				],
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
