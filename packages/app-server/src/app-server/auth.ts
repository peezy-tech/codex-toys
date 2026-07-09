import type { PlanType } from "./generated/index.ts";
import type { v2 } from "./generated/index.ts";
import type { JsonRpcNotification } from "./rpc.ts";

export type CodexAuthClientTransport = {
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
	on(event: "notification", listener: (message: JsonRpcNotification) => void): void;
	off(event: "notification", listener: (message: JsonRpcNotification) => void): void;
};

export type CodexAuthMode =
	| "apiKey"
	| "chatgpt"
	| "chatgptAuthTokens"
	| "amazonBedrock"
	| "unknown";

export type CodexLoginMethod =
	| "apiKey"
	| "chatgpt"
	| "chatgptDeviceCode"
	| "chatgptAuthTokens";

export type CodexUsageWindow = {
	usedPercent: number;
	windowDurationMins: number | null;
	resetsAt: number | null;
};

export type CodexUsageSnapshot = {
	limitId: string | null;
	limitName: string | null;
	primary: CodexUsageWindow | null;
	secondary: CodexUsageWindow | null;
	credits: v2.CreditsSnapshot | null;
	planType: PlanType | null;
	rateLimitReachedType: v2.RateLimitReachedType | null;
};

export type CodexAuthState =
	| {
			status: "unauthenticated";
			requiresOpenaiAuth: boolean;
			authMode: null;
			planType: null;
			usage: null;
	  }
	| {
			status: "authenticated";
			authMode: CodexAuthMode;
			planType: PlanType | null;
			usage: CodexUsageSnapshot | null;
	  }
	| {
			status: "loginPending";
			method: CodexLoginMethod;
			loginId: string;
			authMode: null;
			planType: null;
			usage: null;
	  }
	| {
			status: "error";
			message: string;
			authMode: null;
			planType: null;
			usage: null;
	  };

export type CodexChatGptLoginStart = {
	type: "chatgpt";
	loginId: string;
	authUrl: string;
};

export type CodexDeviceCodeLoginStart = {
	type: "chatgptDeviceCode";
	loginId: string;
	verificationUrl: string;
	userCode: string;
};

export type CodexApiKeyLoginStart = {
	type: "apiKey";
};

export type CodexAuthTokensLoginStart = {
	type: "chatgptAuthTokens";
};

export type CodexLoginStart =
	| CodexChatGptLoginStart
	| CodexDeviceCodeLoginStart
	| CodexApiKeyLoginStart
	| CodexAuthTokensLoginStart;

export type CodexAuthChangeEvent =
	| {
			type: "accountUpdated";
			state: CodexAuthState;
	  }
	| {
			type: "loginCompleted";
			loginId: string | null;
			success: boolean;
			error: string | null;
			state: CodexAuthState | null;
	  };

export type WaitForLoginOptions = {
	timeoutMs?: number;
	refreshState?: boolean;
};

export class CodexAuthTimeoutError extends Error {
	constructor(message = "Timed out waiting for Codex login to complete") {
		super(message);
		this.name = "CodexAuthTimeoutError";
	}
}

export class CodexAuthClient {
	readonly transport: CodexAuthClientTransport;

	constructor(transport: CodexAuthClientTransport) {
		this.transport = transport;
	}

	async getState(): Promise<CodexAuthState> {
		try {
			const [account, usage] = await Promise.all([
				this.transport.request<v2.GetAccountResponse>("account/read", {
					refreshToken: false,
				}),
				this.getUsage().catch(() => null),
			]);
			return accountResponseToAuthState(account, usage);
		} catch (error) {
			return {
				status: "error",
				message: errorMessage(error),
				authMode: null,
				planType: null,
				usage: null,
			};
		}
	}

	async getUsage(limitId?: string): Promise<CodexUsageSnapshot | null> {
		const response =
			await this.transport.request<v2.GetAccountRateLimitsResponse>(
				"account/rateLimits/read",
			);
		const snapshot =
			limitId && response.rateLimitsByLimitId
				? response.rateLimitsByLimitId[limitId] ?? response.rateLimits
				: response.rateLimits;
		return snapshot ? rateLimitSnapshotToUsage(snapshot) : null;
	}

	async startChatGptLogin(options: {
		codexStreamlinedLogin?: boolean;
	} = {}): Promise<CodexChatGptLoginStart> {
		const response = await this.transport.request<v2.LoginAccountResponse>(
			"account/login/start",
			{
				type: "chatgpt",
				codexStreamlinedLogin: options.codexStreamlinedLogin ?? true,
			} satisfies v2.LoginAccountParams,
		);
		if (response.type !== "chatgpt") {
			throw new Error(`Expected chatgpt login response, received ${response.type}`);
		}
		return response;
	}

	async startDeviceCodeLogin(): Promise<CodexDeviceCodeLoginStart> {
		const response = await this.transport.request<v2.LoginAccountResponse>(
			"account/login/start",
			{ type: "chatgptDeviceCode" } satisfies v2.LoginAccountParams,
		);
		if (response.type !== "chatgptDeviceCode") {
			throw new Error(
				`Expected chatgptDeviceCode login response, received ${response.type}`,
			);
		}
		return response;
	}

