import { expect, test } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	CodexStdioTransport,
	resolveCodexStdioCommand,
} from "@codex-toys/bridge/app-server/stdio-transport";

test("round-trips JSON-RPC over Node stdio transport", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "codex-stdio-"));
	const serverPath = path.join(directory, "fake-app-server.ts");
	await writeFile(serverPath, fakeAppServerSource());

	const transport = new CodexStdioTransport({
		codexCommand: process.execPath,
		args: ["--import", import.meta.resolve("tsx"), serverPath],
		requestTimeoutMs: 1_000,
	});
	const stderrLine = new Promise<string>((resolve) => {
		transport.once("stderr", resolve);
	});

	try {
		const result = await transport.request("ping", { value: 1 });
		expect(result).toEqual({ ok: true, echo: { value: 1 } });
		expect(await stderrLine).toBe("fake-ready");
	} finally {
		transport.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("resolves default stdio command from app-server options", () => {
	expect(resolveCodexStdioCommand({}, {})).toEqual({
		command: "codex",
		args: ["app-server", "--listen", "stdio://", "--enable", "apps"],
	});
	expect(
		resolveCodexStdioCommand(
			{ args: ["app-server", "--listen", "stdio://"] },
			{
				CODEX_APP_SERVER_CODEX_PACKAGE: "@example/codex",
			},
		),
	).toEqual({
		command: "vp",
		args: ["dlx", "@example/codex", "app-server", "--listen", "stdio://"],
	});
});

test("explicit stdio command wins over package command", () => {
	expect(
		resolveCodexStdioCommand(
			{ codexCommand: "/tmp/codex", args: ["app-server"] },
			{ CODEX_APP_SERVER_CODEX_PACKAGE: "@example/codex" },
		),
	).toEqual({
		command: "/tmp/codex",
		args: ["app-server"],
	});
});

test("resolves extra Codex args from env JSON", () => {
	expect(
		resolveCodexStdioCommand(
			{},
			{
				CODEX_APP_SERVER_CODEX_COMMAND: "/tmp/codex",
				CODEX_APP_SERVER_CODEX_ARGS: "[\"-s\",\"danger-full-access\"]",
			},
		),
	).toEqual({
		command: "/tmp/codex",
		args: [
			"-s",
			"danger-full-access",
			"app-server",
			"--listen",
			"stdio://",
			"--enable",
			"apps",
		],
	});
});

function fakeAppServerSource(): string {
	return `
console.error("fake-ready");

const decoder = new TextDecoder();
let buffer = "";

async function main() {
  for await (const chunk of process.stdin) {
    buffer += decoder.decode(typeof chunk === "string" ? Buffer.from(chunk) : chunk, { stream: true });
    let lineEnd = buffer.indexOf("\\n");
    while (lineEnd !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (line) {
        handleLine(line);
      }
      lineEnd = buffer.indexOf("\\n");
    }
  }
}

void main();

function handleLine(line) {
  const message = JSON.parse(line);
  if (message.method === "ping") {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: { ok: true, echo: message.params },
    }));
    return;
  }
  if (message.id !== undefined) {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "unknown method" },
    }));
  }
}
`;
}
