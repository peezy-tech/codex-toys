import { stdin, stdout } from "node:process";
import { CodexAppServerClient } from "@codex-toys/bridge/app-server/client";
import { CodexStdioTransport } from "@codex-toys/bridge/app-server/stdio-transport";
import { workbenchFunctionMethodMetadata, createWorkbenchFunctionMethods } from "@codex-toys/workbench";
import {
	CodexToyboxProtocolServer,
	type CodexToyboxPeer,
	type ToyboxMethodHandler,
	type ToyboxMethodMetadata,
} from "@codex-toys/toybox";
import {
	createWorkbenchDeferredRunMethods,
	createWorkbenchDelegationMethods,
	workbenchDeferredRunMethodMetadata,
	workbenchDelegationMethodMetadata,
} from "@codex-toys/workbench";
import {
	createRemoteAutomationMethods,
	remoteAutomationMethodMetadata,
} from "@codex-toys/workbench";
import {
	createHostOverviewMethods,
	hostOverviewMethodMetadata,
} from "@codex-toys/workbench";
import {
	createWorkbenchOverviewMethods,
	workbenchOverviewMethodMetadata,
} from "@codex-toys/workbench";

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
		description: "Read process and workbench status for the active codex-toys toybox.",
		sideEffects: "read-only",
		category: "toybox",
	},
];

export async function serveToybox(
	options: ToyboxServeOptions,
): Promise<void> {
	const workbenchRoot = options.cwd ?? process.cwd();
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
			],
			cwd: workbenchRoot,
			requestTimeoutMs: options.timeoutMs,
		}),
		clientName: "codex-toys-toybox",
		clientTitle: "Codex Toys Toybox",
		clientVersion: "0.1.0",
	});
	client.on("stderr", (line) => process.stderr.write(`${line}\n`));
	await client.connect();

	const methods: Record<string, ToyboxMethodHandler> = {};
	const workbenchRequest = async (method: string, params: unknown) => {
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
		cwd: workbenchRoot,
		pid: process.pid,
		node: process.version,
		codexCommand: options.codexCommand ?? "codex",
		codexArgs: options.codexArgs ?? [],
	});
	Object.assign(methods, createHostOverviewMethods({
		codexCommand: options.codexCommand,
		toyboxServerInfo: {
			name: "codex-toys-toybox",
			version: "0.1.0",
		},
	}));
	Object.assign(methods, createWorkbenchFunctionMethods({
		cwd: workbenchRoot,
	}));
	Object.assign(methods, createWorkbenchDelegationMethods({
		appServer: client,
		workbenchRoot,
	}));
	Object.assign(methods, createWorkbenchDeferredRunMethods({
		appRequest: async (method, params) => await client.request(method, params),
		workbenchRequest,
		workbenchRoot,
	}));
	Object.assign(methods, createWorkbenchOverviewMethods({
		workbenchRoot,
		appRequest: async (method, params) => await client.request(method, params),
		toybox: {
			transport: "local",
			status: "connected",
			url: "toybox://local",
			server: {
				name: "codex-toys-toybox",
				version: "0.1.0",
			},
		},
	}));
	Object.assign(methods, createRemoteAutomationMethods({
		cwd: workbenchRoot,
		timeoutMs: options.timeoutMs,
		appRequest: async (method, params) => await client.request(method, params),
		workbenchRequest,
	}));

	const toybox = new CodexToyboxProtocolServer({
		appServer: client,
		serverName: "codex-toys-toybox",
		serverVersion: "0.1.0",
		methods,
		toyboxMethodMetadata: [
				...toyboxStatusMethodMetadata,
				...hostOverviewMethodMetadata,
				...workbenchFunctionMethodMetadata,
				...workbenchDelegationMethodMetadata,
				...workbenchDeferredRunMethodMetadata,
				...workbenchOverviewMethodMetadata,
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
