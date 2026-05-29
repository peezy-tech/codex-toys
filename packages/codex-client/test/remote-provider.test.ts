import { describe, expect, test } from "vite-plus/test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	createSshRemoteAgentPlan,
	createSshRemoteAgentTransport,
	resolveSshRemoteOptions,
	withSshRemoteWorkspaceTransport,
} from "../src/cli/remote-provider.ts";

describe("SSH remote provider", () => {
	test("plans a remote-agent command with quoted cwd", () => {
		const plan = createSshRemoteAgentPlan({
			sshTarget: "devbox",
			cwd: "/work/it's here",
			timeoutMs: 1_000,
			env: {
				CODEX_FLOWS_REMOTE_AGENT_COMMAND: "/opt/codex-flows",
				CODEX_FLOWS_REMOTE_CODEX_COMMAND: "/opt/codex",
				CODEX_FLOWS_REMOTE_CODEX_ARGS: "[\"-s\",\"danger-full-access\"]",
				CODEX_FLOWS_REMOTE_PATH_PREPEND: "/opt/node/bin:/opt/bun/bin",
			},
		});
		expect(plan).toEqual({
			kind: "remote-agent",
			command: [
				"ssh",
				"-T",
				"devbox",
				"cd '/work/it'\\''s here' && export PATH='/opt/node/bin:/opt/bun/bin'${PATH:+\":$PATH\"} && exec '/opt/codex-flows' 'remote-agent' 'serve' '--timeout-ms' '1000' '--cwd' '/work/it'\\''s here' '--remote-codex-command' '/opt/codex' '--remote-codex-arg' '-s' '--remote-codex-arg' 'danger-full-access'",
			],
			remoteCommand:
				"cd '/work/it'\\''s here' && export PATH='/opt/node/bin:/opt/bun/bin'${PATH:+\":$PATH\"} && exec '/opt/codex-flows' 'remote-agent' 'serve' '--timeout-ms' '1000' '--cwd' '/work/it'\\''s here' '--remote-codex-command' '/opt/codex' '--remote-codex-arg' '-s' '--remote-codex-arg' 'danger-full-access'",
		});
	});

	test("resolves env defaults for the remote-agent surface", () => {
		expect(resolveSshRemoteOptions({
			timeoutMs: 5_000,
			env: {
				CODEX_FLOWS_REMOTE_SSH_TARGET: "envbox",
				CODEX_FLOWS_REMOTE_CWD: "/env/repo",
				CODEX_FLOWS_REMOTE_PATH_PREPEND: "/env/node/bin:/env/npm/bin",
				CODEX_FLOWS_REMOTE_AGENT_COMMAND: "/env/codex-flows",
				CODEX_FLOWS_REMOTE_CODEX_COMMAND: "/env/codex",
				CODEX_FLOWS_REMOTE_CODEX_ARGS: "[\"-s\",\"danger-full-access\"]",
			},
		})).toMatchObject({
			sshTarget: "envbox",
			cwd: "/env/repo",
			remotePathPrepend: "/env/node/bin:/env/npm/bin",
			remoteAgentCommand: "/env/codex-flows",
			remoteCodexCommand: "/env/codex",
			remoteCodexArgs: ["-s", "danger-full-access"],
		});
	});

	test("rejects removed backend/tunnel env vars", () => {
		expect(() => resolveSshRemoteOptions({
			sshTarget: "devbox",
			timeoutMs: 1_000,
			env: {
				CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND: "/opt/backend",
			},
		})).toThrow("Removed SSH backend/tunnel environment variables");
	});

	test("rejects inline env assignment command overrides", () => {
		expect(() => resolveSshRemoteOptions({
			sshTarget: "devbox",
			timeoutMs: 1_000,
			env: {
				CODEX_FLOWS_REMOTE_AGENT_COMMAND:
					"PATH=/opt/node/bin:$PATH /opt/codex-flows",
			},
		})).toThrow("CODEX_FLOWS_REMOTE_AGENT_COMMAND must be a command");
	});

	test("starts a remote-agent workspace transport over fake SSH", async () => {
		const fakeSsh = await createFakeSshCommand();
		const transport = createSshRemoteAgentTransport({
			sshTarget: "devbox",
			cwd: "/repo",
			timeoutMs: 1_000,
			env: { CODEX_FLOWS_SSH_COMMAND: fakeSsh.command },
		});
		try {
			const status = await transport.request("remoteAgent/status", {});
			expect(status).toMatchObject({ ok: true, cwd: "/repo" });
			const initialized = await transport.request("workspace.initialize", {
				clientInfo: { name: "test", title: "Test", version: "0.1.0" },
				capabilities: { appServerPassThrough: true },
			});
			expect(initialized).toMatchObject({
				ok: true,
				serverInfo: { name: "fake-remote-agent" },
			});
			const threads = await transport.request("appServer.call", {
				method: "thread/list",
				params: { limit: 1 },
			});
			expect(threads).toEqual({
				data: [{
					id: "thread-1",
					status: { type: "idle" },
					name: "Remote thread",
					updatedAt: 1,
				}],
			});
			const functions = await transport.request("functions.list", {});
			expect(functions).toEqual({
				functions: [{
					name: "portfolioSnapshot",
					description: "Read the latest portfolio snapshot.",
					sideEffects: "read-only",
				}],
			});
			const described = await transport.request("functions.describe", {
				name: "portfolioSnapshot",
			});
			expect(described).toEqual({
				function: {
					name: "portfolioSnapshot",
					description: "Read the latest portfolio snapshot.",
					sideEffects: "read-only",
				},
			});
			const called = await transport.request("functions.call", {
				name: "portfolioSnapshot",
				params: { account: "demo" },
			});
			expect(called).toEqual({ result: { account: "demo", equity: 123 } });
			await waitForLog(fakeSsh, (entries) =>
				entries.some((entry) => entry.mode === "request" &&
					entry.method === "appServer.call")
			);
		} finally {
			transport.close();
		}
	});

	test("closes the SSH child on callback failure", async () => {
		const fakeSsh = await createFakeSshCommand();
		await expect(withSshRemoteWorkspaceTransport({
			sshTarget: "devbox",
			timeoutMs: 1_000,
			env: { CODEX_FLOWS_SSH_COMMAND: fakeSsh.command },
		}, async (transport) => {
			await transport.request("remoteAgent/status", {});
			throw new Error("boom");
		})).rejects.toThrow("boom");
		await waitForLog(fakeSsh, (entries) =>
			entries.some((entry) => entry.mode === "signal")
		);
	});
});

