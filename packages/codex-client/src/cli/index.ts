#!/usr/bin/env node
import {
	APP_SERVER_CALL_METHOD,
	WORKSPACE_BACKEND_INITIALIZE_METHOD,
	type WorkspaceBackendInitializeResponse,
} from "../workspace-backend/index.ts";
import {
	COMMON_APP_SERVER_ACTIONS,
	COMMON_WORKSPACE_BACKEND_METHODS,
} from "./actions.ts";
import {
	cleanupActionsCodexHome,
	prepareActionsCodexAuth,
} from "../actions.ts";
import {
	parseArgs,
	type ParsedCli,
} from "./args.ts";
import {
	collectFetchInfo,
	formatFetchInfo,
	type FetchBackendInfo,
	type FetchCountInfo,
	type FetchThreadSummary,
	type FetchThreadsInfo,
} from "./fetch.ts";
import {
	applyMemoryTransplant,
	formatMemoryTransplantPlan,
} from "./memories.ts";
import {
	applyPackAdd,
	collectPackDoctor,
	formatPackAddPlan,
	formatPackDoctor,
	formatPackInspection,
	formatPackList,
	inspectPackSource,
	listInstalledPacks,
} from "./pack.ts";
import {
	formatRemoteTurnStartResult,
	startRemoteTurn,
} from "./remote-control.ts";
import {
	collectRemotePreflight,
	formatRemotePreflight,
} from "./remote-preflight.ts";
import {
	createTurnAutomationHost,
	formatTurnAutomationList,
	formatTurnAutomationRun,
	listTurnAutomations,
	resolveTurnAutomationTarget,
	runTurnAutomationScript,
	type TurnAutomationBackendRequest,
	type TurnAutomationHostHandler,
	type TurnAutomationRun,
	type TurnAutomationRunTarget,
} from "./turn-automation.ts";
import {
	createLocalAgentTransport,
	createSshAgentTransport,
	hasSshRemote,
	withSshRemoteWorkspaceTransport,
	type SshRemoteProviderOptions,
} from "./remote-provider.ts";
import {
	REMOTE_AUTOMATION_LIST_METHOD,
	REMOTE_AUTOMATION_RUN_METHOD,
	type RemoteAutomationListResponse,
	type RemoteAutomationRunParams,
} from "./remote-automation.ts";
import {
	WORKSPACE_FUNCTIONS_CALL_METHOD,
	WORKSPACE_FUNCTIONS_DESCRIBE_METHOD,
	WORKSPACE_FUNCTIONS_LIST_METHOD,
	type WorkspaceFunctionMetadata,
	type WorkspaceFunctionsCallResponse,
	type WorkspaceFunctionsDescribeResponse,
	type WorkspaceFunctionsListResponse,
} from "../functions.ts";
import { serveAgent } from "./agent.ts";
import type { CodexWorkspaceBackendTransport } from "../workspace-backend/client.ts";
import {
	formatThreadRolloutInspection,
	formatThreadRolloutInstallation,
	formatThreadRolloutLocation,
	formatThreadRolloutTransplant,
	installThreadRollout,
	inspectThreadRollout,
	locateThreadRollout,
	transplantThreadRollout,
} from "../threads.ts";
import {
	collectWorkspaceDoctorInfo,
	commitActionsWorkspaceState,
	createWorkspaceContext,
	formatWorkspaceDoctorInfo,
	runWorkspaceTaskById,
	scaffoldActionsWorkspace,
	tickWorkspace,
} from "./workspace-autonomy.ts";
import {
	formatWorkspaceDelegationListResult,
	formatWorkspaceDelegationStartResult,
	startWorkspaceDelegationWithRequest,
	type WorkspaceDelegationListResult,
} from "./workspace-delegation.ts";
import { serveCodexFlowsMcp } from "./mcp.ts";
import { parseJsonParamsText, readJsonFile } from "./json.ts";

