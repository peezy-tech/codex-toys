#!/usr/bin/env node
import { readFile } from "node:fs/promises";
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
	assertActionsFlowRun,
	cleanupActionsCodexHome,
	dispatchActionsFlowEvent,
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
	type FetchFlowInfo,
	type FetchFlowRunCounts,
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
	formatRemoteTunnelPlan,
	formatRemoteTurnStartResult,
	startRemoteTunnel,
	startRemoteTurn,
} from "./remote-control.ts";
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
	migrateWorkspaceConfig,
	runWorkspaceTaskById,
	scaffoldActionsWorkspace,
	tickWorkspace,
} from "./workspace-autonomy.ts";
import {
	collectWorkspaceBackendSetupInfo,
	formatWorkspaceBackendInitLocalResult,
	formatWorkspaceBackendSetupInfo,
	formatWorkspaceBackendStartResult,
	initLocalWorkspaceBackend,
	startLocalWorkspaceBackend,
} from "./workspace-backend-setup.ts";

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
	if (parsed.type === "remote-turn-start") {
		const result = await startRemoteTurn({
			prompt: parsed.prompt,
			cwd: parsed.cwd,
			via: parsed.via,
			appUrl: parsed.appUrl,
			workspaceUrl: parsed.workspaceUrl,
			timeoutMs: parsed.timeoutMs,
		});
		write(parsed.json
			? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
			: formatRemoteTurnStartResult(result));
		return;
	}
	if (parsed.type === "remote-tunnel-start") {
		const result = await startRemoteTunnel({
			sshTarget: parsed.sshTarget,
			localPort: parsed.localPort,
			remoteHost: parsed.remoteHost,
			remotePort: parsed.remotePort,
			dryRun: parsed.dryRun,
		});
		write(parsed.json
			? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
			: formatRemoteTunnelPlan(result));
		return;
	}
	if (parsed.type === "app-actions") {
		write(`${COMMON_APP_SERVER_ACTIONS.join("\n")}\n`);
		return;
	}
	if (parsed.type === "app-call") {
		writeJson(
			await callAppServer(parsed.method, await readParams(parsed.paramsText), {
				url: parsed.url,
				timeoutMs: parsed.timeoutMs,
			}),
			parsed.pretty,
		);
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
		const migrated = await maybeMigrateWorkspaceConfig(context);
		const info = await collectWorkspaceDoctorInfo(context);
		const backendSetup = await collectWorkspaceBackendSetupInfo(context);
		const backend = await collectBackendInfo({
			appUrl: parsed.appUrl,
			workspaceUrl: backendSetup.workspaceBackendUrl,
			timeoutMs: parsed.timeoutMs,
		});
		const result = { ...info, migratedConfig: migrated, backend, backendSetup };
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: `${formatWorkspaceDoctorInfo(info)}${formatWorkspaceBackendSetupInfo(backendSetup, {
				backendLabel: backendLabelForDoctor(backend),
				nextCommand: nextBackendCommand(backendSetup.nextCommand, backend),
			})}${migrated ? "config migration   migrated legacy discord.gateway.surfaces\n" : ""}`);
		return;
	}
	if (parsed.type === "workspace-backend-init-local") {
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot,
			mode: "local",
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
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot,
			mode: "local",
		});
		const setup = await collectWorkspaceBackendSetupInfo(context);
		const backend = await collectBackendInfo({
			appUrl: parsed.appUrl,
			workspaceUrl: setup.workspaceBackendUrl,
			timeoutMs: parsed.timeoutMs,
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
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot,
			mode: "local",
		});
		const result = await startLocalWorkspaceBackend(context, {
			dryRun: parsed.dryRun,
		});
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: formatWorkspaceBackendStartResult(result));
		return;
	}
	if (parsed.type === "workspace-tick") {
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot,
			mode: parsed.mode,
		});
		await maybeMigrateWorkspaceConfig(context);
		const result = await tickWorkspace(context, {
			callWorkspaceBackend: async (method, params) =>
				await callWorkspaceBackend(method, params, parsed),
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
		await maybeMigrateWorkspaceConfig(context);
		const run = await runWorkspaceTaskById(context, parsed.taskId, {
			callWorkspaceBackend: async (method, params) =>
				await callWorkspaceBackend(method, params, parsed),
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
			withSmoke: parsed.withSmoke,
			withAgentTurn: parsed.withAgentTurn,
			overwrite: parsed.overwrite,
		}), parsed.pretty);
		return;
	}
	if (parsed.type === "workspace-call") {
		writeJson(
			await callWorkspaceBackend(
				parsed.method,
				await readParams(parsed.paramsText),
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
					params: await readParams(parsed.paramsText),
				},
				parsed,
			),
			parsed.pretty,
		);
		return;
	}
	if (parsed.type === "flow-dispatch") {
		const event = JSON.parse(await readFile(parsed.eventPath, "utf8")) as unknown;
		writeJson(await callWorkspaceBackend("flow.dispatch", { event }, parsed), parsed.pretty);
		return;
	}
	if (parsed.type === "flow-list-events") {
		writeJson(
			await callWorkspaceBackend(
				"flow.listEvents",
				{ type: parsed.eventType, limit: parsed.limit },
				parsed,
			),
			parsed.pretty,
		);
		return;
	}
	if (parsed.type === "flow-get-event") {
		writeJson(
			await callWorkspaceBackend("flow.getEvent", { eventId: parsed.eventId }, parsed),
			parsed.pretty,
		);
		return;
	}
	if (parsed.type === "flow-replay") {
		writeJson(
			await callWorkspaceBackend(
				"flow.replay",
				{ eventId: parsed.eventId, wait: parsed.wait },
				parsed,
			),
			parsed.pretty,
		);
		return;
	}
	if (parsed.type === "flow-list-runs") {
		writeJson(
			await callWorkspaceBackend(
				"flow.listRuns",
				{
					eventId: parsed.eventId,
					status: parsed.status,
					limit: parsed.limit,
				},
				parsed,
			),
			parsed.pretty,
		);
		return;
	}
	if (parsed.type === "flow-get-run") {
		writeJson(
			await callWorkspaceBackend("flow.getRun", { runId: parsed.runId }, parsed),
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
	if (parsed.type === "actions-dispatch") {
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot,
			mode: "actions",
		});
		const event = JSON.parse(await readFile(parsed.eventPath, "utf8")) as unknown;
		writeJson(await dispatchActionsFlowEvent({
			workspaceRoot: context.repoRoot,
			event,
			env: process.env,
		}), parsed.pretty);
		return;
	}
	if (parsed.type === "actions-assert-run") {
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot,
			mode: "actions",
		});
		writeJson(await assertActionsFlowRun({
			workspaceRoot: context.repoRoot,
			flowName: parsed.flowName,
			stepName: parsed.stepName,
			requireCompleted: true,
			artifactText: parsed.artifactText,
			env: process.env,
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

async function maybeMigrateWorkspaceConfig(
	context: Awaited<ReturnType<typeof createWorkspaceContext>>,
): Promise<boolean> {
	try {
		return await migrateWorkspaceConfig(context);
	} catch {
		return false;
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
	options: { url: string; timeoutMs: number },
): Promise<unknown> {
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

async function initializeWorkspaceBackend(options: {
	url: string;
	timeoutMs: number;
}): Promise<WorkspaceBackendInitializeResponse> {
	return await withWorkspaceTransport(options, async (transport) =>
		await initialize(transport)
	);
}

async function callWorkspaceBackend(
	method: string,
	params: unknown,
	options: { url: string; timeoutMs: number },
): Promise<unknown> {
	return await withWorkspaceTransport(options, async (transport) => {
		await initialize(transport);
		return await transport.request(method, params);
	});
}

async function withWorkspaceTransport<T>(
	options: { url: string; timeoutMs: number },
	callback: (transport: CodexWebSocketTransport) => Promise<T>,
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
	transport: CodexWebSocketTransport,
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
}): Promise<FetchBackendInfo> {
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
		return await withProbeTimeout(async () => {
			const initialized = await initialize(transport);
			const methods = new Set(initialized.capabilities.workspaceMethods);
			const threads = await collectThreadsViaWorkspace(transport);
			const delegations = methods.has("delegation.list")
				? await optionalProbe(() => collectDelegations(transport))
				: undefined;
			const flow = methods.has("flow.listRuns") || methods.has("flow.listEvents")
				? await optionalProbe(() => collectFlow(transport, methods))
				: undefined;
			return {
				mode: "workspace",
				status: "connected",
				url: options.workspaceUrl,
				server: initialized.serverInfo,
				capabilities: {
					workspaceMethods: initialized.capabilities.workspaceMethods.length,
					flowInspection: initialized.capabilities.flowInspection,
				},
				threads,
				...(delegations ? { delegations } : {}),
				...(flow ? { flow } : {}),
			};
		}, options.timeoutMs, `workspace backend probe timed out after ${options.timeoutMs}ms`);
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
	transport: CodexWebSocketTransport,
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
	transport: CodexWebSocketTransport,
): Promise<FetchCountInfo> {
	const response = record(await transport.request("delegation.list", {}));
	return summarizeStatusList(arrayValue(response.delegations));
}

async function collectFlow(
	transport: CodexWebSocketTransport,
	methods: Set<string>,
): Promise<FetchFlowInfo> {
	const runs = methods.has("flow.listRuns")
		? await optionalProbe(async () =>
			summarizeFlowRuns(arrayValue(await transport.request("flow.listRuns", { limit: 25 })))
		)
		: emptyFlowRunCounts();
	const events = methods.has("flow.listEvents")
		? await optionalProbe(async () =>
			arrayValue(await transport.request("flow.listEvents", { limit: 25 })).length
		)
		: 0;
	return {
		runs: runs ?? emptyFlowRunCounts(),
		eventsListed: events ?? 0,
	};
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

function summarizeFlowRuns(values: unknown[]): FetchFlowRunCounts {
	const counts = emptyFlowRunCounts();
	counts.total = values.length;
	for (const value of values) {
		const status = stringValue(record(value).status);
		if (status === "queued") {
			counts.queued += 1;
		} else if (status === "running") {
			counts.running += 1;
		} else if (status === "completed") {
			counts.completed += 1;
		} else if (status === "failed") {
			counts.failed += 1;
		} else {
			counts.other += 1;
		}
	}
	return counts;
}

function emptyFlowRunCounts(): FetchFlowRunCounts {
	return {
		total: 0,
		queued: 0,
		running: 0,
		completed: 0,
		failed: 0,
		other: 0,
	};
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

async function readParams(paramsText: string | undefined): Promise<unknown> {
	if (paramsText !== undefined) {
		return parseJson(paramsText);
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
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`Failed to parse JSON params: ${errorMessage(error)}`);
	}
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

  codex-flows remote status [--json]
  codex-flows remote tunnel start --ssh <user@tailscale-host> [--dry-run]
  codex-flows remote turn start --prompt <text> [--via auto|workspace|app] [--cwd <path>]

  codex-flows app <method> [params-json]
  codex-flows app call <method> [params-json]
  echo '<params-json>' | codex-flows app <method>
  codex-flows app actions

  codex-flows workspace <method> [params-json]
  codex-flows workspace call <method> [params-json]
  codex-flows workspace app <method> [params-json]
  codex-flows workspace methods
  codex-flows workspace doctor [--mode auto|local|actions] [--json]
  codex-flows workspace backend init local [--overwrite] [--json]
  codex-flows workspace backend status [--json]
  codex-flows workspace backend start [--dry-run] [--json]
  codex-flows workspace tick [--mode auto|local|actions]
  codex-flows workspace run <task-id> [--mode auto|local|actions]
  codex-flows workspace init actions [--forgejo|--github] [--with-smoke] [--with-agent-turn]

  codex-flows actions prepare-auth
  codex-flows actions cleanup
  codex-flows actions dispatch --event <event.json>
  codex-flows actions assert-run --flow <name> --step <name> [--artifact-text <text>]

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

  codex-flows flow dispatch --event <event.json>
  codex-flows flow events [--type <type>] [--limit <n>]
  codex-flows flow event <event-id>
  codex-flows flow replay <event-id> [--wait]
  codex-flows flow runs [--event-id <id>] [--status <status>] [--limit <n>]
  codex-flows flow run <run-id>

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
  --flow <name>                              Flow name for Actions run assertions.
  --step <name>                              Step name for Actions run assertions.
  --artifact-text <text>                     Require text in an Actions run record.
  --forgejo                                  Generate a Forgejo Actions workflow.
  --github                                   Generate a GitHub Actions workflow.
  --with-smoke                               Generate an Actions smoke flow.
  --with-agent-turn                          Generate an agent-turn flow.
  --dry-run                                  Print the local backend start command.
                                             For remote tunnel start, print the ssh command.
  --prompt <text>                            Prompt text for remote turn start.
  --via <auto|workspace|app>                 Remote turn surface. Defaults to auto.
  --ssh, --ssh-target <target>               SSH target for a Tailscale-backed tunnel.
                                             Defaults to CODEX_FLOWS_REMOTE_SSH_TARGET.
  --local-port <port>                        Local tunnel port. Defaults to 3586.
  --remote-host <host>                       Remote backend host. Defaults to 127.0.0.1.
  --remote-port <port>                       Remote backend port. Defaults to 3586.
  --cwd <path>                               Working directory for remote turn start.
  -h, --help                                 Show this help.

Examples:
  codex-flows fetch
  codex-flows fetch --workspace-url ws://127.0.0.1:3586
  codex-flows remote status --workspace-url ws://127.0.0.1:3586
  codex-flows remote tunnel start --ssh peezy@vps-tailnet --dry-run
  codex-flows remote turn start --prompt "Check workspace status"
  codex-flows app thread/list '{"limit":20,"sourceKinds":[]}'
  codex-flows workspace app thread/list '{"limit":20,"sourceKinds":[]}'
  codex-flows workspace delegation.list
  codex-flows workspace doctor --mode actions
  codex-flows workspace backend init local
  codex-flows workspace backend start --dry-run
  codex-flows workspace init actions --forgejo --with-smoke --with-agent-turn
  codex-flows actions dispatch --event .codex/workspace/actions/events/manual.json
  codex-flows memories transplant global-to-workspace
  codex-flows threads inspect 019e3654-1492-70d0-9b01-46b17d6444a9 --codex-home ./.codex
  codex-flows threads install-rollout ./rollout-2026-05-18T15-12-25-019e3ba5-3c2a-74c1-bece-53a8ece3dc0e.jsonl --codex-home ./.codex
  codex-flows threads transplant 019e3654-1492-70d0-9b01-46b17d6444a9 --from-codex-home ~/.codex --to-codex-home ./.codex
  codex-flows pack inspect owner/repo
  codex-flows pack add ./capability-pack --apply
  codex-flows flow events --limit 20
`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