type FakeSshCommand = {
	command: string;
	readLog(): Promise<Array<Record<string, unknown>>>;
};

async function createFakeSshCommand(): Promise<FakeSshCommand> {
	const dir = await mkdtemp(path.join(tmpdir(), "codex-flows-fake-ssh-"));
	const command = path.join(dir, "ssh.mjs");
	const logPath = path.join(dir, "ssh.log");
	await writeFile(command, fakeSshScript(logPath));
	await chmod(command, 0o755);
	return {
		command,
		readLog: async () => await readFakeSshLog(logPath),
	};
}

function fakeSshScript(logPath: string): string {
	return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { stdin, stdout } from "node:process";

const LOG_PATH = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
const remoteCommand = args.at(-1) ?? "";
log({ mode: "agent", remoteCommand, args });

process.on("SIGTERM", () => {
	log({ mode: "signal", signal: "SIGTERM" });
	process.exit(0);
});

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
	log({ mode: "request", method: message.method });
	stdout.write(JSON.stringify({
		jsonrpc: "2.0",
		id: message.id,
		result: resultFor(message.method, message.params),
	}) + "\\n");
}

function resultFor(method, params) {
	if (method === "remoteAgent/status") {
		return { ok: true, cwd: "/repo", node: "v24.15.0", codexCommand: "codex", codexArgs: [] };
	}
	if (method === "workspace.initialize") {
		return {
			ok: true,
			serverInfo: { name: "fake-remote-agent", version: "0.1.0" },
			capabilities: { appServerPassThrough: true, workspaceMethods: ["remoteAgent/status", "functions.list", "functions.describe", "functions.call"] },
		};
	}
	if (method === "appServer.call" && params.method === "thread/list") {
		return {
			data: [{
				id: "thread-1",
				status: { type: "idle" },
				name: "Remote thread",
				updatedAt: 1,
			}],
			};
	}
	if (method === "functions.list") {
		return {
			functions: [{
				name: "portfolioSnapshot",
				description: "Read the latest portfolio snapshot.",
				sideEffects: "read-only",
			}],
		};
	}
	if (method === "functions.describe") {
		return {
			function: {
				name: params.name,
				description: "Read the latest portfolio snapshot.",
				sideEffects: "read-only",
			},
		};
	}
	if (method === "functions.call") {
		return {
			result: {
				account: params.params.account,
				equity: 123,
			},
		};
	}
	return {};
}

function log(entry) {
	appendFileSync(LOG_PATH, JSON.stringify({ ...entry, args }) + "\\n");
}

setInterval(() => {}, 1_000);
`;
}

async function readFakeSshLog(logPath: string): Promise<Array<Record<string, unknown>>> {
	try {
		const text = await readFile(logPath, "utf8");
		return text.trim().split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

async function waitForLog(
	fakeSsh: FakeSshCommand,
	predicate: (entries: Array<Record<string, unknown>>) => boolean,
): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		if (predicate(await fakeSsh.readLog())) {
			return;
		}
		await delay(25);
	}
	throw new Error(`Timed out waiting for fake ssh log: ${
		JSON.stringify(await fakeSsh.readLog())
	}`);
}
