import { describe, expect, test } from "vite-plus/test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import {
	createSshAppServerClient,
	createSshAppServerPlan,
	createSshExistingBackendTunnelPlan,
	createSshSpawnBackendPlan,
	parseRemoteMode,
	resolveSshRemoteOptions,
	startSshWorkspaceBackend,
} from "../src/cli/remote-provider.ts";

describe("SSH remote provider", () => {
	test("plans an existing backend tunnel", () => {
		const plan = createSshExistingBackendTunnelPlan({
			sshTarget: "devbox",
			localPort: 4596,
			remoteHost: "127.0.0.1",
			remotePort: 3586,
			timeoutMs: 1_000,
		});
		expect(plan).toEqual({
			kind: "existing-backend",
			workspaceUrl: "ws://127.0.0.1:4596",
			command: [
				"ssh",
				"-N",
				"-o",
				"ExitOnForwardFailure=yes",
				"-L",
				"4596:127.0.0.1:3586",
				"devbox",
			],
		});
	});

	test("plans a spawned remote backend with quoted cwd", () => {
		const plan = createSshSpawnBackendPlan({
			sshTarget: "devbox",
			cwd: "/work/it's here",
			localPort: 4596,
			remotePort: 3587,
			timeoutMs: 1_000,
			env: {
				CODEX_FLOWS_REMOTE_CODEX_COMMAND: "/opt/codex",
				CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND:
					"/opt/codex-workspace-backend-local",
				CODEX_FLOWS_REMOTE_PATH_PREPEND: "/opt/node/bin:/opt/bun/bin",
			},
		});
		expect(plan.workspaceUrl).toBe("ws://127.0.0.1:4596");
			expect(plan.command).toEqual([
				"ssh",
				"-T",
				"-o",
				"ExitOnForwardFailure=yes",
				"-L",
				"4596:127.0.0.1:3587",
				"devbox",
				"cd '/work/it'\\''s here' && export PATH='/opt/node/bin:/opt/bun/bin'${PATH:+\":$PATH\"} && CODEX_APP_SERVER_CODEX_COMMAND=''\\''/opt/codex'\\''' exec '/opt/codex-workspace-backend-local' 'serve' '--host' '127.0.0.1' '--port' '3587' '--local-app-server' '--cwd' '/work/it'\\''s here'",
			]);
		});

		test("plans remote Codex and backend command args without wrappers", () => {
			const plan = createSshSpawnBackendPlan({
				sshTarget: "devbox",
				cwd: "/repo",
				localPort: 4596,
				remotePort: 3587,
				timeoutMs: 1_000,
				env: {
					CODEX_FLOWS_REMOTE_CODEX_COMMAND: "/opt/codex",
					CODEX_FLOWS_REMOTE_CODEX_ARGS: "[\"-s\",\"danger-full-access\"]",
					CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND: "/opt/backend",
					CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_ARGS: "[\"--verbose\"]",
				},
			});
			expect(plan.command.at(-1)).toBe(
				"cd '/repo' && CODEX_APP_SERVER_CODEX_COMMAND=''\\''/opt/codex'\\'' '\\''-s'\\'' '\\''danger-full-access'\\''' exec '/opt/backend' '--verbose' 'serve' '--host' '127.0.0.1' '--port' '3587' '--local-app-server' '--cwd' '/repo'",
			);
		});

	test("plans direct app-server stdio over SSH", () => {
		const plan = createSshAppServerPlan({
			sshTarget: "devbox",
			cwd: "/repo",
			timeoutMs: 1_000,
			env: {
				CODEX_FLOWS_REMOTE_CODEX_COMMAND: "/opt/codex",
			},
		});
			expect(plan.command).toEqual([
				"ssh",
				"-T",
				"devbox",
				"cd '/repo' && exec '/opt/codex' 'app-server' '--listen' 'stdio://' '--enable' 'apps' '--enable' 'hooks'",
			]);
		});

	test("resolves env defaults and remote mode", () => {
		expect(resolveSshRemoteOptions({
			timeoutMs: 5_000,
			env: {
				CODEX_FLOWS_REMOTE_SSH_TARGET: "envbox",
				CODEX_FLOWS_REMOTE_CWD: "/env/repo",
				CODEX_FLOWS_REMOTE_MODE: "spawn",
				CODEX_FLOWS_REMOTE_TUNNEL_PORT: "4597",
				CODEX_FLOWS_REMOTE_BACKEND_HOST: "127.0.0.2",
				CODEX_FLOWS_REMOTE_BACKEND_PORT: "3590",
					CODEX_FLOWS_REMOTE_PATH_PREPEND: "/env/node/bin:/env/bun/bin",
					CODEX_FLOWS_REMOTE_CODEX_COMMAND: "/env/codex",
					CODEX_FLOWS_REMOTE_CODEX_ARGS: "[\"-s\",\"danger-full-access\"]",
					CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND: "/env/backend",
					CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_ARGS: "[\"--log-level\",\"debug\"]",
				},
			})).toMatchObject({
			sshTarget: "envbox",
			cwd: "/env/repo",
			remoteMode: "spawn",
			localPort: 4597,
			remoteHost: "127.0.0.2",
			remotePort: 3590,
				remotePathPrepend: "/env/node/bin:/env/bun/bin",
				remoteCodexCommand: "/env/codex",
				remoteCodexArgs: ["-s", "danger-full-access"],
				remoteWorkspaceBackendCommand: "/env/backend",
				remoteWorkspaceBackendArgs: ["--log-level", "debug"],
			});
		expect(parseRemoteMode(undefined)).toBe("spawn");
		expect(() => parseRemoteMode("bad")).toThrow(
			"--remote-mode must be existing or spawn",
		);
	});

	test("rejects inline env assignment command overrides", () => {
		expect(() => resolveSshRemoteOptions({
			sshTarget: "devbox",
			timeoutMs: 1_000,
			env: {
				CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND:
					"PATH=/opt/node/bin:$PATH /opt/codex-workspace-backend-local",
			},
		})).toThrow("CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND must be a command");
	});

	test("reuses an existing backend through a fake SSH tunnel", async () => {
		const port = await unusedPort();
		const backend = await startFakeWorkspaceBackend(port);
		const fakeSsh = await createFakeSshCommand();
		try {
			const handle = await startSshWorkspaceBackend({
				sshTarget: "devbox",
				localPort: port,
				timeoutMs: 1_000,
				remoteMode: "existing",
				env: { CODEX_FLOWS_SSH_COMMAND: fakeSsh.command },
			});
			expect(handle).toMatchObject({
				kind: "ssh-existing-backend",
				workspaceUrl: `ws://127.0.0.1:${port}`,
			});
			expect(backend.methods).toContain("workspace.initialize");
			await waitForLog(fakeSsh, (entries) =>
				entries.some((entry) => entry.mode === "existing")
			);
			handle.close();
			await waitForLog(fakeSsh, (entries) =>
				entries.some((entry) => entry.mode === "signal")
			);
			expect(await fakeSsh.readLog()).toEqual(expect.arrayContaining([
				expect.objectContaining({ mode: "existing" }),
				expect.objectContaining({ mode: "signal", signal: "SIGTERM" }),
			]));
		} finally {
			await backend.close();
		}
	});

	test("spawns a transient backend by default", async () => {
		const port = await unusedPort();
		const fakeSsh = await createFakeSshCommand();
		const handle = await startSshWorkspaceBackend({
			sshTarget: "devbox",
			localPort: port,
			timeoutMs: 300,
			env: { CODEX_FLOWS_SSH_COMMAND: fakeSsh.command },
		});
		try {
			expect(handle).toMatchObject({
				kind: "ssh-spawn-backend",
				workspaceUrl: `ws://127.0.0.1:${port}`,
			});
			await waitForLog(fakeSsh, (entries) =>
				entries.some((entry) => entry.mode === "workspace-request" &&
					entry.method === "workspace.initialize")
			);
			const entries = await fakeSsh.readLog();
			expect(entries).toEqual(expect.arrayContaining([
				expect.objectContaining({ mode: "spawn", port }),
				expect.objectContaining({ mode: "workspace-listening", port }),
			]));
			expect(entries).not.toEqual(expect.arrayContaining([
				expect.objectContaining({ mode: "existing" }),
			]));
		} finally {
			handle.close();
			await waitForLog(fakeSsh, (entries) =>
				entries.some((entry) => entry.mode === "signal")
			);
		}
	});

	test("closes SSH children when backend setup fails", async () => {
		const port = await unusedPort();
		const fakeSsh = await createFakeSshCommand({ spawnBackend: false });
		await expect(startSshWorkspaceBackend({
			sshTarget: "devbox",
			localPort: port,
			timeoutMs: 150,
			remoteMode: "existing",
			env: { CODEX_FLOWS_SSH_COMMAND: fakeSsh.command },
		})).rejects.toThrow("existing backend");
		await waitForLog(fakeSsh, (entries) =>
			entries.some((entry) => entry.mode === "signal")
		);
		expect(await fakeSsh.readLog()).toEqual(expect.arrayContaining([
			expect.objectContaining({ mode: "existing" }),
			expect.objectContaining({ mode: "signal", signal: "SIGTERM" }),
		]));
	});

	test("starts an SSH stdio app-server client with a fake SSH command", async () => {
		const fakeSsh = await createFakeSshCommand();
		const client = createSshAppServerClient({
			sshTarget: "devbox",
			timeoutMs: 1_000,
			env: { CODEX_FLOWS_SSH_COMMAND: fakeSsh.command },
		}, {
			name: "test-client",
			title: "Test Client",
		});
		try {
			await client.connect();
			const response = await client.request("thread/list", { limit: 1 });
			expect(response).toEqual({
				data: [{
					id: "thread-1",
					status: { type: "idle" },
					name: "Remote thread",
					updatedAt: 1,
				}],
			});
			await waitForLog(fakeSsh, (entries) =>
				entries.some((entry) => entry.mode === "app-request" &&
					entry.method === "thread/list")
			);
			expect(await fakeSsh.readLog()).toEqual(expect.arrayContaining([
				expect.objectContaining({ mode: "app" }),
				expect.objectContaining({ mode: "app-request", method: "initialize" }),
				expect.objectContaining({ mode: "app-request", method: "thread/list" }),
			]));
		} finally {
			client.close();
		}
	});
});

