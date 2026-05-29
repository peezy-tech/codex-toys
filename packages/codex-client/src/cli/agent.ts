import { stdin, stdout } from "node:process";
import { CodexAppServerClient } from "../app-server/client.ts";
import { CodexStdioTransport } from "../app-server/stdio-transport.ts";
import { workspaceFunctionMethodMetadata, createWorkspaceFunctionMethods } from "../functions.ts";
import {
	CodexWorkspaceBackendProtocolServer,
	type CodexWorkspaceBackendPeer,
	type WorkspaceBackendMethodHandler,
	type WorkspaceMethodMetadata,
	createWorkspaceDelegationMethods,
	workspaceDelegationMethodMetadata,
} from "../workspace-backend/index.ts";
import {
	createRemoteAutomationMethods,
	remoteAutomationMethodMetadata,
} from "./remote-automation.ts";

export const AGENT_STATUS_METHOD = "agent.status";

export type AgentServeOptions = {
	cwd?: string;
	timeoutMs: number;
	codexCommand?: string;
	codexArgs?: string[];
};

const agentStatusMethodMetadata: WorkspaceMethodMetadata[] = [
	{
		name: AGENT_STATUS_METHOD,
		description: "Read process and workspace status for the active codex-flows agent.",
		sideEffects: "read-only",
		category: "agent",
	},
];

export async function serveAgent(
	options: AgentServeOptions,
): Promise<void> {
	const workspaceRoot = options.cwd ?? process.cwd();
	const client = new CodexAppServerClient({
		transport: new CodexStdioTransport({
			codexCommand: options.codexCommand,
			args: [
				...(options.codexArgs ?? []),
				"app-server",
				"--listen",
				"stdio://",
				"--enable",
				"apps",
				"--enable",
				"hooks",
			],
			cwd: workspaceRoot,
			requestTimeoutMs: options.timeoutMs,
		}),
		clientName: "codex-flows-agent",
		clientTitle: "Codex Flows Agent",
		clientVersion: "0.1.0",
	});
	client.on("stderr", (line) => process.stderr.write(`${line}\n`));
	await client.connect();

	const methods: Record<string, WorkspaceBackendMethodHandler> = {};
	const workspaceRequest = async (method: string, params: unknown) => {
		const handler = methods[method];
		if (!handler) {
			throw new Error(`Unknown workspace agent method: ${method}`);
		}
		return await handler(params, {
			jsonrpc: "2.0",
			id: "agent-internal",
			method,
			params,
		});
	};
	methods[AGENT_STATUS_METHOD] = () => ({
		ok: true,
		cwd: workspaceRoot,
		pid: process.pid,
		node: process.version,
		codexCommand: options.codexCommand ?? "codex",
		codexArgs: options.codexArgs ?? [],
	});
	Object.assign(methods, createWorkspaceFunctionMethods({
		cwd: workspaceRoot,
	}));
	Object.assign(methods, createWorkspaceDelegationMethods({
		appServer: client,
		workspaceRoot,
	}));
	Object.assign(methods, createRemoteAutomationMethods({
		cwd: workspaceRoot,
		timeoutMs: options.timeoutMs,
		appRequest: async (method, params) => await client.request(method, params),
		workspaceRequest,
	}));

	const workspaceBackend = new CodexWorkspaceBackendProtocolServer({
		appServer: client,
		serverName: "codex-flows-agent",
		serverVersion: "0.1.0",
		methods,
		workspaceMethodMetadata: [
			...agentStatusMethodMetadata,
			...workspaceFunctionMethodMetadata,
			...workspaceDelegationMethodMetadata,
			...remoteAutomationMethodMetadata,
		],
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