await main().catch((error) => {
	process.stderr.write(`${errorMessage(error)}\n`);
	process.exitCode = 1;
});

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv.slice(2), process.env);
	if (parsed.type === "help") {
		write(helpText());
		return;
	}
	if (parsed.type === "mcp-serve") {
		serveCodexFlowsMcp({
			timeoutMs: parsed.timeoutMs,
		});
		return;
	}
	if (parsed.type === "fetch") {
		const info = await collectFetchInfo({
			appUrl: parsed.appUrl,
			workspaceUrl: parsed.workspaceUrl,
			cwd: parsed.sshTarget ? parsed.cwd : undefined,
			backend: await collectBackendInfo(parsed),
		});
		write(parsed.json
			? `${JSON.stringify(info, null, 2)}\n`
			: formatFetchInfo(info, { color: parsed.color }));
		return;
	}
	if (parsed.type === "remote-preflight") {
		const result = await collectRemotePreflight(parsed);
		write(parsed.json
			? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
			: formatRemotePreflight(result));
		if (!result.ok) {
			process.exitCode = 1;
		}
		return;
	}
	if (parsed.type === "agent-serve") {
		await serveAgent({
			cwd: parsed.cwd,
			timeoutMs: parsed.timeoutMs,
			codexCommand: parsed.remoteCodexCommand,
			codexArgs: parsed.remoteCodexArgs,
		});
		return;
	}
	if (parsed.type === "automation-run") {
		validateAutomationTurnOptions(parsed);
		if (hasSshRemote(parsed)) {
			const run = await runRemoteTurnAutomationForCli(parsed);
			write(parsed.json
				? `${JSON.stringify(run, null, parsed.pretty ? 2 : 0)}\n`
				: formatTurnAutomationRun(run));
			return;
		}
		const event = parsed.eventPath
			? await readJsonFile(parsed.eventPath)
			: undefined;
		const target = await resolveTurnAutomationTarget(parsed.target, {
			cwd: parsed.workspaceRoot,
		});
		const prompt = parsed.prompt ?? target.prompt;
		const cwd = parsed.cwd ?? target.cwd;
		const run = await runTurnAutomationForCli(target, {
			event,
			prompt,
			cwd,
			via: parsed.via,
			appUrl: parsed.appUrl,
			workspaceUrl: parsed.workspaceUrl,
			timeoutMs: parsed.timeoutMs,
			sandbox: parsed.sandbox,
			approvalPolicy: parsed.approvalPolicy,
			permissions: parsed.permissions,
			model: parsed.model,
			sshTarget: parsed.sshTarget,
			remotePathPrepend: parsed.remotePathPrepend,
			agentCommand: parsed.agentCommand,
			remoteCodexCommand: parsed.remoteCodexCommand,
			remoteCodexArgs: parsed.remoteCodexArgs,
		});
		write(parsed.json
			? `${JSON.stringify(run, null, parsed.pretty ? 2 : 0)}\n`
			: formatTurnAutomationRun(run));
		return;
	}
	if (parsed.type === "automation-list") {
		const automations = hasSshRemote(parsed)
			? await listRemoteTurnAutomationsForCli(parsed)
			: await listTurnAutomations({ cwd: parsed.workspaceRoot });
		write(parsed.json
			? `${JSON.stringify({ automations }, null, parsed.pretty ? 2 : 0)}\n`
			: formatTurnAutomationList(automations));
		return;
	}
	if (parsed.type === "app-actions") {
		write(`${COMMON_APP_SERVER_ACTIONS.join("\n")}\n`);
		return;
	}
	if (parsed.type === "app-call") {
		writeJson(
			await callAppServer(
				parsed.method,
				await readParams(parsed.paramsText, parsed.paramsFile),
				parsed,
			),
			parsed.pretty,
		);
		return;
	}
	if (parsed.type === "functions-list") {
		const response = await callWorkspaceBackend(
			WORKSPACE_FUNCTIONS_LIST_METHOD,
			{},
			parsed,
		) as WorkspaceFunctionsListResponse;
		write(parsed.json
			? `${JSON.stringify(response, null, parsed.pretty ? 2 : 0)}\n`
			: formatFunctionsList(response.functions));
		return;
	}
	if (parsed.type === "functions-describe") {
		const response = await callWorkspaceBackend(
			WORKSPACE_FUNCTIONS_DESCRIBE_METHOD,
			{ name: parsed.name },
			parsed,
		) as WorkspaceFunctionsDescribeResponse;
		write(parsed.json
			? `${JSON.stringify(response, null, parsed.pretty ? 2 : 0)}\n`
			: formatFunctionDescription(response.function));
		return;
	}
	if (parsed.type === "functions-call") {
		const response = await callWorkspaceBackend(
			WORKSPACE_FUNCTIONS_CALL_METHOD,
			{
				name: parsed.name,
				params: await readParams(parsed.paramsText, parsed.paramsFile),
			},
			parsed,
		) as WorkspaceFunctionsCallResponse;
		write(parsed.json
			? `${JSON.stringify(response, null, parsed.pretty ? 2 : 0)}\n`
			: `${JSON.stringify(response.result, null, 2)}\n`);
		return;
	}
	if (parsed.type === "turn-run") {
		const result = await startRemoteTurn({
			prompt: parsed.prompt,
			threadId: parsed.threadId,
			cwd: parsed.cwd,
			via: "workspace",
			appUrl: parsed.appUrl,
			workspaceUrl: parsed.workspaceUrl,
			timeoutMs: parsed.timeoutMs,
			wait: parsed.wait,
			sandbox: parsed.sandbox,
			approvalPolicy: parsed.approvalPolicy,
			permissions: parsed.permissions,
			model: parsed.model,
			sshTarget: parsed.sshTarget,
			remotePathPrepend: parsed.remotePathPrepend,
			agentCommand: parsed.agentCommand,
			remoteCodexCommand: parsed.remoteCodexCommand,
			remoteCodexArgs: parsed.remoteCodexArgs,
		});
		write(parsed.json
			? `${JSON.stringify({
				threadId: result.threadId,
				turnId: result.turnId,
				status: result.status,
				cwd: result.cwd ?? parsed.cwd ?? null,
				finalMessage: result.finalMessage,
				error: result.error,
			}, null, parsed.pretty ? 2 : 0)}\n`
			: formatRemoteTurnStartResult(result));
		if (parsed.wait && (result.status === "failed" || result.status === "timed_out")) {
			process.exitCode = 1;
		}
		return;
	}
	if (parsed.type === "workspace-methods") {
		const initialized = await initializeWorkspaceBackend(parsed);
		writeJson({
			advertised: initialized.capabilities.workspaceMethods,
			common: COMMON_WORKSPACE_BACKEND_METHODS,
		}, parsed.pretty);
		return;
	}
	if (parsed.type === "workspace-delegate-list") {
		const response = await callWorkspaceBackend(
			"delegation.list",
			{ includeTargets: true },
			parsed,
		) as WorkspaceDelegationListResult;
		write(parsed.json
			? `${JSON.stringify(response, null, parsed.pretty ? 2 : 0)}\n`
			: formatWorkspaceDelegationListResult(response));
		return;
	}
	if (parsed.type === "workspace-delegate-start") {
		validateAutomationTurnOptions(parsed);
		const result = await withWorkspaceTransport(parsed, async (transport) => {
			await initialize(transport);
			return await startWorkspaceDelegationWithRequest(
				async (method, params) => await transport.request(method, params),
				{
					cwd: parsed.targetCwd,
					prompt: parsed.prompt,
					title: parsed.title,
					groupId: parsed.groupId,
					returnMode: parsed.returnMode,
					wait: parsed.wait,
					timeoutMs: parsed.timeoutMs,
					allowAbsoluteCwd: parsed.allowAbsoluteCwd,
					model: parsed.model,
					sandbox: parsed.sandbox,
					approvalPolicy: parsed.approvalPolicy,
					permissions: parsed.permissions,
				},
			);
		});
		write(parsed.json
			? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
			: formatWorkspaceDelegationStartResult(result));
		if (result.wait?.status === "failed") {
			process.exitCode = 1;
		}
		return;
	}
	if (parsed.type === "workspace-doctor") {
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot,
			mode: parsed.mode,
		});
		const info = await collectWorkspaceDoctorInfo(context);
		const backend = await collectBackendInfo({
			appUrl: parsed.appUrl,
			workspaceUrl: parsed.workspaceUrl,
			timeoutMs: parsed.timeoutMs,
			sshTarget: parsed.sshTarget,
			cwd: parsed.cwd,
			remotePathPrepend: parsed.remotePathPrepend,
			agentCommand: parsed.agentCommand,
			remoteCodexCommand: parsed.remoteCodexCommand,
			remoteCodexArgs: parsed.remoteCodexArgs,
		});
		const result = { ...info, backend };
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: `${formatWorkspaceDoctorInfo(info)}agent              ${backendLabelForDoctor(backend)}\n`);
		return;
	}
	if (parsed.type === "workspace-tick") {
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot,
			mode: parsed.mode,
		});
		const result = await tickWorkspace(context, {
			callWorkspaceBackend: async (method, params) =>
				await callWorkspaceBackend(method, params, parsed),
			automationCwd: parsed.cwd,
		});
		writeJson({
			...result,
			actionsCommit: await commitActionsWorkspaceState(context),
		}, parsed.pretty);
		return;
	}
	if (parsed.type === "workspace-run") {
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot,
			mode: parsed.mode,
		});
		const run = await runWorkspaceTaskById(context, parsed.taskId, {
			callWorkspaceBackend: async (method, params) =>
				await callWorkspaceBackend(method, params, parsed),
			automationCwd: parsed.cwd,
		});
		writeJson({
			run,
			actionsCommit: await commitActionsWorkspaceState(context, {
				message: `Update Codex workspace state for ${parsed.taskId}`,
			}),
		}, parsed.pretty);
		return;
	}
	if (parsed.type === "workspace-init-actions") {
		writeJson(await scaffoldActionsWorkspace({
			workspaceRoot: parsed.workspaceRoot,
			forgejo: parsed.forgejo,
			github: parsed.github,
			overwrite: parsed.overwrite,
		}), parsed.pretty);
		return;
	}
	if (parsed.type === "workspace-call") {
		writeJson(
			await callWorkspaceBackend(
					parsed.method,
					await readParams(parsed.paramsText, parsed.paramsFile),
					parsed,
				),
			parsed.pretty,
		);
		return;
	}
	if (parsed.type === "workspace-app-call") {
		writeJson(
			await callWorkspaceBackend(
				APP_SERVER_CALL_METHOD,
				{
						method: parsed.method,
						params: await readParams(parsed.paramsText, parsed.paramsFile),
					},
				parsed,
			),
			parsed.pretty,
		);
		return;
	}
	if (parsed.type === "actions-prepare-auth") {
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot,
			mode: "actions",
		});
		writeJson(await prepareActionsCodexAuth({
			workspaceRoot: context.repoRoot,
			env: process.env,
		}), parsed.pretty);
		return;
	}
	if (parsed.type === "actions-cleanup") {
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot,
			mode: "actions",
		});
		writeJson(await cleanupActionsCodexHome({
			workspaceRoot: context.repoRoot,
		}), parsed.pretty);
		return;
	}
	if (parsed.type === "memories-transplant") {
		const plan = await applyMemoryTransplant(parsed);
		write(parsed.json
			? `${JSON.stringify(plan, null, 2)}\n`
			: formatMemoryTransplantPlan(plan));
		return;
	}
	if (parsed.type === "threads-locate") {
		const location = await locateThreadRollout(parsed);
		write(parsed.json
			? `${JSON.stringify(location, null, 2)}\n`
			: formatThreadRolloutLocation(location));
		return;
	}
	if (parsed.type === "threads-inspect") {
		const result = await inspectThreadRollout(parsed);
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: formatThreadRolloutInspection(result));
		return;
	}
	if (parsed.type === "threads-install-rollout") {
		const result = await installThreadRollout(parsed);
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: formatThreadRolloutInstallation(result));
		return;
	}
	if (parsed.type === "threads-transplant") {
		const result = await transplantThreadRollout(parsed);
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: formatThreadRolloutTransplant(result));
		return;
	}
	if (parsed.type === "pack-inspect") {
		const inspection = await inspectPackSource(parsed);
		write(parsed.json
			? `${JSON.stringify(inspection, null, 2)}\n`
			: formatPackInspection(inspection));
		return;
	}
	if (parsed.type === "pack-add") {
		const plan = await applyPackAdd(parsed);
		write(parsed.json
			? `${JSON.stringify(plan, null, 2)}\n`
			: formatPackAddPlan(plan));
		return;
	}
	if (parsed.type === "pack-doctor") {
		const result = await collectPackDoctor(parsed);
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: formatPackDoctor(result));
		return;
	}
	if (parsed.type === "pack-list") {
		const result = await listInstalledPacks(parsed);
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: formatPackList(result));
		return;
	}
}

