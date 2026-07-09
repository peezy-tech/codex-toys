import { expect, test } from "vite-plus/test";
import {
	CodexAuthClient,
	accountResponseToAuthState,
	type CodexAuthClientTransport,
} from "@codex-appkit/app-server/auth";
import type { v2 } from "@codex-appkit/app-server/generated";
import type { JsonRpcNotification } from "@codex-appkit/app-server/rpc";

test("normalizes authenticated ChatGPT state without exposing email", () => {
	const state = accountResponseToAuthState(
		{
			requiresOpenaiAuth: false,
			account: {
				type: "chatgpt",
				email: "ada@example.com",
				planType: "pro",
			},
		},
		usageSnapshot(),
	);

	expect(state).toEqual({
		status: "authenticated",
		authMode: "chatgpt",
		planType: "pro",
		usage: usageSnapshot(),
	});
	expect(JSON.stringify(state)).not.toContain("ada@example.com");
});

test("starts ChatGPT and API key login through account/login/start", async () => {
	const fake = new FakeAuthTransport();
	const auth = new CodexAuthClient(fake);

	await expect(auth.startChatGptLogin()).resolves.toMatchObject({
		type: "chatgpt",
		loginId: "login-chatgpt",
	});
	await expect(auth.loginWithApiKey("sk-test")).resolves.toEqual({
		type: "apiKey",
	});

	expect(fake.requests).toEqual([
		["account/login/start", { type: "chatgpt", codexStreamlinedLogin: true }],
		["account/login/start", { type: "apiKey", apiKey: "sk-test" }],
	]);
});

class FakeAuthTransport implements CodexAuthClientTransport {
	requests: Array<[string, unknown]> = [];
	#listeners = new Set<(message: JsonRpcNotification) => void>();

	async request<T = unknown>(method: string, params?: unknown): Promise<T> {
		this.requests.push([method, params]);
		if (method === "account/login/start") {
			const login = params as v2.LoginAccountParams;
			if (login.type === "chatgpt") {
				return {
					type: "chatgpt",
					loginId: "login-chatgpt",
					authUrl: "https://example.test/auth",
				} satisfies v2.LoginAccountResponse as T;
			}
			if (login.type === "apiKey") {
				return { type: "apiKey" } satisfies v2.LoginAccountResponse as T;
			}
		}
		throw new Error(`Unexpected request ${method}`);
	}

	on(event: "notification", listener: (message: JsonRpcNotification) => void): void {
		if (event === "notification") {
			this.#listeners.add(listener);
		}
	}

	off(event: "notification", listener: (message: JsonRpcNotification) => void): void {
		if (event === "notification") {
			this.#listeners.delete(listener);
		}
	}
}

function usageSnapshot() {
	return {
		limitId: "codex",
		limitName: "Codex",
		primary: {
			usedPercent: 27,
			windowDurationMins: 300,
			resetsAt: 1778611200,
		},
		secondary: null,
		credits: null,
		individualLimit: null,
		planType: "plus",
		rateLimitReachedType: null,
	} satisfies v2.RateLimitSnapshot;
}
