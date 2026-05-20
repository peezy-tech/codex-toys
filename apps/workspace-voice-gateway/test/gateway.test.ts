import { describe, expect, test } from "vite-plus/test";

import { CodexEventEmitter } from "@peezy.tech/codex-flows/app-server/events";
import type { JsonRpcNotification } from "@peezy.tech/codex-flows/rpc";
import {
	APP_SERVER_NOTIFICATION_METHOD,
	CodexWorkspaceBackendClient,
	WORKSPACE_BACKEND_EVENT_METHOD,
	type WorkspaceBackendInitializeResponse,
} from "@peezy.tech/codex-flows/workspace-backend";
import { WorkspaceVoiceGateway } from "../src/gateway.ts";
import type { Logger, Speaker } from "../src/types.ts";

const silentLogger: Logger = {
	info() {},
	warn() {},
	error() {},
	debug() {},
};

describe("WorkspaceVoiceGateway", () => {
	test("observes workspace backend events and completed turns", async () => {
		const transport = new FakeWorkspaceTransport();
		const spoken: string[] = [];
		const speaker: Speaker = {
			async speak(text) {
				spoken.push(text);
			},
		};
		const gateway = new WorkspaceVoiceGateway({
			workspaceBackendUrl: "ws://unused",
			workspaceClient: new CodexWorkspaceBackendClient({ transport }),
			speaker,
			logger: silentLogger,
			maxQueuedAnnouncements: 10,
			announceBackendConnected: true,
			announceTurnStarted: false,
		});

		await gateway.start();
		transport.emitWorkspaceEvent({
			type: "connected",
			at: "2026-05-16T00:00:00.000Z",
		});
		transport.emitAppNotification({
			jsonrpc: "2.0",
			method: "turn/completed",
			params: {
				threadId: "thread-1",
				turn: {
					id: "turn-1",
					status: "completed",
					error: null,
					durationMs: 1000,
					items: [
						{
							type: "agentMessage",
							id: "final",
							phase: "final_answer",
							text: "Packed the voice gateway and verified tests.",
						},
					],
				},
			},
		});
		await waitFor(() => spoken.length === 2);
		expect(spoken).toEqual([
			"Workspace backend connected.",
			"Workspace turn completed. Packed the voice gateway and verified tests.",
		]);
		await gateway.close();
		expect(transport.closed).toBe(true);
	});
});

class FakeWorkspaceTransport extends CodexEventEmitter {
	readonly requestTimeoutMs = 1000;
	closed = false;

	start(): void {}

	close(): void {
		this.closed = true;
	}

	async request<T = unknown>(method: string, _params?: unknown): Promise<T> {
		if (method !== "workspace.initialize") {
			throw new Error(`Unexpected request: ${method}`);
		}
		return {
			ok: true,
			serverInfo: { name: "fake", version: "0.1.0" },
			capabilities: {
				appServerPassThrough: true,
				workspaceMethods: [],
				flowInspection: false,
			},
		} satisfies WorkspaceBackendInitializeResponse as T;
	}

	notify(_method: string, _params?: unknown): void {}

	emitWorkspaceEvent(event: unknown): void {
		this.emit("notification", {
			jsonrpc: "2.0",
			method: WORKSPACE_BACKEND_EVENT_METHOD,
			params: { event },
		});
	}

	emitAppNotification(message: JsonRpcNotification): void {
		this.emit("notification", {
			jsonrpc: "2.0",
			method: APP_SERVER_NOTIFICATION_METHOD,
			params: { message },
		});
	}
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let index = 0; index < 50; index += 1) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for predicate");
}