function backendLabelForDoctor(backend: FetchBackendInfo): string {
	if (backend.status === "connected") {
		return backend.url ? `${backend.mode} connected (${backend.url})` : `${backend.mode} connected`;
	}
	return backend.error ? `unavailable (${backend.error})` : "unavailable";
}

async function callAppServer(
	method: string,
	params: unknown,
	options: { url: string; timeoutMs: number } & SshRemoteProviderOptions,
): Promise<unknown> {
	return await callWorkspaceBackend(APP_SERVER_CALL_METHOD, { method, params }, options);
}

async function listRemoteTurnAutomationsForCli(
	options: {
		workspaceRoot?: string;
		cwd?: string;
		timeoutMs: number;
	} & SshRemoteProviderOptions,
): Promise<RemoteAutomationListResponse["automations"]> {
	return await withSshRemoteWorkspaceTransport(options, async (transport) => {
		await initialize(transport);
		const response = await transport.request<RemoteAutomationListResponse>(
			REMOTE_AUTOMATION_LIST_METHOD,
			{
				workspaceRoot: options.workspaceRoot,
				cwd: options.cwd,
			},
		);
		return response.automations;
	});
}

async function runRemoteTurnAutomationForCli(
	options: {
		target: string;
		eventPath?: string;
		prompt?: string;
		workspaceRoot?: string;
		cwd?: string;
		via: "workspace" | "app";
		timeoutMs: number;
		sandbox?: RemoteAutomationRunParams["sandbox"];
		approvalPolicy?: RemoteAutomationRunParams["approvalPolicy"];
		permissions?: string;
		model?: string;
	} & SshRemoteProviderOptions,
): Promise<TurnAutomationRun> {
	return await withSshRemoteWorkspaceTransport(options, async (transport) => {
		await initialize(transport);
		return await transport.request<TurnAutomationRun>(
			REMOTE_AUTOMATION_RUN_METHOD,
			{
				target: options.target,
				eventPath: options.eventPath,
				prompt: options.prompt,
				workspaceRoot: options.workspaceRoot,
				cwd: options.cwd,
				via: options.via,
				timeoutMs: options.timeoutMs,
				sandbox: options.sandbox,
				approvalPolicy: options.approvalPolicy,
				permissions: options.permissions,
				model: options.model,
			} satisfies RemoteAutomationRunParams,
		);
	});
}

