import { stdin, stdout } from "node:process";
import { CodexAppServerClient } from "../app-server/client.ts";
import { CodexStdioTransport } from "../app-server/stdio-transport.ts";
import { workspaceFunctionMethodMetadata, createWorkspaceFunctionMethods } from "../functions.ts";
import {
	CodexToyboxProtocolServer,
	type CodexToyboxPeer,
	type ToyboxMethodHandler,
	type ToyboxMethodMetadata,
	createWorkspaceDeferredRunMethods,
	createWorkspaceDelegationMethods,
	workspaceDeferredRunMethodMetadata,
	workspaceDelegationMethodMetadata,
} from "../toybox/index.ts";
import {
	createRemoteAutomationMethods,
	remoteAutomationMethodMetadata,
} from "./remote-automation.ts";

export const TOYBOX_STATUS_METHOD = "toybox.status";

export type ToyboxServeOptions = {
	cwd?: string;
	timeoutMs: number;
	codexCommand?: string;
	codexArgs?: string[];
};

const toyboxStatusMethodMetadata: ToyboxMethodMetadata[] = [
	{
		name: TOYBOX_STATUS_METHOD,
		description: "Read process and workspace status for the active codex-toys toybox.",
		sideEffects: "read-only",
		category: "toybox",
	},
];

export async function serveToybox(
	options: ToyboxServeOptions,
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
		clientName: "codex-toys-toybox",
		clientTitle: "Codex Toys Toybox",
		clientVersion: "0.1.0",
	});
	client.on("stderr", (line) => process.stderr.write(`${line}\n`));
	await client.connect();

	const methods: Record<string, ToyboxMethodHandler> = {};
	const workspaceRequest = async (method: string, params: unknown) => {
		const handler = methods[method];
		if (!handler) {
			throw new Error(`Unknown toybox method: ${method}`);
		}
		return await handler(params, {
			jsonrpc: "2.0",
			id: "toybox-internal",
			method,
			params,
		});
	};
	methods[TOYBOX_STATUS_METHOD] = () => ({
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
	Object.assign(methods, createWorkspaceDeferredRunMethods({
		appRequest: async (method, params) => await client.request(method, params),
		workspaceRequest,
		workspaceRoot,
	}));
	Object.assign(methods, createRemoteAutomationMethods({
		cwd: workspaceRoot,
		timeoutMs: options.timeoutMs,
		appRequest: async (method, params) => await client.request(method, params),
		workspaceRequest,
	}));

	const toybox = new CodexToyboxProtocolServer({
		appServer: client,
		serverName: "codex-toys-toybox",
		serverVersion: "0.1.0",
		methods,
		toyboxMethodMetadata: [
				...toyboxStatusMethodMetadata,
				...workspaceFunctionMethodMetadata,
				...workspaceDelegationMethodMetadata,
				...workspaceDeferredRunMethodMetadata,
				...remoteAutomationMethodMetadata,
			],
	});
	const peer: CodexToyboxPeer = {
		send: (message) => stdout.write(`${message}\n`),
	};
	toybox.addPeer(peer);

	try {
		for await (const line of readInputLines(stdin)) {
			await toybox.handleMessage(peer, line);
		}
	} finally {
		toybox.removePeer(peer);
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
