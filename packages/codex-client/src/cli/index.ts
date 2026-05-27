#!/usr/bin/env node
import {
	CodexAppServerClient,
	CodexWebSocketTransport,
} from "../index.ts";
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
	DEFAULT_APP_SERVER_WS_URL,
	DEFAULT_WORKSPACE_BACKEND_WS_URL,
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
	collectRemoteStatusInfo,
	formatRemoteStatusInfo,
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
	createSshRemoteAgentTransport,
	hasSshRemote,
	withSshRemoteWorkspaceTransport,
	type SshRemoteProviderOptions,
} from "./remote-provider.ts";
import { serveRemoteAgent } from "./remote-agent.ts";
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
	collectWorkspaceBackendSetupInfo,
	formatWorkspaceBackendInitLocalResult,
	formatWorkspaceBackendProfileInitResult,
	formatWorkspaceBackendServiceInstallResult,
	formatWorkspaceBackendSetupInfo,
	formatWorkspaceBackendStartResult,
	initGlobalLocalWorkspaceBackend,
	initLocalWorkspaceBackend,
	installWorkspaceBackendService,
	readWorkspaceBackendProfile,
	startLocalWorkspaceBackend,
} from "./workspace-backend-setup.ts";
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
	if (parsed.type === "remote-status") {
		const info = await collectRemoteStatusInfo({
			appUrl: parsed.appUrl,
			workspaceUrl: parsed.workspaceUrl,
			timeoutMs: parsed.timeoutMs,
		});
		write(parsed.json
			? `${JSON.stringify(info, null, parsed.pretty ? 2 : 0)}\n`
			: formatRemoteStatusInfo(info));
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
	if (parsed.type === "remote-agent-serve") {
		await serveRemoteAgent({
			cwd: parsed.cwd,
			timeoutMs: parsed.timeoutMs,
			remoteCodexCommand: parsed.remoteCodexCommand,
			remoteCodexArgs: parsed.remoteCodexArgs,
		});
		return;
	}
	if (parsed.type === "remote-turn-start") {
		const result = await startRemoteTurn({
			prompt: parsed.prompt,
			threadId: parsed.threadId,
			cwd: parsed.cwd,
			via: parsed.via,
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
			remoteAgentCommand: parsed.remoteAgentCommand,
			remoteCodexCommand: parsed.remoteCodexCommand,
			remoteCodexArgs: parsed.remoteCodexArgs,
		});
		write(parsed.json
			? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
			: formatRemoteTurnStartResult(result));
		if (parsed.wait && (result.status === "failed" || result.status === "timed_out")) {
			process.exitCode = 1;
		}
		return;
	}
	if (parsed.type === "automation-run") {
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
			sshTarget: parsed.sshTarget,
			remotePathPrepend: parsed.remotePathPrepend,
			remoteAgentCommand: parsed.remoteAgentCommand,
			remoteCodexCommand: parsed.remoteCodexCommand,
			remoteCodexArgs: parsed.remoteCodexArgs,
			});
		write(parsed.json
			? `${JSON.stringify(run, null, parsed.pretty ? 2 : 0)}\n`
			: formatTurnAutomationRun(run));
		return;
	}
	if (parsed.type === "automation-list") {
		const automations = await listTurnAutomations({ cwd: parsed.workspaceRoot });
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
			remoteAgentCommand: parsed.remoteAgentCommand,
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
	if (parsed.type === "workspace-doctor") {
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot,
			mode: parsed.mode,
		});
		const info = await collectWorkspaceDoctorInfo(context);
		const backendSetup = await collectWorkspaceBackendSetupInfo(context);
			const backend = await collectBackendInfo({
				appUrl: parsed.appUrl,
				workspaceUrl: backendSetup.workspaceBackendUrl,
				timeoutMs: parsed.timeoutMs,
				sshTarget: parsed.sshTarget,
				cwd: parsed.cwd,
				remotePathPrepend: parsed.remotePathPrepend,
				remoteAgentCommand: parsed.remoteAgentCommand,
				remoteCodexCommand: parsed.remoteCodexCommand,
				remoteCodexArgs: parsed.remoteCodexArgs,
			});
		const result = { ...info, backend, backendSetup };
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: `${formatWorkspaceDoctorInfo(info)}${formatWorkspaceBackendSetupInfo(backendSetup, {
				backendLabel: backendLabelForDoctor(backend),
				nextCommand: nextBackendCommand(backendSetup.nextCommand, backend),
			})}`);
		return;
	}
	if (parsed.type === "workspace-backend-init-local") {
		if (parsed.globalProfile || parsed.profile) {
			const result = await initGlobalLocalWorkspaceBackend({
				profile: parsed.profile,
				workspaceRoot: parsed.workspaceRoot,
				codexHome: parsed.codexHome,
				overwrite: parsed.overwrite,
			});
			write(parsed.json
				? `${JSON.stringify(result, null, 2)}\n`
				: formatWorkspaceBackendProfileInitResult(result));
			return;
		}
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot,
			mode: "local",
			env: parsed.codexHome
				? { ...process.env, CODEX_HOME: parsed.codexHome }
				: process.env,
		});
		const result = await initLocalWorkspaceBackend(context, {
			overwrite: parsed.overwrite,
		});
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: formatWorkspaceBackendInitLocalResult(result));
		return;
	}
	if (parsed.type === "workspace-backend-status") {
		const profile = parsed.profile
			? await readWorkspaceBackendProfile(parsed.profile)
			: undefined;
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot ?? profile?.workspaceRoot,
			mode: "local",
			env: profile ? { ...process.env, CODEX_HOME: profile.codexHome } : process.env,
		});
		const setup = await collectWorkspaceBackendSetupInfo(context, process.env, {
			profile: profile?.name,
		});
			const backend = await collectBackendInfo({
				appUrl: parsed.appUrl,
				workspaceUrl: setup.workspaceBackendUrl,
				timeoutMs: parsed.timeoutMs,
				sshTarget: parsed.sshTarget,
				cwd: parsed.cwd,
				remotePathPrepend: parsed.remotePathPrepend,
				remoteAgentCommand: parsed.remoteAgentCommand,
				remoteCodexCommand: parsed.remoteCodexCommand,
				remoteCodexArgs: parsed.remoteCodexArgs,
			});
		const result = { setup, backend };
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: formatWorkspaceBackendSetupInfo(setup, {
				backendLabel: backendLabelForDoctor(backend),
				nextCommand: nextBackendCommand(setup.nextCommand, backend),
			}));
		return;
	}
	if (parsed.type === "workspace-backend-start") {
		const profile = parsed.profile
			? await readWorkspaceBackendProfile(parsed.profile)
			: undefined;
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot ?? profile?.workspaceRoot,
			mode: "local",
			env: profile ? { ...process.env, CODEX_HOME: profile.codexHome } : process.env,
		});
		const result = await startLocalWorkspaceBackend(context, {
			dryRun: parsed.dryRun,
			profile: profile?.name,
		});
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: formatWorkspaceBackendStartResult(result));
		return;
	}
	if (parsed.type === "workspace-backend-service-install") {
		const result = await installWorkspaceBackendService({
			profile: parsed.profile,
			dryRun: parsed.dryRun,
			overwrite: parsed.overwrite,
		});
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: formatWorkspaceBackendServiceInstallResult(result));
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

