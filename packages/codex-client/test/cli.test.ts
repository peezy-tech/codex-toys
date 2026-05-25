import { describe, expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/cli/args.ts";
import { formatFetchInfo, type FetchInfo } from "../src/cli/fetch.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));

describe("codex-flows CLI args", () => {
	test("parses direct app-server calls", () => {
		expect(parseArgs(["app", "thread/list", "{\"limit\":1}"], {}))
			.toMatchObject({
				type: "app-call",
				method: "thread/list",
				paramsText: "{\"limit\":1}",
				url: "ws://127.0.0.1:3585",
			});
	});

	test("parses workspace-owned method calls", () => {
		expect(parseArgs([
			"--workspace-url",
			"ws://127.0.0.1:4596",
			"workspace",
			"delegation.list",
		], {})).toMatchObject({
			type: "workspace-call",
			method: "delegation.list",
			url: "ws://127.0.0.1:4596",
		});
	});

	test("parses workspace backend setup commands", () => {
		expect(parseArgs(["workspace", "backend", "init", "local", "--overwrite"], {}))
			.toEqual({
				type: "workspace-backend-init-local",
				workspaceRoot: undefined,
				overwrite: true,
				json: false,
				pretty: true,
			});
		expect(parseArgs(["workspace", "backend", "status", "--json"], {}))
			.toMatchObject({
				type: "workspace-backend-status",
				json: true,
				workspaceUrl: "ws://127.0.0.1:3586",
			});
		expect(parseArgs(["workspace", "backend", "start", "--dry-run", "--json"], {}))
			.toMatchObject({
				type: "workspace-backend-start",
				dryRun: true,
				json: true,
			});
	});

	test("parses remote backend operator commands", () => {
		expect(parseArgs(["remote", "status", "--json"], {}))
			.toMatchObject({
				type: "remote-status",
				json: true,
				workspaceUrl: "ws://127.0.0.1:3586",
			});
		expect(parseArgs([
			"remote",
			"tunnel",
			"start",
			"--ssh",
			"peezy@vps-tailnet",
			"--local-port=4596",
			"--remote-port",
			"3586",
			"--dry-run",
		], {})).toEqual({
			type: "remote-tunnel-start",
			sshTarget: "peezy@vps-tailnet",
			localPort: 4596,
			remoteHost: undefined,
			remotePort: 3586,
			dryRun: true,
			json: false,
			pretty: true,
		});
		expect(parseArgs([
			"remote",
			"turn",
			"start",
			"--prompt",
			"hello remote",
			"--via",
			"workspace",
			"--cwd",
			"/work",
		], {})).toMatchObject({
			type: "remote-turn-start",
			prompt: "hello remote",
			via: "workspace",
			cwd: "/work",
		});
	});

	test("parses SSH provider options on app, workspace, flow, and fetch commands", () => {
		const remote = {
			sshTarget: "devbox",
			cwd: "/repo",
			remoteMode: "spawn",
			localPort: 4596,
			remoteHost: "127.0.0.1",
			remotePort: 3586,
		};
		expect(parseArgs([
			"--ssh",
			"devbox",
			"--cwd",
			"/repo",
			"--remote-mode",
			"spawn",
			"--local-port",
			"4596",
			"--remote-host",
			"127.0.0.1",
			"--remote-port",
			"3586",
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
			remoteMode: "auto",
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
			remoteMode: "auto",
		});
		expect(parseArgs([
			"--ssh",
			"devbox",
			"--cwd",
			"/repo",
			"flow",
			"dispatch",
			"--event",
			"event.json",
		], {})).toMatchObject({
			type: "flow-dispatch",
			sshTarget: "devbox",
			cwd: "/repo",
			remoteMode: "auto",
		});
	});

	test("parses app-server pass-through through the workspace backend", () => {
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
	});

	test("parses flow inspection commands", () => {
		expect(parseArgs(["flow", "events", "--type", "demo.event", "--limit=10"], {}))
			.toMatchObject({
				type: "flow-list-events",
				eventType: "demo.event",
				limit: 10,
			});
		expect(parseArgs(["flow", "run", "run_123"], {})).toMatchObject({
			type: "flow-get-run",
			runId: "run_123",
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
		expect(parseArgs(["actions", "dispatch", "--event", "event.json"], {}))
			.toMatchObject({
				type: "actions-dispatch",
				eventPath: "event.json",
			});
		expect(parseArgs([
			"actions",
			"assert-run",
			"--flow",
			"actions-smoke",
			"--step",
			"smoke",
			"--artifact-text",
			"needle",
		], {})).toEqual({
			type: "actions-assert-run",
			workspaceRoot: undefined,
			flowName: "actions-smoke",
			stepName: "smoke",
			artifactText: "needle",
			pretty: true,
		});
		expect(parseArgs([
			"workspace",
			"init",
			"actions",
			"--forgejo",
			"--with-smoke",
			"--with-agent-turn",
			"--overwrite",
		], {})).toEqual({
			type: "workspace-init-actions",
			workspaceRoot: undefined,
			forgejo: true,
			github: false,
			withSmoke: true,
			withAgentTurn: true,
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
			appUrl: "ws://127.0.0.1:3585",
			workspaceUrl: "ws://127.0.0.1:3586",
			timeoutMs: 1500,
			color: false,
			json: false,
		});
		expect(parseArgs(["--json", "neofetch"], {})).toMatchObject({
			type: "fetch",
			json: true,
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
			appServerUrl: "ws://127.0.0.1:3585",
			workspaceBackendUrl: "ws://127.0.0.1:3586",
			codexHome: "/tmp/codex-home",
			backend: {
				mode: "workspace",
				status: "connected",
				url: "ws://127.0.0.1:3586",
				server: {
					name: "codex-workspace-backend-local",
					version: "0.1.0",
				},
				capabilities: {
					workspaceMethods: 8,
					flowInspection: true,
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
		expect(output).toContain("workspace    ws://127.0.0.1:3586");
		expect(output).toContain("backend      workspace connected");
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
