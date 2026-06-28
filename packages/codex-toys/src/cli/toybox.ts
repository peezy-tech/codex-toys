import { stdin, stdout } from "node:process";
import { CodexAppServerClient } from "@codex-toys/bridge/app-server/client";
import { CodexStdioTransport } from "@codex-toys/bridge/app-server/stdio-transport";
import { createFeedMethods, feedMethodMetadata } from "@codex-toys/feed";
import { workbenchFunctionMethodMetadata, createWorkbenchFunctionMethods } from "@codex-toys/workbench";
import {
	CodexToyboxProtocolServer,
	type CodexToyboxPeer,
	type ToyboxMethodHandler,
	type ToyboxMethodMetadata,
} from "@codex-toys/toybox";
import {
	createWorkbenchDispatchRunMethods,
	workbenchDispatchRunMethodMetadata,
} from "@codex-toys/workbench";
import {
	createRemoteWorkflowMethods,
	remoteWorkflowMethodMetadata,
} from "@codex-toys/workbench";
import {
	createHostOverviewMethods,
	hostOverviewMethodMetadata,
} from "@codex-toys/workbench";
import {
	createWorkbenchOverviewMethods,
	workbenchOverviewMethodMetadata,
} from "@codex-toys/workbench";
import {
	createWorkbenchContext,
	runWorkbenchTaskById,
} from "@codex-toys/workbench";

export const RUNTIME_STATUS_METHOD = "runtime.status";

export type ToyboxServeOptions = {
	cwd?: string;
	timeoutMs: number;
	codexCommand?: string;
	codexArgs?: string[];
};

const runtimeStatusMethodMetadata: ToyboxMethodMetadata[] = [
	{
		name: RUNTIME_STATUS_METHOD,
		description: "Read process and workbench status for the active codex-toys runtime.",
		sideEffects: "read-only",
		category: "runtime",
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
		clientName: "codex-toys-runtime",
		clientTitle: "Codex Toys Runtime",
		clientVersion: "0.1.0",
	});
	client.on("stderr", (line) => process.stderr.write(`${line}\n`));
	await client.connect();

	const methods: Record<string, ToyboxMethodHandler> = {};
	const workbenchRequest = async (method: string, params: unknown) => {
		const handler = methods[method];
		if (!handler) {
			throw new Error(`Unknown runtime method: ${method}`);
		}
		return await handler(params, {
			jsonrpc: "2.0",
			id: "runtime-internal",
			method,
			params,
		});
	};
	methods[RUNTIME_STATUS_METHOD] = () => ({
		ok: true,
		cwd: workbenchRoot,
		pid: process.pid,
		node: process.version,
		codexCommand: options.codexCommand ?? "codex",
		codexArgs: options.codexArgs ?? [],
	});
	Object.assign(methods, createHostOverviewMethods({
		codexCommand: options.codexCommand,
		runtimeServerInfo: {
			name: "codex-toys-runtime",
			version: "0.1.0",
		},
	}));
	Object.assign(methods, createWorkbenchFunctionMethods({
		cwd: workbenchRoot,
	}));
	Object.assign(methods, createFeedMethods({
		root: workbenchRoot,
		dispatchTarget: async (target, event, _item, feedContext) => {
			const prefix = "workbench-task:";
			if (!target.startsWith(prefix)) {
				throw new Error(`Unsupported feed dispatch target: ${target}`);
			}
			const taskId = target.slice(prefix.length);
			if (!taskId) {
				throw new Error("feed dispatch workbench-task target requires a task id");
			}
			const context = await createWorkbenchContext({
				workbenchRoot,
				mode: feedContext.mode,
			});
			const run = await runWorkbenchTaskById(context, taskId, {
				callToybox: workbenchRequest,
				event,
			});
			if (run.status === "failed") {
				throw new Error(run.error ?? `Workbench task ${taskId} failed`);
			}
			return { workbenchRun: run };
		},
	}));
	Object.assign(methods, createWorkbenchDispatchRunMethods({
		appRequest: async (method, params) => await client.request(method, params),
		workbenchRequest,
		workbenchRoot,
	}));
	Object.assign(methods, createWorkbenchOverviewMethods({
		workbenchRoot,
		appRequest: async (method, params) => await client.request(method, params),
		runtimeTransport: {
			transport: "local",
			status: "connected",
			url: "runtime://local",
			server: {
				name: "codex-toys-runtime",
				version: "0.1.0",
			},
		},
	}));
	Object.assign(methods, createRemoteWorkflowMethods({
		cwd: workbenchRoot,
		timeoutMs: options.timeoutMs,
		appRequest: async (method, params) => await client.request(method, params),
		workbenchRequest,
	}));

	const toybox = new CodexToyboxProtocolServer({
		appServer: client,
		serverName: "codex-toys-runtime",
		serverVersion: "0.1.0",
		methods,
		toyboxMethodMetadata: [
				...runtimeStatusMethodMetadata,
				...hostOverviewMethodMetadata,
				...feedMethodMetadata,
				...workbenchFunctionMethodMetadata,
				...workbenchDispatchRunMethodMetadata,
				...workbenchOverviewMethodMetadata,
				...remoteWorkflowMethodMetadata,
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