function nextBackendCommand(current: string, backend: FetchBackendInfo): string {
	if (backend.status === "connected") {
		return "codex-flows workspace tick --mode local";
	}
	return current;
}

async function callAppServer(
	method: string,
	params: unknown,
	options: { url: string; timeoutMs: number } & SshRemoteProviderOptions,
): Promise<unknown> {
	if (hasSshRemote(options)) {
		return await withSshRemoteWorkspaceTransport(options, async (transport) => {
			await initialize(transport);
			return await transport.request(APP_SERVER_CALL_METHOD, { method, params });
		});
	}
	const client = new CodexAppServerClient({
		...(options.url === "stdio://"
			? { transportOptions: { requestTimeoutMs: options.timeoutMs } }
			: {
					webSocketTransportOptions: {
						url: options.url,
						requestTimeoutMs: options.timeoutMs,
					},
				}),
		clientName: "codex-flows-cli",
		clientTitle: "Codex Flows CLI",
		clientVersion: "0.1.0",
	});
	client.on("request", (message) => {
		client.respondError(
			message.id,
			-32603,
			"codex-flows CLI does not handle app-server requests",
		);
	});
	try {
		await client.connect();
		return await client.request(method, params);
	} finally {
		client.close();
	}
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
	} & SshRemoteProviderOptions,
): Promise<TurnAutomationRun> {
	const host = createCliTurnAutomationHost({
		...options,
		defaults: {
			prompt: options.prompt,
			cwd: options.cwd,
			skills: target.skills,
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
	if (hasSshRemote(options)) {
		const requester = createLazyWorkspaceRequester({
			...options,
			url: DEFAULT_WORKSPACE_BACKEND_WS_URL,
		});
		return {
			request: requester.appRequest,
			close: requester.close,
		};
	}
	let client: CodexAppServerClient | undefined;
	const getClient = async (): Promise<CodexAppServerClient> => {
		if (client) {
			return client;
		}
		client = new CodexAppServerClient({
					...(options.url === "stdio://"
						? { transportOptions: { requestTimeoutMs: options.timeoutMs } }
						: {
								webSocketTransportOptions: {
									url: options.url,
									requestTimeoutMs: options.timeoutMs,
								},
							}),
					clientName: "codex-flows-automation",
					clientTitle: "Codex Flows Automation",
					clientVersion: "0.1.0",
				});
		client.on("request", (message) => {
			client?.respondError(
				message.id,
				-32603,
				"codex-flows automation does not handle app-server requests",
			);
		});
		try {
			await client.connect();
			return client;
		} catch (error) {
			client.close();
			client = undefined;
			throw error;
		}
	};
	return {
		request: async (method, params) => await (await getClient()).request(method, params),
		close: () => {
			client?.close();
			client = undefined;
		},
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
			transport = createSshRemoteAgentTransport(options);
		} else {
			transport = new CodexWebSocketTransport({
				url: options.url,
				requestTimeoutMs: options.timeoutMs,
			});
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
	return await withWorkspaceWebSocket(options, callback);
}

async function withWorkspaceWebSocket<T>(
	options: { url: string; timeoutMs: number },
	callback: (transport: CodexWorkspaceBackendTransport) => Promise<T>,
): Promise<T> {
	const transport = new CodexWebSocketTransport({
		url: options.url,
		requestTimeoutMs: options.timeoutMs,
	});
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
	const workspace = await tryCollectWorkspaceBackendInfo(options);
	if (workspace.status === "connected") {
		return workspace;
	}
	const appServer = await tryCollectAppServerInfo(options);
	if (appServer.status === "connected") {
		return {
			...appServer,
			error: workspace.error
				? `Workspace probe failed: ${workspace.error}`
				: undefined,
		};
	}
	return {
		mode: "local",
		status: "unavailable",
		error: [
			workspace.error ? `workspace: ${workspace.error}` : undefined,
			appServer.error ? `app-server: ${appServer.error}` : undefined,
		].filter(Boolean).join("; ") || "No backend responded",
	};
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
				"ssh://remote-agent",
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

async function tryCollectWorkspaceBackendInfo(options: {
	workspaceUrl: string;
	timeoutMs: number;
}): Promise<FetchBackendInfo> {
	const transport = new CodexWebSocketTransport({
		url: options.workspaceUrl,
		requestTimeoutMs: options.timeoutMs,
	});
	transport.on("error", () => {});
	try {
		return await collectWorkspaceBackendInfoFromTransport(
			transport,
			options.workspaceUrl,
			options.timeoutMs,
		);
	} catch (error) {
		return {
			mode: "workspace",
			status: "unavailable",
			url: options.workspaceUrl,
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
	}, timeoutMs, `workspace backend probe timed out after ${timeoutMs}ms`);
}

async function tryCollectAppServerInfo(options: {
	appUrl: string;
	timeoutMs: number;
}): Promise<FetchBackendInfo> {
	if (options.appUrl !== "stdio://") {
		return await tryCollectAppServerWebSocketInfo(options);
	}
	const client = new CodexAppServerClient({
		transportOptions: { requestTimeoutMs: options.timeoutMs },
		clientName: "codex-flows-fetch",
		clientTitle: "Codex Flows Fetch",
		clientVersion: "0.1.0",
	});
	client.on("request", (message) => {
		client.respondError(
			message.id,
			-32603,
			"codex-flows fetch does not handle app-server requests",
		);
	});
	client.on("error", () => {});
	try {
		return await withProbeTimeout(async () => {
			await client.connect();
			return {
				mode: "app-server",
				status: "connected",
				url: options.appUrl,
				threads: await collectThreadsViaAppServer(client),
			};
		}, options.timeoutMs, `app-server probe timed out after ${options.timeoutMs}ms`);
	} catch (error) {
		return {
			mode: "app-server",
			status: "unavailable",
			url: options.appUrl,
			error: errorMessage(error),
		};
	} finally {
		client.close();
	}
}

async function tryCollectAppServerWebSocketInfo(options: {
	appUrl: string;
	timeoutMs: number;
}): Promise<FetchBackendInfo> {
	const transport = new CodexWebSocketTransport({
		url: options.appUrl,
		requestTimeoutMs: options.timeoutMs,
	});
	transport.on("error", () => {});
	try {
		return await withProbeTimeout(async () => {
			await initializeAppServerTransport(transport);
			return {
				mode: "app-server",
				status: "connected",
				url: options.appUrl,
				threads: await collectThreadsViaAppServer(transport),
			};
		}, options.timeoutMs, `app-server probe timed out after ${options.timeoutMs}ms`);
	} catch (error) {
		return {
			mode: "app-server",
			status: "unavailable",
			url: options.appUrl,
			error: errorMessage(error),
		};
	} finally {
		transport.close();
	}
}

async function initializeAppServerTransport(
	transport: CodexWebSocketTransport,
): Promise<void> {
	await transport.request("initialize", {
		clientInfo: {
			name: "codex-flows-fetch",
			title: "Codex Flows Fetch",
			version: "0.1.0",
		},
		capabilities: {
			experimentalApi: true,
		},
	});
	transport.notify("initialized");
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

async function collectThreadsViaAppServer(
	client: { request<T = unknown>(method: string, params?: unknown): Promise<T> },
): Promise<FetchThreadsInfo> {
	try {
		return summarizeThreads(await client.request("thread/list", threadListParams()));
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
	return `codex-flows controls Codex app-server and workspace backend surfaces.

Usage:
  codex-flows fetch [--json] [--no-color]
  codex-flows neofetch [--json] [--no-color]
  codex-flows --ssh <target> --cwd <remote-workspace> fetch

	  codex-flows remote status [--json]
	  codex-flows --ssh <target> --cwd <remote-workspace> remote preflight [--json]
	  codex-flows remote turn start --prompt <text> [--via workspace|app] [--cwd <path>] [--wait]
	  codex-flows --ssh <target> --cwd <remote-workspace> remote turn start --prompt <text> [--wait]
	  codex-flows remote-agent serve [--cwd <path>]

	  codex-flows turn run <prompt> [--wait] [--thread-id <id>]
	  codex-flows --ssh <target> --cwd <remote-workspace> turn run <prompt> --wait

	  codex-flows automation list [--json]
	  codex-flows automation run <name> [--event <event.json>] [--prompt <text>] [--via workspace|app]

	  codex-flows app <method> [params-json]
	  codex-flows app <method> --params-json <json>
	  codex-flows app <method> --params-file <file>
	  codex-flows app call <method> [params-json]
	  echo '<params-json>' | codex-flows app <method>
	  codex-flows app actions

	  codex-flows workspace <method> [params-json]
	  codex-flows workspace <method> --params-json <json>
	  codex-flows workspace <method> --params-file <file>
	  codex-flows workspace call <method> [params-json]
	  codex-flows workspace app <method> [params-json]
  codex-flows workspace methods
  codex-flows workspace doctor [--mode auto|local|actions] [--json]
  codex-flows workspace backend init local [--overwrite] [--json]
  codex-flows workspace backend init local --global [--profile <name>] [--workspace-root <path>] [--codex-home <home>]
  codex-flows workspace backend status [--profile <name>] [--json]
  codex-flows workspace backend start [--profile <name>] [--dry-run] [--json]
  codex-flows workspace backend service install [--profile <name>] [--dry-run]
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
  --app-url, --app-server-url <url>          App-server WebSocket URL.
                                             Defaults to CODEX_WORKSPACE_APP_SERVER_WS_URL
                                             or ${DEFAULT_APP_SERVER_WS_URL}.
                                             Use stdio:// to spawn a local app-server.
  --workspace-url, --workspace-backend-url <url>
                                             Workspace backend WebSocket URL.
                                             Defaults to CODEX_WORKSPACE_BACKEND_WS_URL
                                             or ${DEFAULT_WORKSPACE_BACKEND_WS_URL}.
  --url, --ws-url <url>                      Set both app and workspace URLs.
  --timeout-ms <ms>                          Request timeout. Defaults to 90000,
                                             or 1500 for fetch probes.
  --compact                                  Print compact JSON.
  --pretty                                   Print pretty JSON.
  --json                                     Print JSON for supported commands.
  --no-color                                 Disable ANSI colors for fetch.
  --mode <auto|local|actions>                Workspace execution mode.
  --workspace-root <path>                    Workspace root. Defaults to discovery.
  --profile, --name <name>                   Workspace backend profile name.
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
  --global                                   For backend init local, write a user profile
                                             under XDG_CONFIG_HOME instead of this repo.
  --dry-run                                  Print the local backend start command.
  --prompt <text>                            Prompt text for remote turn start or
                                             automation script context.
  --via <workspace|app>                      Turn surface. Defaults to workspace.
  --sandbox <mode>                           Remote turn sandbox: danger-full-access,
                                             workspace-write, or read-only.
  --approval-policy <policy>                 Remote turn approval policy: never,
                                             on-failure, on-request, or untrusted.
  --permissions <profile>                    Remote turn permissions profile.
  --ssh, --ssh-target <target>               SSH target for remote CodexFlows operation
                                             Defaults to CODEX_FLOWS_REMOTE_SSH_TARGET.
  --remote-path-prepend <paths>              Colon-separated remote PATH entries for
                                             non-interactive SSH commands.
  --remote-agent-command <command>           Remote codex-flows command. Defaults to
                                             CODEX_FLOWS_REMOTE_AGENT_COMMAND or codex-flows.
  --remote-codex-command <command>           Remote Codex command used by the agent.
                                             Defaults to CODEX_FLOWS_REMOTE_CODEX_COMMAND or codex.
  --remote-codex-arg <arg>                   Extra remote Codex argument. Repeatable.
  --cwd <path>                               Remote workspace cwd for SSH operation.
  -h, --help                                 Show this help.

Examples:
  codex-flows fetch
  codex-flows --ssh devbox --cwd /repo fetch
  codex-flows fetch --workspace-url ws://127.0.0.1:3586
  codex-flows remote status --workspace-url ws://127.0.0.1:3586
  codex-flows remote turn start --prompt "Check workspace status"
  codex-flows --ssh devbox --cwd /repo remote turn start --sandbox danger-full-access --approval-policy never --prompt "Scan current folder"
  codex-flows --ssh devbox --cwd /repo turn run "Scan current folder" --wait
  codex-flows automation list
  codex-flows automation run check-release --event event.json
  codex-flows --ssh devbox --cwd /repo automation run check-release --event event.json
  codex-flows --ssh devbox --cwd /repo app thread/list '{"limit":20,"sourceKinds":[]}'
  codex-flows --ssh devbox --cwd /repo workspace delegation.list
  codex-flows app thread/list '{"limit":20,"sourceKinds":[]}'
  codex-flows workspace app thread/list '{"limit":20,"sourceKinds":[]}'
  codex-flows workspace delegation.list
  codex-flows workspace doctor --mode actions
  codex-flows workspace backend init local --global --profile home
  codex-flows workspace backend service install --profile home --dry-run
  codex-flows workspace backend start --profile home --dry-run
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