	async loginWithApiKey(apiKey: string): Promise<CodexApiKeyLoginStart> {
		const response = await this.transport.request<v2.LoginAccountResponse>(
			"account/login/start",
			{ type: "apiKey", apiKey } satisfies v2.LoginAccountParams,
		);
		if (response.type !== "apiKey") {
			throw new Error(`Expected apiKey login response, received ${response.type}`);
		}
		return response;
	}

	async loginWithChatGptTokens(params: {
		accessToken: string;
		chatgptAccountId: string;
		chatgptPlanType?: string | null;
	}): Promise<CodexAuthTokensLoginStart> {
		const response = await this.transport.request<v2.LoginAccountResponse>(
			"account/login/start",
			{
				type: "chatgptAuthTokens",
				accessToken: params.accessToken,
				chatgptAccountId: params.chatgptAccountId,
				chatgptPlanType: params.chatgptPlanType,
			} satisfies v2.LoginAccountParams,
		);
		if (response.type !== "chatgptAuthTokens") {
			throw new Error(
				`Expected chatgptAuthTokens login response, received ${response.type}`,
			);
		}
		return response;
	}

	cancelLogin(loginId: string): Promise<v2.CancelLoginAccountResponse> {
		return this.transport.request<v2.CancelLoginAccountResponse>(
			"account/login/cancel",
			{ loginId } satisfies v2.CancelLoginAccountParams,
		);
	}

	logout(): Promise<v2.LogoutAccountResponse> {
		return this.transport.request<v2.LogoutAccountResponse>("account/logout");
	}

	onChange(listener: (event: CodexAuthChangeEvent) => void): () => void {
		const handleNotification = (message: JsonRpcNotification) => {
			if (message.method === "account/updated") {
				void this.getState().then((state) =>
					listener({ type: "accountUpdated", state }),
				);
				return;
			}
			if (message.method === "account/login/completed") {
				const params = message.params as Partial<v2.AccountLoginCompletedNotification>;
				void this.getState()
					.catch(() => null)
					.then((state) =>
						listener({
							type: "loginCompleted",
							loginId: typeof params.loginId === "string" ? params.loginId : null,
							success: params.success === true,
							error: typeof params.error === "string" ? params.error : null,
							state,
						}),
					);
			}
		};
		this.transport.on("notification", handleNotification);
		return () => this.transport.off("notification", handleNotification);
	}

	waitForLogin(
		loginId: string,
		options: WaitForLoginOptions = {},
	): Promise<CodexAuthState> {
		const timeoutMs = options.timeoutMs ?? 5 * 60_000;
		return new Promise((resolve, reject) => {
			let settled = false;
			let unsubscribe = () => {};
			const timeout = setTimeout(() => {
				if (settled) {
					return;
				}
				settled = true;
				unsubscribe();
				reject(new CodexAuthTimeoutError());
			}, timeoutMs);

			unsubscribe = this.onChange((event) => {
				if (
					event.type !== "loginCompleted" ||
					(event.loginId && event.loginId !== loginId)
				) {
					return;
				}
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timeout);
				unsubscribe();
				if (!event.success) {
					reject(new Error(event.error ?? "Codex login failed"));
					return;
				}
				if (options.refreshState === false && event.state) {
					resolve(event.state);
					return;
				}
				this.getState().then(resolve, reject);
			});
		});
	}
}

export function createCodexAuthClient(
	transport: CodexAuthClientTransport,
): CodexAuthClient {
	return new CodexAuthClient(transport);
}

export function accountResponseToAuthState(
	response: v2.GetAccountResponse,
	usage: CodexUsageSnapshot | null = null,
): CodexAuthState {
	const account = response.account;
	if (!account) {
		return {
			status: "unauthenticated",
			requiresOpenaiAuth: response.requiresOpenaiAuth,
			authMode: null,
			planType: null,
			usage: null,
		};
	}
	return {
		status: "authenticated",
		authMode: accountTypeToAuthMode(account.type),
		planType: account.type === "chatgpt" ? account.planType : usage?.planType ?? null,
		usage,
	};
}

export function rateLimitSnapshotToUsage(
	snapshot: v2.RateLimitSnapshot,
): CodexUsageSnapshot {
	return {
		limitId: snapshot.limitId,
		limitName: snapshot.limitName,
		primary: snapshot.primary ? { ...snapshot.primary } : null,
		secondary: snapshot.secondary ? { ...snapshot.secondary } : null,
		credits: snapshot.credits,
		planType: snapshot.planType,
		rateLimitReachedType: snapshot.rateLimitReachedType,
	};
}

function accountTypeToAuthMode(type: v2.Account["type"]): CodexAuthMode {
	switch (type) {
		case "apiKey":
			return "apiKey";
		case "chatgpt":
			return "chatgpt";
		case "amazonBedrock":
			return "amazonBedrock";
		default:
			return "unknown";
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
