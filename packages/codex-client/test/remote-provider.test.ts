import { describe, expect, test } from "vite-plus/test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	createSshToyboxPlan,
	createSshToyboxTransport,
	resolveSshRemoteOptions,
	withSshRemoteToyboxTransport,
} from "../src/cli/remote-provider.ts";

describe("SSH remote provider", () => {
	test("plans a toybox command with quoted cwd", () => {
		const plan = createSshToyboxPlan({
			sshTarget: "devbox",
			cwd: "/work/it's here",
			timeoutMs: 1_000,
			env: {
				CODEX_TOYS_TOYBOX_COMMAND: "/opt/codex-toys",
				CODEX_TOYS_REMOTE_CODEX_COMMAND: "/opt/codex",
				CODEX_TOYS_REMOTE_CODEX_ARGS: "[\"-s\",\"danger-full-access\"]",
				CODEX_TOYS_REMOTE_PATH_PREPEND: "/opt/node/bin:/opt/bun/bin",
			},
		});
		expect(plan).toEqual({
			kind: "toybox",
			command: [
				"ssh",
				"-T",
				"devbox",
				"cd '/work/it'\\''s here' && export PATH='/opt/node/bin:/opt/bun/bin'${PATH:+\":$PATH\"} && exec '/opt/codex-toys' 'toybox' 'serve' '--timeout-ms' '1000' '--cwd' '/work/it'\\''s here' '--codex-command' '/opt/codex' '--codex-arg' '-s' '--codex-arg' 'danger-full-access'",
			],
			remoteCommand:
				"cd '/work/it'\\''s here' && export PATH='/opt/node/bin:/opt/bun/bin'${PATH:+\":$PATH\"} && exec '/opt/codex-toys' 'toybox' 'serve' '--timeout-ms' '1000' '--cwd' '/work/it'\\''s here' '--codex-command' '/opt/codex' '--codex-arg' '-s' '--codex-arg' 'danger-full-access'",
		});
	});

	test("resolves env defaults for the SSH toybox surface", () => {
		expect(resolveSshRemoteOptions({
			timeoutMs: 5_000,
			env: {
				CODEX_TOYS_REMOTE_SSH_TARGET: "envbox",
				CODEX_TOYS_REMOTE_CWD: "/env/repo",
				CODEX_TOYS_REMOTE_PATH_PREPEND: "/env/node/bin:/env/npm/bin",
				CODEX_TOYS_TOYBOX_COMMAND: "/env/codex-toys",
				CODEX_TOYS_REMOTE_CODEX_COMMAND: "/env/codex",
				CODEX_TOYS_REMOTE_CODEX_ARGS: "[\"-s\",\"danger-full-access\"]",
			},
		})).toMatchObject({
			sshTarget: "envbox",
			cwd: "/env/repo",
			remotePathPrepend: "/env/node/bin:/env/npm/bin",
			toyboxCommand: "/env/codex-toys",
			remoteCodexCommand: "/env/codex",
			remoteCodexArgs: ["-s", "danger-full-access"],
		});
	});

	test("rejects removed backend/tunnel env vars", () => {
		expect(() => resolveSshRemoteOptions({
			sshTarget: "devbox",
			timeoutMs: 1_000,
			env: {
				CODEX_TOYS_REMOTE_TOYBOX_COMMAND: "/opt/backend",
			},
		})).toThrow("Removed SSH backend/tunnel environment variables");
	});

	test("rejects inline env assignment command overrides", () => {
		expect(() => resolveSshRemoteOptions({
			sshTarget: "devbox",
			timeoutMs: 1_000,
			env: {
				CODEX_TOYS_TOYBOX_COMMAND:
					"PATH=/opt/node/bin:$PATH /opt/codex-toys",
			},
		})).toThrow("CODEX_TOYS_TOYBOX_COMMAND must be a command");
	});

	test("starts a toybox workspace transport over fake SSH", async () => {
		const fakeSsh = await createFakeSshCommand();
		const transport = createSshToyboxTransport({
			sshTarget: "devbox",
			cwd: "/repo",
			timeoutMs: 1_000,
			env: { CODEX_TOYS_SSH_COMMAND: fakeSsh.command },
		});
		try {
			const status = await transport.request("toybox.status", {});
			expect(status).toMatchObject({ ok: true, cwd: "/repo" });
			const initialized = await transport.request("toybox.initialize", {
				clientInfo: { name: "test", title: "Test", version: "0.1.0" },
				capabilities: { appPassThrough: true },
			});
			expect(initialized).toMatchObject({
				ok: true,
				serverInfo: { name: "fake-toybox" },
			});
			const threads = await transport.request("app.call", {
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
					entry.method === "app.call")
			);
		} finally {
			transport.close();
		}
	});

	test("closes the SSH child on callback failure", async () => {
		const fakeSsh = await createFakeSshCommand();
		await expect(withSshRemoteToyboxTransport({
			sshTarget: "devbox",
			timeoutMs: 1_000,
			env: { CODEX_TOYS_SSH_COMMAND: fakeSsh.command },
		}, async (transport) => {
			await transport.request("toybox.status", {});
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
	const dir = await mkdtemp(path.join(tmpdir(), "codex-toys-fake-ssh-"));
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
log({ mode: "toybox", remoteCommand, args });

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
	if (method === "toybox.status") {
		return { ok: true, cwd: "/repo", node: "v24.15.0", codexCommand: "codex", codexArgs: [] };
	}
	if (method === "toybox.initialize") {
		return {
			ok: true,
			serverInfo: { name: "fake-toybox", version: "0.1.0" },
			capabilities: { appPassThrough: true, toyboxMethods: ["toybox.status", "functions.list", "functions.describe", "functions.call"], toyboxMethodMetadata: [] },
		};
	}
	if (method === "app.call" && params.method === "thread/list") {
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
