import { stdin, stdout } from "node:process";
import { CodexAppServerClient } from "../app-server/client.ts";
import { CodexStdioTransport } from "../app-server/stdio-transport.ts";
import {
	CodexWorkspaceBackendProtocolServer,
	type CodexWorkspaceBackendPeer,
	type WorkspaceBackendMethodHandler,
} from "../workspace-backend/server.ts";
import { createRemoteAutomationMethods } from "./remote-automation.ts";

export type RemoteAgentServeOptions = {
	cwd?: string;
	timeoutMs: number;
	remoteCodexCommand?: string;
	remoteCodexArgs?: string[];
};

export async function serveRemoteAgent(
	options: RemoteAgentServeOptions,
): Promise<void> {
	const client = new CodexAppServerClient({
		transport: new CodexStdioTransport({
			codexCommand: options.remoteCodexCommand,
			args: [
				...(options.remoteCodexArgs ?? []),
				"app-server",
				"--listen",
				"stdio://",
				"--enable",
				"apps",
				"--enable",
				"hooks",
			],
			cwd: options.cwd,
			requestTimeoutMs: options.timeoutMs,
		}),
		clientName: "codex-flows-remote-agent",
		clientTitle: "Codex Flows Remote Agent",
		clientVersion: "0.1.0",
	});
	client.on("stderr", (line) => process.stderr.write(`${line}\n`));
	await client.connect();

	const methods: Record<string, WorkspaceBackendMethodHandler> = {};
	const workspaceRequest = async (method: string, params: unknown) => {
		const handler = methods[method];
		if (!handler) {
			throw new Error(`Unknown workspace backend method: ${method}`);
		}
		return await handler(params, {
			jsonrpc: "2.0",
			id: "remote-agent-internal",
			method,
			params,
		});
	};
	methods["remoteAgent/status"] = () => ({
		ok: true,
		cwd: options.cwd ?? process.cwd(),
		pid: process.pid,
		node: process.version,
		codexCommand: options.remoteCodexCommand ?? "codex",
		codexArgs: options.remoteCodexArgs ?? [],
	});
	Object.assign(methods, createRemoteAutomationMethods({
		cwd: options.cwd,
		timeoutMs: options.timeoutMs,
		appRequest: async (method, params) => await client.request(method, params),
		workspaceRequest,
	}));

	const workspaceBackend = new CodexWorkspaceBackendProtocolServer({
		appServer: client,
		serverName: "codex-flows-remote-agent",
		serverVersion: "0.1.0",
		methods,
	});
	const peer: CodexWorkspaceBackendPeer = {
		send: (message) => stdout.write(`${message}\n`),
	};
	workspaceBackend.addPeer(peer);

	try {
		for await (const line of readInputLines(stdin)) {
			await workspaceBackend.handleMessage(peer, line);
		}
	} finally {
		workspaceBackend.removePeer(peer);
		client.close();
	}
}

async function* readInputLines(
	stream: NodeJS.ReadableStream,
): AsyncGenerator<string> {
	let buffer = "";
	stream.setEncoding("utf8");
	for await (const chunk of stream) {
		buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (line.trim()) {
				yield line;
			}
			newline = buffer.indexOf("\n");
		}
	}
	if (buffer.trim()) {
		yield buffer;
	}
}
