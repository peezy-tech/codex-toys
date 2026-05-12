import { expect, test } from "bun:test";
import {
	CodexAuthClient,
	CodexAuthTimeoutError,
	accountResponseToAuthState,
	type CodexAuthClientTransport,
} from "../src/app-server/auth.ts";
import type { v2 } from "../src/app-server/generated/index.ts";
import type { JsonRpcNotification } from "../src/app-server/rpc.ts";

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

test("normalizes unauthenticated state", () => {
	expect(
		accountResponseToAuthState({
			requiresOpenaiAuth: true,
			account: null,
		}),
	).toEqual({
		status: "unauthenticated",
		requiresOpenaiAuth: true,
		authMode: null,
		planType: null,
		usage: null,
	});
});

test("starts every Codex login flow through account/login/start", async () => {
	const fake = new FakeAuthTransport();
	const auth = new CodexAuthClient(fake);

	await expect(auth.startChatGptLogin()).resolves.toEqual({
		type: "chatgpt",
		loginId: "login-chatgpt",
		authUrl: "https://example.test/auth",
	});
	await expect(auth.startDeviceCodeLogin()).resolves.toEqual({
		type: "chatgptDeviceCode",
		loginId: "login-device",
		verificationUrl: "https://example.test/device",
		userCode: "ABCD-EFGH",
	});
	await expect(auth.loginWithApiKey("sk-test")).resolves.toEqual({
		type: "apiKey",
	});
	await expect(
		auth.loginWithChatGptTokens({
			accessToken: "access",
			chatgptAccountId: "workspace",
			chatgptPlanType: null,
		}),
	).resolves.toEqual({ type: "chatgptAuthTokens" });

	expect(fake.requests).toEqual([
		[
			"account/login/start",
			{ type: "chatgpt", codexStreamlinedLogin: true },
		],
		["account/login/start", { type: "chatgptDeviceCode" }],
		["account/login/start", { type: "apiKey", apiKey: "sk-test" }],
		[
			"account/login/start",
			{
				type: "chatgptAuthTokens",
				accessToken: "access",
				chatgptAccountId: "workspace",
				chatgptPlanType: null,
			},
		],
	]);
});

test("getState combines anonymous account and usage state", async () => {
	const fake = new FakeAuthTransport();
	const auth = new CodexAuthClient(fake);

	const state = await auth.getState();

	expect(state.status).toBe("authenticated");
	expect(state.authMode).toBe("chatgpt");
	expect(state.planType).toBe("plus");
	expect(state.usage?.primary?.usedPercent).toBe(27);
	expect(JSON.stringify(state)).not.toContain("ada@example.com");
});

test("waits for matching login completion", async () => {
	const fake = new FakeAuthTransport();
	const auth = new CodexAuthClient(fake);
	const pending = auth.waitForLogin("login-chatgpt", { timeoutMs: 1_000 });

	fake.emit({
		method: "account/login/completed",
		params: {
			loginId: "other-login",
			success: true,
			error: null,
		},
	});
	fake.emit({
		method: "account/login/completed",
		params: {
			loginId: "login-chatgpt",
			success: true,
			error: null,
		},
	});

	await expect(pending).resolves.toMatchObject({
		status: "authenticated",
		authMode: "chatgpt",
	});
});

test("waitForLogin times out", async () => {
	const auth = new CodexAuthClient(new FakeAuthTransport());

	await expect(auth.waitForLogin("never", { timeoutMs: 1 })).rejects.toBeInstanceOf(
		CodexAuthTimeoutError,
	);
});

class FakeAuthTransport implements CodexAuthClientTransport {
	requests: Array<[string, unknown]> = [];
	#listeners = new Set<(message: JsonRpcNotification) => void>();

	async request<T = unknown>(method: string, params?: unknown): Promise<T> {
		this.requests.push([method, params]);
		if (method === "account/read") {
			return {
				requiresOpenaiAuth: false,
				account: {
					type: "chatgpt",
					email: "ada@example.com",
					planType: "plus",
				},
			} satisfies v2.GetAccountResponse as T;
		}
		if (method === "account/rateLimits/read") {
			return {
				rateLimits: {
					limitId: "codex",
					limitName: "Codex",
					primary: {
						usedPercent: 27,
						windowDurationMins: 300,
						resetsAt: 1778611200,
					},
					secondary: null,
					credits: null,
					planType: "plus",
					rateLimitReachedType: null,
				},
				rateLimitsByLimitId: null,
			} satisfies v2.GetAccountRateLimitsResponse as T;
		}
		if (method === "account/login/start") {
			const login = params as v2.LoginAccountParams;
			switch (login.type) {
				case "chatgpt":
					return {
						type: "chatgpt",
						loginId: "login-chatgpt",
						authUrl: "https://example.test/auth",
					} satisfies v2.LoginAccountResponse as T;
				case "chatgptDeviceCode":
					return {
						type: "chatgptDeviceCode",
						loginId: "login-device",
						verificationUrl: "https://example.test/device",
						userCode: "ABCD-EFGH",
					} satisfies v2.LoginAccountResponse as T;
				case "apiKey":
					return { type: "apiKey" } satisfies v2.LoginAccountResponse as T;
				case "chatgptAuthTokens":
					return {
						type: "chatgptAuthTokens",
					} satisfies v2.LoginAccountResponse as T;
			}
		}
		throw new Error(`Unexpected request ${method}`);
	}

	on(
		event: "notification",
		listener: (message: JsonRpcNotification) => void,
	): void {
		if (event === "notification") {
			this.#listeners.add(listener);
		}
	}

	off(
		event: "notification",
		listener: (message: JsonRpcNotification) => void,
	): void {
		if (event === "notification") {
			this.#listeners.delete(listener);
		}
	}

	emit(message: JsonRpcNotification): void {
		for (const listener of this.#listeners) {
			listener(message);
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
		planType: "plus",
		rateLimitReachedType: null,
	} satisfies v2.RateLimitSnapshot;
}