type FakeSshCommand = {
	command: string;
	readLog(): Promise<Array<Record<string, unknown>>>;
};

async function createFakeSshCommand(
	options: { spawnBackend?: boolean } = {},
): Promise<FakeSshCommand> {
	const dir = await mkdtemp(path.join(tmpdir(), "codex-flows-fake-ssh-"));
	const command = path.join(dir, "ssh.mjs");
	const logPath = path.join(dir, "ssh.log");
	const spawnBackend = options.spawnBackend ?? true;
	await writeFile(command, fakeSshScript(logPath, spawnBackend));
	await chmod(command, 0o755);
	return {
		command,
		readLog: async () => await readFakeSshLog(logPath),
	};
}

function fakeSshScript(logPath: string, spawnBackend: boolean): string {
	return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { stdin, stdout } from "node:process";

const require = createRequire(process.cwd() + "/package.json");
const { WebSocketServer } = require("ws");
const LOG_PATH = ${JSON.stringify(logPath)};
const SPAWN_BACKEND = ${JSON.stringify(spawnBackend)};
const args = process.argv.slice(2);
const port = localPort(args);

if (args.includes("-N")) {
	hold({ mode: "existing" });
} else if (port && SPAWN_BACKEND) {
	log({ mode: "spawn", port });
	await serveWorkspace(port);
} else {
	log({ mode: "app" });
	serveStdio();
}

function log(entry) {
	appendFileSync(LOG_PATH, JSON.stringify({ ...entry, args }) + "\\n");
}

function localPort(values) {
	const index = values.indexOf("-L");
	if (index < 0) {
		return undefined;
	}
	const portText = String(values[index + 1] ?? "").split(":")[0];
	const parsed = Number.parseInt(portText, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function hold(entry) {
	process.on("SIGTERM", () => {
		log({ mode: "signal", signal: "SIGTERM" });
		process.exit(0);
	});
	log(entry);
	setInterval(() => {}, 1_000);
}

async function serveWorkspace(port) {
	const wss = new WebSocketServer({ host: "127.0.0.1", port });
	process.on("SIGTERM", () => {
		log({ mode: "signal", signal: "SIGTERM" });
		wss.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 100).unref();
	});
	wss.on("connection", (socket) => {
		socket.on("message", (data) => {
			const message = JSON.parse(data.toString());
			log({ mode: "workspace-request", method: message.method });
			socket.send(JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: workspaceResult(message.method),
			}));
		});
	});
	await new Promise((resolve) => wss.once("listening", resolve));
	log({ mode: "workspace-listening", port });
	setInterval(() => {}, 1_000);
}

