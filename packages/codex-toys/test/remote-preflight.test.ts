import { describe, expect, test } from "vite-plus/test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectRemotePreflight } from "@codex-toys/remote";

describe("remote preflight", () => {
	test("checks SSH setup and the toybox bridge", async () => {
		const fakeSsh = await createPreflightSsh();
		const result = await collectRemotePreflight({
			sshTarget: "devbox",
			cwd: "/repo",
			timeoutMs: 1_000,
			env: {
				CODEX_TOYS_SSH_COMMAND: fakeSsh.command,
				CODEX_TOYS_TOYBOX_COMMAND: "/opt/codex-toys",
				CODEX_TOYS_REMOTE_CODEX_COMMAND: "/opt/codex",
				CODEX_TOYS_REMOTE_PATH_PREPEND: "/opt/node/bin:/opt/npm/bin",
			},
		});
		expect(result.ok).toBe(true);
		expect(result.checks).toEqual(expect.arrayContaining([
			expect.objectContaining({ name: "SSH", status: "ok" }),
			expect.objectContaining({ name: "cwd", status: "ok", detail: "/repo" }),
			expect.objectContaining({ name: "node", status: "ok", version: "v24.15.0" }),
			expect.objectContaining({ name: "codex-toys", status: "ok" }),
			expect.objectContaining({ name: "codex", status: "ok" }),
			expect.objectContaining({ name: "SSH toybox", status: "ok" }),
			expect.objectContaining({ name: "app-server initialize", status: "ok" }),
		]));
		expect(await fakeSsh.readLog()).toEqual(expect.arrayContaining([
			expect.objectContaining({ mode: "shell", command: "true" }),
			expect.objectContaining({ mode: "toybox-request", method: "toybox.status" }),
			expect.objectContaining({ mode: "toybox-request", method: "app.call" }),
		]));
	});
});

async function createPreflightSsh(): Promise<{
	command: string;
	readLog(): Promise<Array<Record<string, unknown>>>;
}> {
	const dir = await mkdtemp(path.join(tmpdir(), "codex-toys-preflight-ssh-"));
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

if (remoteCommand.includes("'toybox' 'serve'")) {
  log({ mode: "toybox", command: remoteCommand });
  serveToybox();
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
  if (remoteCommand.includes("'/opt/codex-toys'")) {
    console.log("/opt/codex-toys");
    console.log("codex-toys controls Codex workbench toybox surfaces.");
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

function serveToybox() {
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
  log({ mode: "toybox-request", method: message.method });
  stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: message.id,
    result: resultFor(message.method, message.params),
  }) + "\\n");
}

function resultFor(method, params) {
  if (method === "toybox.status") {
    return { ok: true, cwd: "/repo", node: "v24.15.0" };
  }
  if (method === "toybox.initialize") {
    return {
      ok: true,
      serverInfo: { name: "fake-toybox", version: "0.1.0" },
      capabilities: { appPassThrough: true, toyboxMethods: ["toybox.status"], toyboxMethodMetadata: [] },
    };
  }
  if (method === "app.call" && params.method === "thread/list") {
    return { data: [], nextCursor: null };
  }
  return {};
}

function log(entry) {
  appendFileSync(LOG_PATH, JSON.stringify({ ...entry, args }) + "\\n");
}
`;
}