function validateAutomationTurnOptions(options: {
	sandbox?: string;
	permissions?: string;
}): void {
	if (options.sandbox && options.permissions) {
		throw new Error("--sandbox cannot be combined with --permissions");
	}
}

function formatFunctionsList(functions: WorkspaceFunctionMetadata[]): string {
	if (functions.length === 0) {
		return "No workspace functions found.\n";
	}
	return `${functions.map((fn) => {
		const suffix = fn.description ? ` - ${fn.description}` : "";
		return `${fn.name} [${fn.sideEffects}]${suffix}`;
	}).join("\n")}\n`;
}

function formatFunctionDescription(fn: WorkspaceFunctionMetadata): string {
	return `${JSON.stringify(fn, null, 2)}\n`;
}

async function runTurnAutomationForCli(
	target: TurnAutomationRunTarget,
	options: {
		event?: unknown;
		prompt?: string;
		cwd?: string;
		via: "workspace" | "app";
		appUrl: string;
		workspaceUrl: string;
		timeoutMs: number;
		sandbox?: RemoteAutomationRunParams["sandbox"];
		approvalPolicy?: RemoteAutomationRunParams["approvalPolicy"];
		permissions?: string;
		model?: string;
	} & SshRemoteProviderOptions,
): Promise<TurnAutomationRun> {
	const host = createCliTurnAutomationHost({
		...options,
		defaults: {
			prompt: options.prompt,
			cwd: options.cwd,
			skills: target.skills,
			sandbox: options.sandbox,
			approvalPolicy: options.approvalPolicy,
			permissions: options.permissions,
			model: options.model,
		},
	});
	try {
		return await runTurnAutomationScript({
			scriptPath: target.scriptPath,
			automation: target.automation,
			event: options.event,
			prompt: options.prompt,
			cwd: options.cwd,
			timeoutMs: options.timeoutMs,
			host: host.handler,
		});
	} finally {
		host.close();
	}
}

