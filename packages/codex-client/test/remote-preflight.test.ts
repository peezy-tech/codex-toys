import { describe, expect, test } from "vite-plus/test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectRemotePreflight } from "../src/cli/remote-preflight.ts";

describe("remote preflight", () => {
	test("checks SSH setup and the remote-agent bridge", async () => {
		const fakeSsh = await createPreflightSsh();
		const result = await collectRemotePreflight({
			sshTarget: "devbox",
			cwd: "/repo",
			timeoutMs: 1_000,
			env: {
				CODEX_FLOWS_SSH_COMMAND: fakeSsh.command,
				CODEX_FLOWS_REMOTE_AGENT_COMMAND: "/opt/codex-flows",
				CODEX_FLOWS_REMOTE_CODEX_COMMAND: "/opt/codex",
				CODEX_FLOWS_REMOTE_PATH_PREPEND: "/opt/node/bin:/opt/npm/bin",
			},
		});
		expect(result.ok).toBe(true);
		expect(result.checks).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "SSH", status: "ok" }),
			expect.objectContaining({ name: "cwd", status: "ok", detail: "/repo" }),
			expect.objectContaining({ name: "node", status: "ok", version: "v24.15.0" }),
			expect.objectContaining({ name: "codex-flows", status: "ok" }),
			expect.objectContaining({ name: "codex", status: "ok" }),
			expect.objectContaining({ name: "remote agent", status: "ok" }),
			expect.objectContaining({ name: "app-server initialize", status: "ok" }),
		]));
		expect(await fakeSsh.readLog()).toEqual(expect.arrayContaining([
			expect.objectContaining({ mode: "shell", command: "true" }),
			expect.objectContaining({ mode: "agent-request", method: "remoteAgent/status" }),
			expect.objectContaining({ mode: "agent-request", method: "appServer.call" }),
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
import { stdin, stdout } from "node:process";

const LOG_PATH = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
const remoteCommand = args.at(-1) ?? "";

if (remoteCommand.includes("remote-agent")) {
  log({ mode: "agent", command: remoteCommand });
  serveAgent();
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
  if (remoteCommand.includes("'/opt/codex-flows'")) {
    console.log("/opt/codex-flows");
    console.log("codex-flows controls Codex app-server and workspace backend surfaces.");
    process.exit(0);
  }
  if (remoteCommand.includes("'/opt/codex'")) {
    console.log("/opt/codex");
    console.log("codex-cli 0.0.0");
    process.exit(0);
  }
  console.error("unhandled command: " + remoteCommand);
  process.exit(1);
}

function serveAgent() {
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
      if (line) handleAgentLine(line);
      newline = buffer.indexOf("\\n");
    }
  });
  setInterval(() => {}, 1_000);
}

function handleAgentLine(line) {
  const message = JSON.parse(line);
  log({ mode: "agent-request", method: message.method });
  stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    result: resultFor(message.method, message.params),
  }) + "\\n");
}

function resultFor(method, params) {
  if (method === "remoteAgent/status") {
    return { ok: true, cwd: "/repo", node: "v24.15.0" };
  }
  if (method === "workspace.initialize") {
    return {
      ok: true,
      serverInfo: { name: "fake-remote-agent", version: "0.1.0" },
      capabilities: { appServerPassThrough: true, workspaceMethods: ["remoteAgent/status"] },
    };
  }
  if (method === "appServer.call" && params.method === "thread/list") {
    return { data: [], nextCursor: null };
  }
  return {};
}

function log(entry) {
  appendFileSync(LOG_PATH, JSON.stringify({ ...entry, args }) + "\\n");
}
`;
}
