#!/usr/bin/env node
import {
	CodexAppServerClient,
	CodexStdioTransport,
} from "@peezy.tech/codex-flows";
import {
	CodexWorkspaceBackendProtocolServer,
	type CodexWorkspaceBackendPeer,
} from "@peezy.tech/codex-flows/workspace-backend";

import http from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { parseArgs, type WorkspaceBackendCliArgs } from "./args.ts";

const defaultAppServerUrl = "ws://127.0.0.1:3585";

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const parsed = parseArgs(argv, process.env);
	if (parsed.type === "help") {
		process.stdout.write(parsed.text);
		return;
	}

	const client = createAppServerClient(parsed);
	client.on("stderr", (line) => process.stderr.write(`${line}\n`));
	await client.connect();

	const workspaceBackend = new CodexWorkspaceBackendProtocolServer({
		appServer: client,
		serverName: "codex-workspace-backend-local",
		serverVersion: "0.1.0",
	});
	const peers = new WeakMap<WebSocket, CodexWorkspaceBackendPeer>();
	const server = http.createServer((_request, response) => {
		response.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
		response.end("Codex workspace backend WebSocket server\n");
	});
	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		wss.handleUpgrade(request, socket, head, (webSocket) => {
			wss.emit("connection", webSocket, request);
		});
	});
	wss.on("connection", (socket) => {
		const peer: CodexWorkspaceBackendPeer = {
			send: (message) => socket.send(message),
		};
		peers.set(socket, peer);
		workspaceBackend.addPeer(peer);
		socket.on("message", (message) => {
			const currentPeer = peers.get(socket);
			if (!currentPeer) {
				return;
			}
			void workspaceBackend.handleMessage(currentPeer, websocketMessageToString(message))
				.catch((error: unknown) => {
					workspaceBackend.sendWorkspaceBackendEvent(currentPeer, {
						type: "appServer.error",
						at: new Date().toISOString(),
						message: errorMessage(error),
					});
				});
		});
		socket.on("close", () => {
			const currentPeer = peers.get(socket);
			if (currentPeer) {
				workspaceBackend.removePeer(currentPeer);
				peers.delete(socket);
			}
		});
	});
	await listen(server, parsed.port, parsed.hostname);

	process.stdout.write(
		`codex-workspace-backend-local listening on ws://${parsed.hostname}:${serverPort(server, parsed.port)}\n`,
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

	await waitForShutdown(server, wss, client);
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
					cwd: args.cwd,
					env: args.codexHome ? { CODEX_HOME: args.codexHome } : undefined,
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

function websocketMessageToString(message: RawData): string {
	if (Array.isArray(message)) {
		return Buffer.concat(message).toString("utf8");
	}
	return typeof message === "string" ? message : message.toString("utf8");
}

function waitForShutdown(
	server: http.Server,
	wss: WebSocketServer,
	client: CodexAppServerClient,
): Promise<void> {
	return new Promise((resolve) => {
		const shutdown = () => {
			process.off("SIGINT", shutdown);
			process.off("SIGTERM", shutdown);
			wss.close();
			server.close();
			client.close();
			resolve();
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	});
}

function listen(server: http.Server, port: number, hostname: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, hostname, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function serverPort(server: http.Server, fallback: number): number {
	const address = server.address();
	return typeof address === "object" && address ? address.port : fallback;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

await main();