function createCliTurnAutomationHost(
	options: {
		via: "workspace" | "app";
		appUrl: string;
		workspaceUrl: string;
		timeoutMs: number;
		defaults: {
			prompt?: string;
			cwd?: string;
			skills?: string[];
			sandbox?: RemoteAutomationRunParams["sandbox"];
			approvalPolicy?: RemoteAutomationRunParams["approvalPolicy"];
			permissions?: string;
			model?: string;
		};
	} & SshRemoteProviderOptions,
): { handler: TurnAutomationHostHandler; close(): void } {
	if (options.via === "workspace") {
		const requester = createLazyWorkspaceRequester({
			...options,
			url: options.workspaceUrl,
		});
		return {
			handler: createTurnAutomationHost({
				via: "workspace",
				appRequest: requester.appRequest,
				workspaceRequest: requester.workspaceRequest,
				defaults: options.defaults,
			}),
			close: requester.close,
		};
	}
	const requester = createLazyAppServerRequester({
		...options,
		url: options.appUrl,
	});
	return {
		handler: createTurnAutomationHost({
			via: "app-server",
			appRequest: requester.request,
			defaults: options.defaults,
		}),
		close: requester.close,
	};
}

function createLazyAppServerRequester(
	options: { url: string; timeoutMs: number } & SshRemoteProviderOptions,
): { request: TurnAutomationBackendRequest; close(): void } {
	const requester = createLazyWorkspaceRequester(options);
	return {
		request: requester.appRequest,
		close: requester.close,
	};
}

function createLazyWorkspaceRequester(
	options: { url: string; timeoutMs: number } & SshRemoteProviderOptions,
): {
	appRequest: TurnAutomationBackendRequest;
	workspaceRequest: TurnAutomationBackendRequest;
	close(): void;
} {
	let transport: CodexWorkspaceBackendTransport | undefined;
	const getTransport = async (): Promise<CodexWorkspaceBackendTransport> => {
		if (transport) {
			return transport;
		}
		if (hasSshRemote(options)) {
			transport = createSshAgentTransport(options);
		} else {
			transport = createLocalAgentTransport(options);
		}
		try {
			transport.start();
			await initialize(transport);
			return transport;
		} catch (error) {
			transport.close();
			transport = undefined;
			throw error;
		}
	};
	return {
		appRequest: async (method, params) =>
			await (await getTransport()).request(APP_SERVER_CALL_METHOD, {
				method,
				params,
			}),
		workspaceRequest: async (method, params) =>
			await (await getTransport()).request(method, params),
		close: () => {
			transport?.close();
			transport = undefined;
		},
	};
}

async function initializeWorkspaceBackend(options: {
	url: string;
	timeoutMs: number;
} & SshRemoteProviderOptions): Promise<WorkspaceBackendInitializeResponse> {
	return await withWorkspaceTransport(options, async (transport) =>
		await initialize(transport)
	);
}

async function callWorkspaceBackend(
	method: string,
	params: unknown,
	options: { url: string; timeoutMs: number } & SshRemoteProviderOptions,
): Promise<unknown> {
	return await withWorkspaceTransport(options, async (transport) => {
		await initialize(transport);
		return await transport.request(method, params);
	});
}

async function withWorkspaceTransport<T>(
	options: { url: string; timeoutMs: number } & SshRemoteProviderOptions,
	callback: (transport: CodexWorkspaceBackendTransport) => Promise<T>,
): Promise<T> {
	if (hasSshRemote(options)) {
		return await withSshRemoteWorkspaceTransport(options, callback);
	}
	const transport = createLocalAgentTransport(options);
	try {
		transport.start();
		return await callback(transport);
	} finally {
		transport.close();
	}
}