function workspaceResult(method) {
	if (method === "workspace.initialize") {
		return {
			ok: true,
			serverInfo: { name: "fake-ssh-workspace", version: "0.1.0" },
			capabilities: {
				appServerPassThrough: true,
				workspaceMethods: ["delegation.list"],
			},
		};
	}
	if (method === "delegation.list") {
		return { delegations: [] };
	}
	return {};
}

function serveStdio() {
	process.on("SIGTERM", () => {
		log({ mode: "signal", signal: "SIGTERM" });
		process.exit(0);
	});
	let buffer = "";
	stdin.setEncoding("utf8");
	stdin.on("data", (chunk) => {
		buffer += chunk;
		for (;;) {
			const index = buffer.indexOf("\\n");
			if (index < 0) {
				break;
			}
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (!line) {
				continue;
			}
			const message = JSON.parse(line);
			log({ mode: "app-request", method: message.method });
			if (message.id === undefined) {
				continue;
			}
			stdout.write(JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: appResult(message.method),
			}) + "\\n");
		}
	});
}

function appResult(method) {
	if (method === "initialize") {
		return { serverInfo: { name: "fake-app", version: "0.1.0" } };
	}
	if (method === "thread/list") {
		return {
			data: [{
				id: "thread-1",
				status: { type: "idle" },
				name: "Remote thread",
				updatedAt: 1,
			}],
		};
	}
	return {};
}
`;
}

async function waitForLog(
	fakeSsh: FakeSshCommand,
	predicate: (entries: Array<Record<string, unknown>>) => boolean,
): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const entries = await fakeSsh.readLog();
		if (predicate(entries)) {
			return;
		}
		await delay(25);
	}
	throw new Error("Timed out waiting for fake SSH log entry");
}

async function readFakeSshLog(
	logPath: string,
): Promise<Array<Record<string, unknown>>> {
	try {
		const text = await readFile(logPath, "utf8");
		return text.trim().split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

async function startFakeWorkspaceBackend(port: number): Promise<{
	methods: string[];
	close(): Promise<void>;
}> {
	const wss = new WebSocketServer({ host: "127.0.0.1", port });
	await new Promise<void>((resolve) => wss.once("listening", resolve));
	const methods: string[] = [];
	wss.on("connection", (socket) => {
		socket.on("message", (data) => {
			const message = JSON.parse(data.toString()) as Record<string, unknown>;
			methods.push(String(message.method));
			socket.send(JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					ok: true,
					serverInfo: { name: "fake-existing-workspace", version: "0.1.0" },
					capabilities: {
						appServerPassThrough: true,
						workspaceMethods: [],
					},
				},
			}));
		});
	});
	return {
		methods,
		close: async () => {
			await new Promise<void>((resolve, reject) => {
				wss.close((error) => error ? reject(error) : resolve());
			});
		},
	};
}

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
	});
	return port;
}
