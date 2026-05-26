import { describe, expect, test } from "vite-plus/test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectRemotePreflight } from "../src/cli/remote-preflight.ts";

describe("remote preflight", () => {
	test("checks SSH setup and a transient workspace backend", async () => {
		const fakeSsh = await createPreflightSsh();
		const port = await unusedPort();
		const result = await collectRemotePreflight({
			sshTarget: "devbox",
			cwd: "/repo",
			localPort: port,
			remotePort: 3587,
			timeoutMs: 1_000,
			env: {
				CODEX_FLOWS_SSH_COMMAND: fakeSsh.command,
				CODEX_FLOWS_REMOTE_CODEX_COMMAND: "/opt/codex",
				CODEX_FLOWS_REMOTE_WORKSPACE_BACKEND_COMMAND: "/opt/backend",
				CODEX_FLOWS_REMOTE_PATH_PREPEND: "/opt/node/bin:/opt/bun/bin",
			},
		});
		expect(result.ok).toBe(true);
		expect(result.checks).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "SSH", status: "ok" }),
			expect.objectContaining({ name: "cwd", status: "ok", detail: "/repo" }),
			expect.objectContaining({ name: "node", status: "ok", version: "v24.15.0" }),
			expect.objectContaining({ name: "transient backend", status: "ok" }),
			expect.objectContaining({ name: "app-server initialize", status: "ok" }),
		]));
		expect(await fakeSsh.readLog()).toEqual(expect.arrayContaining([
			expect.objectContaining({ mode: "shell", command: "true" }),
			expect.objectContaining({ mode: "workspace-listening", port }),
		]));
	});
});

async function createPreflightSsh(): Promise<{
	command: string;
	readLog(): Promise<Array<Record<string, unknown>>>;
}> {
	const dir = await mkdtemp(path.join(tmpdir(), "codex-flows-preflight-ssh-"));
	const command = path.join(dir, "ssh.mjs");
	const logPath = path.join(dir, "ssh.log");
	await writeFile(command, preflightSshScript(logPath));
	await chmod(command, 0o755);
	return {
		command,
		readLog: async () => {
			try {
				const text = await readFile(logPath, "utf8");
				return text.trim().split(/\r?\n/)
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Record<string, unknown>);
			} catch {
				return [];
			}
		},
	};
}

function preflightSshScript(logPath: string): string {
	return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(process.cwd() + "/package.json");
const { WebSocketServer } = require("ws");
const LOG_PATH = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
const port = localPort(args);
const remoteCommand = args.at(-1) ?? "";

if (port) {
  log({ mode: "spawn", port, remoteCommand });
  await serveWorkspace(port);
} else {
  log({ mode: "shell", command: remoteCommand });
  if (remoteCommand === "true") process.exit(0);
  if (remoteCommand.includes("test -d '/repo'")) {
    console.log("/repo");
    process.exit(0);
  }
  if (remoteCommand.includes("'node'")) {
    console.log("/opt/node/bin/node");
    console.log("v24.15.0");
    process.exit(0);
  }
  if (remoteCommand.includes("'/opt/codex'")) {
    console.log("/opt/codex");
    console.log("codex-cli 0.0.0");
    process.exit(0);
  }
  if (remoteCommand.includes("'/opt/backend'")) {
    console.log("/opt/backend");
    console.log("0.132.6");
    process.exit(0);
  }
  console.error("unhandled command: " + remoteCommand);
  process.exit(1);
}

function log(entry) {
  appendFileSync(LOG_PATH, JSON.stringify({ ...entry, args }) + "\\n");
}

function localPort(values) {
  const index = values.indexOf("-L");
  if (index < 0) return undefined;
  const portText = String(values[index + 1] ?? "").split(":")[0];
  const parsed = Number.parseInt(portText, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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
      const appMethod = message.method === "appServer.call" ? message.params.method : message.method;
      log({ mode: "workspace-request", method: appMethod });
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: resultFor(message.method, message.params),
      }));
    });
  });
  await new Promise((resolve) => wss.once("listening", resolve));
  log({ mode: "workspace-listening", port });
  setInterval(() => {}, 1_000);
}

function resultFor(method, params) {
  if (method === "workspace.initialize") {
    return {
      ok: true,
      serverInfo: { name: "fake-preflight-workspace", version: "0.1.0" },
      capabilities: { appServerPassThrough: true, workspaceMethods: [] },
    };
  }
  if (method === "appServer.call" && params.method === "thread/list") {
    return { data: [], nextCursor: null };
  }
  return {};
}
`;
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