async function initialize(
	transport: CodexWorkspaceBackendTransport,
): Promise<WorkspaceBackendInitializeResponse> {
	return await transport.request<WorkspaceBackendInitializeResponse>(
		WORKSPACE_BACKEND_INITIALIZE_METHOD,
		{
			clientInfo: {
				name: "codex-flows-cli",
				title: "Codex Flows CLI",
				version: "0.1.0",
			},
			capabilities: {
				appServerPassThrough: true,
			},
		},
	);
}

async function collectBackendInfo(options: {
	appUrl: string;
	workspaceUrl: string;
	timeoutMs: number;
} & SshRemoteProviderOptions): Promise<FetchBackendInfo> {
	if (hasSshRemote(options)) {
		return await collectSshBackendInfo(options);
	}
	return await collectLocalAgentInfo(options);
}

async function collectSshBackendInfo(
	options: {
		appUrl: string;
		workspaceUrl: string;
		timeoutMs: number;
	} & SshRemoteProviderOptions,
): Promise<FetchBackendInfo> {
	try {
			return await withSshRemoteWorkspaceTransport(options, async (transport) =>
				await collectWorkspaceBackendInfoFromTransport(
					transport,
					"ssh://agent",
					options.timeoutMs,
				)
			);
	} catch (error) {
		return {
			mode: "workspace",
			status: "unavailable",
			error: `workspace: ${errorMessage(error)}`,
		};
	}
}

async function collectLocalAgentInfo(options: {
	timeoutMs: number;
}): Promise<FetchBackendInfo> {
	const transport = createLocalAgentTransport(options);
	transport.on("error", () => {});
	try {
		transport.start();
		return await collectWorkspaceBackendInfoFromTransport(
			transport,
			"agent://local",
			options.timeoutMs,
		);
	} catch (error) {
		return {
			mode: "workspace",
			status: "unavailable",
			url: "agent://local",
			error: errorMessage(error),
		};
	} finally {
		transport.close();
	}
}

async function collectWorkspaceBackendInfoFromTransport(
	transport: CodexWorkspaceBackendTransport,
	url: string,
	timeoutMs: number,
): Promise<FetchBackendInfo> {
	return await withProbeTimeout(async () => {
		const initialized = await initialize(transport);
		const methods = new Set(initialized.capabilities.workspaceMethods);
		const threads = await collectThreadsViaWorkspace(transport);
		const delegations = methods.has("delegation.list")
			? await optionalProbe(() => collectDelegations(transport))
			: undefined;
		return {
			mode: "workspace",
			status: "connected",
			url,
			server: initialized.serverInfo,
			capabilities: {
				workspaceMethods: initialized.capabilities.workspaceMethods.length,
			},
			threads,
			...(delegations ? { delegations } : {}),
		};
		}, timeoutMs, `agent probe timed out after ${timeoutMs}ms`);
	}

async function collectThreadsViaWorkspace(
	transport: CodexWorkspaceBackendTransport,
): Promise<FetchThreadsInfo> {
	try {
		const response = await transport.request(APP_SERVER_CALL_METHOD, {
			method: "thread/list",
			params: threadListParams(),
		});
		return summarizeThreads(response);
	} catch (error) {
		return {
			total: 0,
			active: 0,
			idle: 0,
			other: 0,
			latest: [],
			error: errorMessage(error),
		};
	}
}

async function collectDelegations(
	transport: CodexWorkspaceBackendTransport,
): Promise<FetchCountInfo> {
	const response = record(await transport.request("delegation.list", {}));
	return summarizeStatusList(arrayValue(response.delegations));
}

function threadListParams(): Record<string, unknown> {
	return {
		limit: 20,
		sortKey: "updated_at",
		sortDirection: "desc",
		archived: false,
		useStateDbOnly: true,
	};
}

function summarizeThreads(value: unknown): FetchThreadsInfo {
	const threads = arrayValue(record(value).data);
	let active = 0;
	let idle = 0;
	let other = 0;
	const latest: FetchThreadSummary[] = [];
	for (const thread of threads) {
		const input = record(thread);
		const status = threadStatusLabel(input.status);
		if (status === "active") {
			active += 1;
		} else if (status === "idle" || status === "notLoaded") {
			idle += 1;
		} else {
			other += 1;
		}
		const id = stringValue(input.id) ?? "unknown";
		latest.push({
			id,
			label: threadLabel(input),
			status,
			...(stringValue(input.cwd) ? { cwd: stringValue(input.cwd) } : {}),
			...(typeof input.updatedAt === "number"
				? { updatedAt: new Date(input.updatedAt * 1000).toISOString() }
				: {}),
		});
	}
	return {
		total: threads.length,
		active,
		idle,
		other,
		latest,
	};
}

function summarizeStatusList(values: unknown[]): FetchCountInfo {
	const counts: FetchCountInfo = {
		total: values.length,
		active: 0,
		idle: 0,
		failed: 0,
		complete: 0,
		reported: 0,
		other: 0,
	};
	for (const value of values) {
		const status = stringValue(record(value).status);
		if (status === "active") {
			counts.active += 1;
		} else if (status === "idle") {
			counts.idle = (counts.idle ?? 0) + 1;
		} else if (status === "failed") {
			counts.failed = (counts.failed ?? 0) + 1;
		} else if (status === "complete") {
			counts.complete = (counts.complete ?? 0) + 1;
		} else if (status === "reported") {
			counts.reported = (counts.reported ?? 0) + 1;
		} else {
			counts.other = (counts.other ?? 0) + 1;
		}
	}
	return counts;
}

