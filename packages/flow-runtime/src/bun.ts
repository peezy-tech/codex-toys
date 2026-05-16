import {
	CodexWorkspaceBackendClient,
	type CodexWorkspaceBackendClientOptions,
} from "@peezy.tech/codex-flows/workspace-backend";
import {
	createCodexFlowClient,
	type CodexFlowClient,
	type CodexFlowClientOptions,
} from "@peezy.tech/codex-flows/flows";
import type { FlowResult, FlowRunContext } from "./types.ts";

export type BunFlowHandler<TContext extends FlowRunContext = FlowRunContext> = (
	context: TContext,
) => FlowResult | Promise<FlowResult>;

export function defineBunFlow<TContext extends FlowRunContext = FlowRunContext>(
	handler: BunFlowHandler<TContext>,
): BunFlowHandler<TContext> {
	return handler;
}

export async function readFlowContext(input?: string | Uint8Array): Promise<FlowRunContext> {
	const text = input === undefined
		? await Bun.stdin.text()
		: typeof input === "string"
			? input
			: new TextDecoder().decode(input);
	const parsed = JSON.parse(text) as unknown;
	if (!isRecord(parsed) || !isRecord(parsed.flow)) {
		throw new Error("Flow context must be a JSON object with a flow object");
	}
	return parsed as FlowRunContext;
}

export type WorkspaceBackendClientFromContextOptions =
	Omit<CodexWorkspaceBackendClientOptions, "webSocketTransportOptions"> & {
		url?: string;
		requestTimeoutMs?: number;
		env?: Record<string, string | undefined>;
	};

export function workspaceBackendUrlFromContext(
	context: FlowRunContext,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	return context.runtime.workspaceBackendUrl ?? env.CODEX_WORKSPACE_BACKEND_WS_URL;
}

export function createWorkspaceBackendClientFromContext(
	context: FlowRunContext,
	options: WorkspaceBackendClientFromContextOptions = {},
): CodexWorkspaceBackendClient {
	const { url, requestTimeoutMs, env: optionEnv, ...clientOptions } = options;
	const workspaceBackendUrl = url ?? workspaceBackendUrlFromContext(context, optionEnv ?? process.env);
	return new CodexWorkspaceBackendClient({
		...clientOptions,
		clientName: clientOptions.clientName ?? "codex-flow-bun-step",
		clientTitle: clientOptions.clientTitle ?? `Bun Flow ${context.flow.name}/${context.flow.step}`,
		webSocketTransportOptions: clientOptions.transport
			? undefined
			: {
					url: requireWorkspaceBackendUrl(workspaceBackendUrl),
					requestTimeoutMs,
				},
	});
}

export type CodexFlowClientFromContextOptions =
	Omit<CodexFlowClientOptions, "appServerUrl" | "client" | "closeInjectedClient"> & {
		workspaceClient?: CodexWorkspaceBackendClient;
		workspaceBackendUrl?: string;
		requestTimeoutMs?: number;
		env?: Record<string, string | undefined>;
		closeWorkspaceClient?: boolean;
	};

export function createCodexFlowClientFromContext(
	context: FlowRunContext,
	options: CodexFlowClientFromContextOptions = {},
): CodexFlowClient {
	const {
		workspaceClient,
		workspaceBackendUrl,
		requestTimeoutMs,
		env,
		closeWorkspaceClient,
		...codexOptions
	} = options;
	const client = workspaceClient ?? createWorkspaceBackendClientFromContext(context, {
		url: workspaceBackendUrl,
		requestTimeoutMs,
		env,
		clientName: codexOptions.clientName ?? "codex-flow-bun-step",
		clientTitle: codexOptions.clientTitle ?? `Bun Flow ${context.flow.name}/${context.flow.step}`,
		clientVersion: codexOptions.clientVersion,
	});
	return createCodexFlowClient({
		...codexOptions,
		client,
		closeInjectedClient: workspaceClient
			? closeWorkspaceClient === true
			: closeWorkspaceClient !== false,
	});
}

function requireWorkspaceBackendUrl(value: string | undefined): string {
	if (!value) {
		throw new Error(
			"CODEX_WORKSPACE_BACKEND_WS_URL or context.runtime.workspaceBackendUrl is required",
		);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
