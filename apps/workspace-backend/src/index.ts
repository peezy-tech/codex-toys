#!/usr/bin/env bun
import {
	CodexAppServerClient,
	CodexStdioTransport,
} from "@peezy.tech/codex-flows";
import {
	CodexWorkspaceBackendProtocolServer,
	type WorkspaceBackendMethodHandler,
	type CodexWorkspaceBackendPeer,
} from "@peezy.tech/codex-flows/workspace-backend";

import path from "node:path";
import { parseArgs, type WorkspaceBackendCliArgs } from "./args.ts";
import { dispatchFlowEvent, readFlowEvent, replayFlowEvent } from "./flow/backend.ts";
import {
	helpText as flowHelpText,
	parseCli as parseFlowCli,
	readConfig as readFlowConfig,
	type FlowBackendCli,
	type FlowBackendConfig,
	type FlowBackendExecutor,
} from "./flow/config.ts";
import { WorkspaceFlowCapability } from "./flow/server.ts";
import { FlowBackendStore, type FlowRunStatus } from "./flow/store.ts";

const defaultAppServerUrl = "ws://127.0.0.1:3585";

async function main(): Promise<void> {
	const argv = Bun.argv.slice(2);
	if (isFlowCommand(argv[0])) {
		await runFlowCli(parseFlowCli(argv, process.env));
		return;
	}
	if (argv[0] === "flow") {
		await runFlowCli(parseFlowCli(argv.slice(1), process.env));
		return;
	}

	const parsed = parseArgs(argv, process.env);
	if (parsed.type === "help") {
		process.stdout.write(parsed.text);
		return;
	}

	const client = createAppServerClient(parsed);
	client.on("stderr", (line) => process.stderr.write(`${line}\n`));
	await client.connect();

	const flow = new WorkspaceFlowCapability({
		config: workspaceFlowConfig(parsed),
		env: process.env,
	});
	const workspaceBackend = new CodexWorkspaceBackendProtocolServer({
		appServer: client,
		serverName: "codex-workspace-backend-local",
		serverVersion: "0.1.0",
		flowInspection: true,
		methods: flowMethodHandlers(flow),
	});
	const peers = new WeakMap<Bun.ServerWebSocket<unknown>, CodexWorkspaceBackendPeer>();
	const server = Bun.serve({
		hostname: parsed.hostname,
		port: parsed.port,
		async fetch(request, bunServer) {
			if (bunServer.upgrade(request)) {
				return undefined;
			}
			const flowResponse = await flow.handleHttp(request);
			if (flowResponse) {
				return flowResponse;
			}
			return new Response("Codex workspace backend WebSocket server\n", {
				status: 426,
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		},
		websocket: {
			open(socket) {
				const peer: CodexWorkspaceBackendPeer = {
					send: (message) => socket.send(message),
				};
				peers.set(socket, peer);
				workspaceBackend.addPeer(peer);
			},
			message(socket, message) {
				const peer = peers.get(socket);
				if (!peer) {
					return;
				}
				void workspaceBackend.handleMessage(peer, websocketMessageToString(message))
					.catch((error: unknown) => {
						workspaceBackend.sendWorkspaceBackendEvent(peer, {
							type: "appServer.error",
							at: new Date().toISOString(),
							message: errorMessage(error),
						});
					});
			},
			close(socket) {
				const peer = peers.get(socket);
				if (peer) {
					workspaceBackend.removePeer(peer);
					peers.delete(socket);
				}
			},
		},
	});

	process.stdout.write(
		`codex-workspace-backend-local listening on ws://${server.hostname}:${server.port}\n`,
	);
	process.stdout.write(
		`codex-workspace-backend-local app-server ${
			parsed.localAppServer
				? "local stdio"
				: parsed.appServerUrl ??
					process.env.CODEX_WORKSPACE_APP_SERVER_WS_URL ??
					defaultAppServerUrl
		}\n`,
	);

	await waitForShutdown(server, client, flow);
}

function createAppServerClient(
	args: Extract<WorkspaceBackendCliArgs, { type: "serve" }>,
): CodexAppServerClient {
	const appServerUrl =
		args.appServerUrl ??
		process.env.CODEX_WORKSPACE_APP_SERVER_WS_URL ??
		defaultAppServerUrl;
	return new CodexAppServerClient({
		transport: args.localAppServer
			? new CodexStdioTransport({
					args: localAppServerArgs(),
					requestTimeoutMs: 90_000,
				})
			: undefined,
		webSocketTransportOptions: args.localAppServer
			? undefined
			: { url: appServerUrl, requestTimeoutMs: 90_000 },
		clientName: "codex-workspace-backend-local",
		clientTitle: "Codex Workspace Backend Local",
		clientVersion: "0.1.0",
	});
}

function workspaceFlowConfig(
	args: Extract<WorkspaceBackendCliArgs, { type: "serve" }>,
): FlowBackendConfig {
	return readFlowConfig(process.env, {
		host: args.hostname,
		port: args.port,
		...(args.cwd ? { cwd: args.cwd } : {}),
		...(args.dataDir ? { dataDir: args.dataDir } : {}),
		...(args.secret ? { secret: args.secret } : {}),
		...(args.executor ? { executor: requireFlowExecutor(args.executor) } : {}),
		...(args.bunCommand ? { bunCommand: args.bunCommand } : {}),
		...(args.flowRunnerPath ? { flowRunnerPath: args.flowRunnerPath } : {}),
		workspaceBackendUrl: localWorkspaceBackendUrl(args.hostname, args.port),
	});
}

function localWorkspaceBackendUrl(hostname: string, port: number): string {
	const host = hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
	return `ws://${host}:${port}`;
}

function flowMethodHandlers(
	flow: WorkspaceFlowCapability,
): Record<string, WorkspaceBackendMethodHandler> {
	return {
		"flow.dispatch": async (params) => await flow.dispatch(record(params).event ?? params),
		"flow.replay": async (params) => {
			const input = record(params);
			return await flow.replay(requiredString(input.eventId, "eventId"), {
				wait: Boolean(input.wait),
			});
		},
		"flow.listEvents": (params) => flow.listEvents({
			type: stringValue(record(params).type),
			limit: positiveIntegerValue(record(params).limit),
		}),
		"flow.getEvent": (params) =>
			flow.getEvent(requiredString(record(params).eventId, "eventId")),
		"flow.listRuns": (params) => flow.listRuns({
			eventId: stringValue(record(params).eventId),
			status: stringValue(record(params).status),
			limit: positiveIntegerValue(record(params).limit),
		}),
		"flow.getRun": (params) =>
			flow.getRun(requiredString(record(params).runId, "runId")),
	};
}

function localAppServerArgs(): string[] {
	return [
		"app-server",
		"--listen",
		"stdio://",
		"--enable",
		"apps",
		"--enable",
		"hooks",
	];
}

function websocketMessageToString(message: string | Buffer): string {
	return typeof message === "string" ? message : message.toString("utf8");
}

function waitForShutdown(
	server: Bun.Server<unknown>,
	client: CodexAppServerClient,
	flow: WorkspaceFlowCapability,
): Promise<void> {
	return new Promise((resolve) => {
		const shutdown = () => {
			process.off("SIGINT", shutdown);
			process.off("SIGTERM", shutdown);
			server.stop(true);
			client.close();
			flow.close();
			resolve();
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	});
}

async function runFlowCli(cli: FlowBackendCli): Promise<void> {
	if (cli.kind === "help") {
		process.stdout.write(flowHelpText());
		return;
	}
	const store = new FlowBackendStore(path.join(cli.config.dataDir, "flow-backend.sqlite"));
	try {
		if (cli.kind === "serve") {
			throw new Error("Use `codex-workspace-backend-local serve` for the networked workspace backend.");
		}
		if (cli.kind === "dispatch") {
			const event = await readFlowEvent(cli.eventPath);
			writeJson(await dispatchFlowEvent({
				config: cli.config,
				store,
				event,
				wait: cli.wait,
				env: process.env,
			}));
			return;
		}
		if (cli.kind === "list-events") {
			writeJson({ events: store.listEvents({ type: cli.type, limit: cli.limit }) });
			return;
		}
		if (cli.kind === "show-event") {
			const event = store.getEvent(cli.eventId);
			if (!event) {
				throw new Error(`Unknown event: ${cli.eventId}`);
			}
			writeJson({ event, runs: store.listRunsByEvent(cli.eventId) });
			return;
		}
		if (cli.kind === "replay-event") {
			writeJson(await replayFlowEvent({
				config: cli.config,
				store,
				eventId: cli.eventId,
				wait: cli.wait,
				env: process.env,
			}));
			return;
		}
		if (cli.kind === "list-runs") {
			writeJson({
				runs: store.listRuns({
					eventId: cli.eventId,
					status: cli.status ? requireRunStatus(cli.status) : undefined,
					limit: cli.limit,
				}),
			});
			return;
		}
		if (cli.kind === "show-run") {
			const run = store.getRun(cli.runId);
			if (!run) {
				throw new Error(`Unknown run: ${cli.runId}`);
			}
			writeJson({ run });
		}
	} finally {
		store.close();
	}
}

function isFlowCommand(command: string | undefined): boolean {
	return command === "dispatch" ||
		command === "list-events" ||
		command === "events" ||
		command === "show-event" ||
		command === "event" ||
		command === "replay-event" ||
		command === "replay" ||
		command === "list-runs" ||
		command === "runs" ||
		command === "show-run" ||
		command === "run";
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireRunStatus(value: string): FlowRunStatus {
	if (value === "queued" || value === "running" || value === "completed" || value === "failed") {
		return value;
	}
	throw new Error("run status must be queued, running, completed, or failed");
}

function requireFlowExecutor(value: string): FlowBackendExecutor {
	if (value === "direct" || value === "systemd-run") {
		return value;
	}
	throw new Error("executor must be direct or systemd-run");
}

function requiredString(value: unknown, name: string): string {
	const result = stringValue(value);
	if (!result) {
		throw new Error(`Missing required argument: ${name}`);
	}
	return result;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.trunc(value);
	}
	if (typeof value !== "string" || !value.trim()) {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

await main();