async function optionalProbe<T>(callback: () => Promise<T>): Promise<T | undefined> {
	try {
		return await callback();
	} catch {
		return undefined;
	}
}

async function withProbeTimeout<T>(
	callback: () => Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			callback(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

function threadStatusLabel(value: unknown): string {
	const input = record(value);
	return stringValue(input.type) ?? "unknown";
}

function threadLabel(thread: Record<string, unknown>): string {
	const name = stringValue(thread.name);
	if (name) {
		return truncate(name, 36);
	}
	const preview = stringValue(thread.preview);
	if (preview) {
		return truncate(preview.replace(/\s+/g, " "), 36);
	}
	return "untitled";
}

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compactUndefined<T extends Record<string, unknown>>(value: T): T {
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			result[key] = entry;
		}
	}
	return result as T;
}

async function readParams(
	paramsText: string | undefined,
	paramsFile: string | undefined,
): Promise<unknown> {
	if (paramsText !== undefined) {
		return parseJson(paramsText);
	}
	if (paramsFile !== undefined) {
		return await readJsonFile(paramsFile, "JSON params file");
	}
	if (process.stdin.isTTY) {
		return undefined;
	}
	const text = await readStdin();
	return text.trim() ? parseJson(text) : undefined;
}

async function readStdin(): Promise<string> {
	let text = "";
	for await (const chunk of process.stdin) {
		text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
	}
	return text;
}

function parseJson(text: string): unknown {
	return parseJsonParamsText(text, "JSON params");
}

