import { expect, test } from "vite-plus/test";
import { CodexEventEmitter } from "@codex-appkit/app-server/events";
import { MicrobridgeProtocolServer } from "@codex-appkit/microbridge";

test("forwards app.call requests to the wrapped app-server", async () => {
	const appServer = new FakeAppServer();
	const server = new MicrobridgeProtocolServer({ appServer });
	const peer = new FakePeer();

	await server.handleMessage(peer, JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "app.call",
		params: {
			method: "thread/list",
			params: { limit: 1 },
		},
	}));

	expect(JSON.parse(peer.messages[0]!)).toEqual({
		jsonrpc: "2.0",
		id: 1,
		result: { ok: true, method: "thread/list", params: { limit: 1 } },
	});
});

class FakeAppServer extends CodexEventEmitter {
	async request<T = unknown>(method: string, params?: unknown): Promise<T> {
		return { ok: true, method, params } as T;
	}

	notify(): void {}

	respond(): void {}

	respondError(): void {}
}

class FakePeer {
	messages: string[] = [];

	send(message: string): void {
		this.messages.push(message);
	}
}