function writeJson(value: unknown, pretty: boolean): void {
	write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function write(text: string): void {
	process.stdout.write(text);
}

function helpText(): string {
	return `codex-flows controls Codex-native local and SSH agent surfaces.

Usage:
  codex-flows fetch [--json] [--no-color]
  codex-flows neofetch [--json] [--no-color]
  codex-flows --ssh <target> --cwd <remote-workspace> fetch
  codex-flows agent serve [--cwd <path>]
  codex-flows mcp serve

  codex-flows --ssh <target> --cwd <remote-workspace> remote preflight [--json]

  codex-flows turn run <prompt> [--wait] [--thread-id <id>]
  codex-flows --ssh <target> --cwd <remote-workspace> turn run <prompt> --wait

  codex-flows automation list [--json]
  codex-flows automation run <name> [--event <event.json>] [--prompt <text>] [--via workspace|app]
  codex-flows --ssh <target> --cwd <remote-workspace> automation list [--json]
  codex-flows --ssh <target> --cwd <remote-workspace> automation run <name> [--event <event.json>]

  codex-flows app <method> [params-json]
  codex-flows app <method> --params-json <json>
  codex-flows app <method> --params-file <file>
  codex-flows app call <method> [params-json]
  echo '<params-json>' | codex-flows app <method>
  codex-flows app actions

  codex-flows functions list [--json]
  codex-flows functions describe <name> [--json]
  codex-flows functions call <name> [--params-json <json>] [--json]
  codex-flows --ssh <target> --cwd <remote-workspace> functions list [--json]

  codex-flows workspace <method> [params-json]
  codex-flows workspace <method> --params-json <json>
  codex-flows workspace <method> --params-file <file>
  codex-flows workspace call <method> [params-json]
  codex-flows workspace app <method> [params-json]
  codex-flows workspace methods
  codex-flows workspace delegate list [--json]
  codex-flows workspace delegate start --cwd @/workspaces/name --prompt <text> [--wait]
  codex-flows workspace doctor [--mode auto|local|actions] [--json]
  codex-flows workspace tick [--mode auto|local|actions]
  codex-flows workspace run <task-id> [--mode auto|local|actions]
  codex-flows workspace init actions [--forgejo|--github]

  codex-flows actions prepare-auth
  codex-flows actions cleanup

  codex-flows memories transplant global-to-workspace [--apply]
  codex-flows memories transplant workspace-to-global [--apply]

  codex-flows threads locate <thread-id> [--codex-home <home>]
  codex-flows threads inspect <thread-id-or-rollout.jsonl> [--codex-home <home>]
  codex-flows threads install-rollout <rollout.jsonl> [--codex-home <home>] [--replace]
  codex-flows threads transplant <thread-id> --from-codex-home <src> --to-codex-home <dst> [--replace]

  codex-flows pack inspect <source> [--json]
  codex-flows pack add <source> [--apply] [--include <name>] [--exclude <name>]
  codex-flows pack doctor [--json]
  codex-flows pack list [--json]

Options:
  --timeout-ms <ms>                          Request timeout. Defaults to 90000,
                                             1500 for fetch probes, or 1800000
                                             for automation run and waited turns.
  --compact                                  Print compact JSON.
  --pretty                                   Print pretty JSON.
  --json                                     Print JSON for supported commands.
  --no-color                                 Disable ANSI colors for fetch.
  --mode <auto|local|actions>                Workspace execution mode.
  --workspace-root <path>                    Workspace root. Defaults to discovery.
  --global-codex-home <path>                 Global Codex home for memories transplant.
  --workspace-codex-home <path>              Workspace Codex home for memories transplant.
  --codex-home <path>                        Codex home for thread transplant.
  --from-codex-home <path>                   Source Codex home for direct thread transplant.
  --to-codex-home <path>                     Target Codex home for direct thread transplant.
  --apply                                    Apply memory transplant changes.
  --overwrite                                Replace destination memory files after backup.
                                             For pack add, replace changed installed item dirs
                                             after backup under .codex/pack-backups.
  --replace                                  Replace an existing thread rollout after backup.
  --ref <ref>                                Git ref for non-local pack sources.
  --include <name>                           Include a pack item by name or kind:name.
  --exclude <name>                           Exclude a pack item by name or kind:name.
  --merge codex                              Merge MEMORY.md and memory_summary.md with Codex.
  --no-backup                                Disable overwrite/merge backups.
  --event <path>                             Event JSON for automation, Actions,
                                             or workspace tasks.
  --forgejo                                  Generate a Forgejo Actions workflow.
  --github                                   Generate a GitHub Actions workflow.
  --prompt <text>                            Prompt text for automation script context.
  --title <text>                             Delegation thread title.
  --group-id <id>                            Delegation group id.
  --return-mode <mode>                       Delegation return mode: detached,
                                             record_only, wake_on_done,
                                             wake_on_group, or manual.
  --allow-absolute-cwd                       Allow workspace delegation to target
                                             an absolute cwd.
  --target-cwd <path>                        Delegation target cwd. Useful with
                                             --ssh, where --cwd selects the
                                             remote workspace root.
  --via <workspace|app>                      Turn surface. Defaults to workspace.
  --sandbox <mode>                           Turn sandbox: danger-full-access,
                                             workspace-write, or read-only.
  --approval-policy <policy>                 Turn approval policy: never,
                                             on-failure, on-request, or untrusted.
  --permissions <profile>                    Turn permissions profile.
  --ssh, --ssh-target <target>               SSH target for remote CodexFlows operation
                                             Defaults to CODEX_FLOWS_REMOTE_SSH_TARGET.
  --remote-path-prepend <paths>              Colon-separated remote PATH entries for
                                             non-interactive SSH commands.
  --agent-command <command>                  codex-flows command/path for spawned agents.
                                             Defaults to CODEX_FLOWS_AGENT_COMMAND
                                             or codex-flows.
  --codex-command <command>                  Codex command used by the agent.
                                             Defaults to CODEX_FLOWS_REMOTE_CODEX_COMMAND or codex.
  --codex-arg <arg>                          Extra Codex argument. Repeatable.
  --cwd <path>                               Remote workspace cwd for SSH operation.
                                             For local workspace delegate, also
                                             accepts @/path relative to the
                                             workspace root.
  -h, --help                                 Show this help.

Examples:
  codex-flows fetch
  codex-flows mcp serve
  codex-flows agent serve --cwd /repo
  codex-flows --ssh devbox --cwd /repo fetch
  codex-flows --ssh devbox --cwd /repo turn run "Scan current folder" --wait
  codex-flows automation list
  codex-flows automation run check-release --event event.json
  codex-flows --ssh devbox --cwd /repo automation list --json
  codex-flows --ssh devbox --cwd /repo automation run check-release --event event.json
  codex-flows --ssh devbox --cwd /repo functions list --json
  codex-flows --ssh devbox --cwd /repo functions call portfolioSnapshot --json
  codex-flows --ssh devbox --cwd /repo app thread/list '{"limit":20,"sourceKinds":[]}'
  codex-flows --ssh devbox --cwd /repo workspace delegation.list
  codex-flows app thread/list '{"limit":20,"sourceKinds":[]}'
  codex-flows workspace app thread/list '{"limit":20,"sourceKinds":[]}'
  codex-flows workspace delegation.list
  codex-flows workspace delegate start --cwd @/workspaces/trading --prompt "Inspect status"
  codex-flows workspace doctor --mode actions
  codex-flows workspace init actions --forgejo
  codex-flows memories transplant global-to-workspace
  codex-flows threads inspect 019e3654-1492-70d0-9b01-46b17d6444a9 --codex-home ./.codex
  codex-flows threads install-rollout ./rollout-2026-05-18T15-12-25-019e3ba5-3c2a-74c1-bece-53a8ece3dc0e.jsonl --codex-home ./.codex
  codex-flows threads transplant 019e3654-1492-70d0-9b01-46b17d6444a9 --from-codex-home ~/.codex --to-codex-home ./.codex
  codex-flows pack inspect owner/repo
  codex-flows pack add ./capability-pack --apply
`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
