#!/usr/bin/env node
import {
	APP_CALL_METHOD,
	TOYBOX_INITIALIZE_METHOD,
	type ToyboxInitializeResponse,
} from "../toybox/index.ts";
import {
	COMMON_APP_SERVER_ACTIONS,
	COMMON_TOYBOX_METHODS,
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
	type FetchToyboxInfo,
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
	createLocalToyboxTransport,
	createSshToyboxTransport,
	hasSshRemote,
	withSshRemoteToyboxTransport,
	type SshRemoteProviderOptions,
} from "./remote-provider.ts";
import {
	REMOTE_AUTOMATION_LIST_METHOD,
	REMOTE_AUTOMATION_RUN_METHOD,
	type RemoteAutomationListResponse,
	type RemoteAutomationRunParams,
} from "./remote-automation.ts";
import { HOST_OVERVIEW_METHOD } from "../host-overview.ts";
import {
	WORKSPACE_FUNCTIONS_CALL_METHOD,
	WORKSPACE_FUNCTIONS_DESCRIBE_METHOD,
	WORKSPACE_FUNCTIONS_LIST_METHOD,
	type WorkspaceFunctionMetadata,
	type WorkspaceFunctionsCallResponse,
	type WorkspaceFunctionsDescribeResponse,
	type WorkspaceFunctionsListResponse,
} from "../functions.ts";
import {
	WORKSPACE_OVERVIEW_METHOD,
	type WorkspaceOverview,
} from "../workspace-overview.ts";
import { serveToybox } from "./toybox.ts";
import type { CodexToyboxTransport } from "../toybox/client.ts";
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
	collectDeferredRuns,
	collectLocalHandoffRuns,
	collectPromptQueueRuns,
	collectWorkspaceDoctorInfo,
	commitActionsWorkspaceState,
	cancelDeferredRunIntent,
	createWorkspaceContext,
	createDeferredRunIntent,
	drainLocalHandoffQueue,
	enqueueLocalHandoffIntent,
	enqueuePromptQueueIntent,
	listLocalHandoffIntents,
	listPromptQueueIntents,
	listDeferredRunIntents,
	pruneDeferredRunHistory,
	readDeferredRun,
	formatWorkspaceDoctorInfo,
	retryDeferredRunIntent,
	runDuePromptQueueIntents,
	runDueDeferredRuns,
	runWorkspaceTaskById,
	scaffoldActionsWorkspace,
	tickWorkspace,
	type DeferredRunIntent,
} from "./workspace-autonomy.ts";
import {
	formatWorkspaceDelegationListResult,
	formatWorkspaceDelegationStartResult,
	startWorkspaceDelegationWithRequest,
	type WorkspaceDelegationListResult,
} from "./workspace-delegation.ts";
import { serveCodexToysMcp } from "./mcp.ts";
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
		serveCodexToysMcp({
			timeoutMs: parsed.timeoutMs,
		});
		return;
	}
	if (parsed.type === "fetch") {
		const info = await collectFetchInfo({
			appUrl: parsed.appUrl,
			workspaceUrl: parsed.workspaceUrl,
			cwd: parsed.sshTarget ? parsed.cwd : undefined,
			toybox: await collectToyboxInfo(parsed),
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
	if (parsed.type === "toybox-serve") {
		await serveToybox({
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
			toyboxCommand: parsed.toyboxCommand,
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
		const response = await callToybox(
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
		const response = await callToybox(
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
		const response = await callToybox(
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
	if (parsed.type === "host-overview") {
		writeJson(await callToybox(HOST_OVERVIEW_METHOD, {}, parsed), parsed.pretty);
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
			toyboxCommand: parsed.toyboxCommand,
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
		const initialized = await initializeToybox(parsed);
		writeJson({
			advertised: initialized.capabilities.toyboxMethods,
			common: COMMON_TOYBOX_METHODS,
		}, parsed.pretty);
		return;
	}
	if (parsed.type === "workspace-delegate-list") {
		const response = await callToybox(
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
		const info = await collectWorkspaceDoctorInfo(context, { includeRunner: true });
		const toybox = await collectToyboxInfo({
			appUrl: parsed.appUrl,
			workspaceUrl: parsed.workspaceUrl,
			timeoutMs: parsed.timeoutMs,
			sshTarget: parsed.sshTarget,
			cwd: parsed.cwd,
			remotePathPrepend: parsed.remotePathPrepend,
			toyboxCommand: parsed.toyboxCommand,
			remoteCodexCommand: parsed.remoteCodexCommand,
			remoteCodexArgs: parsed.remoteCodexArgs,
		});
		const result = { ...info, toybox };
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: `${formatWorkspaceDoctorInfo(info)}toybox             ${toyboxLabelForDoctor(toybox)}\n`);
		return;
	}
	if (parsed.type === "workspace-overview") {
		const overview = await callToybox(
			WORKSPACE_OVERVIEW_METHOD,
			compactUndefined({
				mode: parsed.mode,
				workspaceRoot: parsed.workspaceRoot,
			}),
			parsed,
		) as WorkspaceOverview;
		write(parsed.json
			? `${JSON.stringify(overview, null, parsed.pretty ? 2 : 0)}\n`
			: formatWorkspaceOverview(overview));
		return;
	}
	if (parsed.type === "workspace-tick") {
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot,
			mode: parsed.mode,
		});
		const result = await withToyboxRequest(parsed, async (request) =>
			await tickWorkspace(context, {
				callToybox: request,
				automationCwd: parsed.cwd,
			})
		);
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
		const run = await withToyboxRequest(parsed, async (request) =>
			await runWorkspaceTaskById(context, parsed.taskId, {
				callToybox: request,
				automationCwd: parsed.cwd,
			})
		);
		writeJson({
			run,
			actionsCommit: await commitActionsWorkspaceState(context, {
				message: `Update Codex workspace state for ${parsed.taskId}`,
			}),
			}, parsed.pretty);
			return;
		}
		if (parsed.type === "workspace-prompt-enqueue") {
			validateAutomationTurnOptions(parsed);
			const params = compactUndefined({
				prompt: parsed.prompt,
				title: parsed.title,
				queue: parsed.queue,
				labels: parsed.labels.length > 0 ? parsed.labels : undefined,
				runAt: parsed.runAt,
				afterIntentId: parsed.afterIntentId,
				afterStatus: parsed.afterStatus,
				threadId: parsed.threadId,
				cwd: parsed.cwd,
				model: parsed.model,
				serviceTier: parsed.serviceTier,
				effort: parsed.effort,
				sandbox: parsed.sandbox,
				approvalPolicy: parsed.approvalPolicy,
				permissions: parsed.permissions,
			});
			const result = hasSshRemote(parsed)
				? await callToybox("promptQueue.enqueue", compactUndefined({
					...params,
					mode: parsed.mode,
					workspaceRoot: parsed.workspaceRoot,
				}), parsed)
				: {
					intent: await enqueuePromptQueueIntent(
						await createWorkspaceContext({
							workspaceRoot: parsed.workspaceRoot,
							mode: parsed.mode,
						}),
						params,
					),
				};
			writeJson(result, parsed.pretty);
			return;
		}
		if (parsed.type === "workspace-prompt-list") {
			if (hasSshRemote(parsed)) {
				const result = await callToybox("promptQueue.list", compactUndefined({
					status: parsed.status,
					queue: parsed.queue,
					limit: parsed.limit,
					mode: parsed.mode,
					workspaceRoot: parsed.workspaceRoot,
				}), parsed);
				write(parsed.json
					? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
					: formatPromptQueueList((record(result).intents ?? []) as DeferredRunIntent[]));
				return;
			}
			const context = await createWorkspaceContext({
				workspaceRoot: parsed.workspaceRoot,
				mode: parsed.mode,
			});
			const intents = await listPromptQueueIntents(context, {
				status: parsed.status,
				queue: parsed.queue,
				limit: parsed.limit,
			});
			write(parsed.json
				? `${JSON.stringify({ intents }, null, parsed.pretty ? 2 : 0)}\n`
				: formatPromptQueueList(intents));
			return;
		}
		if (parsed.type === "workspace-prompt-read") {
			const result = hasSshRemote(parsed)
				? await callToybox("promptQueue.read", compactUndefined({
					id: parsed.intentId,
					includeOutput: parsed.includeOutput,
					mode: parsed.mode,
					workspaceRoot: parsed.workspaceRoot,
				}), parsed)
				: await readDeferredRun(
					await createWorkspaceContext({
						workspaceRoot: parsed.workspaceRoot,
						mode: parsed.mode,
					}),
					parsed.intentId,
					{ includeOutput: parsed.includeOutput },
				);
			write(parsed.json
				? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
				: `${JSON.stringify(result, null, 2)}\n`);
			return;
		}
		if (parsed.type === "workspace-prompt-collect") {
			const result = hasSshRemote(parsed)
				? await callToybox("promptQueue.collect", compactUndefined({
					cursor: parsed.cursor,
					queue: parsed.queue,
					mode: parsed.mode,
					workspaceRoot: parsed.workspaceRoot,
				}), parsed)
				: await collectPromptQueueRuns(
					await createWorkspaceContext({
						workspaceRoot: parsed.workspaceRoot,
						mode: parsed.mode,
					}),
					{ cursor: parsed.cursor, queue: parsed.queue },
				);
			write(parsed.json
				? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
				: `${JSON.stringify(result, null, 2)}\n`);
			return;
		}
		if (parsed.type === "workspace-prompt-cancel") {
			const result = hasSshRemote(parsed)
				? await callToybox("promptQueue.cancel", compactUndefined({
					id: parsed.intentId,
					mode: parsed.mode,
					workspaceRoot: parsed.workspaceRoot,
				}), parsed)
				: {
					intent: await cancelDeferredRunIntent(
						await createWorkspaceContext({
							workspaceRoot: parsed.workspaceRoot,
							mode: parsed.mode,
						}),
						parsed.intentId,
					),
				};
			writeJson(result, parsed.pretty);
			return;
		}
		if (parsed.type === "workspace-prompt-retry") {
			const result = hasSshRemote(parsed)
				? await callToybox("promptQueue.retry", compactUndefined({
					id: parsed.intentId,
					runAt: parsed.runAt,
					mode: parsed.mode,
					workspaceRoot: parsed.workspaceRoot,
				}), parsed)
				: await retryDeferredRunIntent(
					await createWorkspaceContext({
						workspaceRoot: parsed.workspaceRoot,
						mode: parsed.mode,
					}),
					parsed.intentId,
					compactUndefined({
						runAt: parsed.runAt,
					}),
				);
			writeJson(result, parsed.pretty);
			return;
		}
		if (parsed.type === "workspace-prompt-run-due") {
			const result = hasSshRemote(parsed)
				? await callToybox("promptQueue.runDue", compactUndefined({
					queue: parsed.queue,
					limit: parsed.limit,
					mode: parsed.mode,
					workspaceRoot: parsed.workspaceRoot,
				}), parsed)
				: await withToyboxRequest(parsed, async (request) =>
					await runDuePromptQueueIntents(
						await createWorkspaceContext({
							workspaceRoot: parsed.workspaceRoot,
							mode: parsed.mode,
						}),
						{
							queue: parsed.queue,
							limit: parsed.limit,
							callToybox: request,
							automationCwd: parsed.cwd,
						},
					)
				);
			writeJson(result, parsed.pretty);
			return;
		}
		if (parsed.type === "workspace-handoff-enqueue") {
			validateAutomationTurnOptions(parsed);
			const params = compactUndefined({
				prompt: parsed.prompt,
				title: parsed.title,
				queue: parsed.queue,
				labels: parsed.labels.length > 0 ? parsed.labels : undefined,
				runAt: parsed.runAt,
				afterIntentId: parsed.afterIntentId,
				afterStatus: parsed.afterStatus,
				targetHost: parsed.targetHost,
				requiredCapabilities: parsed.requiredCapabilities.length > 0 ? parsed.requiredCapabilities : undefined,
				requesterHost: parsed.requesterHost,
				requesterThreadId: parsed.requesterThreadId,
				threadId: parsed.threadId,
				cwd: parsed.cwd,
				model: parsed.model,
				serviceTier: parsed.serviceTier,
				effort: parsed.effort,
				sandbox: parsed.sandbox,
				approvalPolicy: parsed.approvalPolicy,
				permissions: parsed.permissions,
			});
			const result = hasSshRemote(parsed)
				? await callToybox("localHandoff.enqueue", compactUndefined({
					...params,
					mode: parsed.mode,
					workspaceRoot: parsed.workspaceRoot,
				}), parsed)
				: {
					intent: await enqueueLocalHandoffIntent(
						await createWorkspaceContext({
							workspaceRoot: parsed.workspaceRoot,
							mode: parsed.mode,
						}),
						params,
					),
				};
			writeJson(result, parsed.pretty);
			return;
		}
		if (parsed.type === "workspace-handoff-list") {
			if (hasSshRemote(parsed)) {
				const result = await callToybox("localHandoff.list", compactUndefined({
					status: parsed.status,
					queue: parsed.queue,
					targetHost: parsed.targetHost,
					capabilities: parsed.capabilities.length > 0 ? parsed.capabilities : undefined,
					limit: parsed.limit,
					mode: parsed.mode,
					workspaceRoot: parsed.workspaceRoot,
				}), parsed);
				write(parsed.json
					? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
					: formatLocalHandoffList((record(result).intents ?? []) as DeferredRunIntent[]));
				return;
			}
			const context = await createWorkspaceContext({
				workspaceRoot: parsed.workspaceRoot,
				mode: parsed.mode,
			});
			const intents = await listLocalHandoffIntents(context, {
				status: parsed.status,
				queue: parsed.queue,
				targetHost: parsed.targetHost,
				capabilities: parsed.capabilities.length > 0 ? parsed.capabilities : undefined,
				limit: parsed.limit,
			});
			write(parsed.json
				? `${JSON.stringify({ intents }, null, parsed.pretty ? 2 : 0)}\n`
				: formatLocalHandoffList(intents));
			return;
		}
		if (parsed.type === "workspace-handoff-read") {
			const result = hasSshRemote(parsed)
				? await callToybox("localHandoff.read", compactUndefined({
					id: parsed.intentId,
					includeOutput: parsed.includeOutput,
					mode: parsed.mode,
					workspaceRoot: parsed.workspaceRoot,
				}), parsed)
				: await readDeferredRun(
					await createWorkspaceContext({
						workspaceRoot: parsed.workspaceRoot,
						mode: parsed.mode,
					}),
					parsed.intentId,
					{ includeOutput: parsed.includeOutput },
				);
			write(parsed.json
				? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
				: `${JSON.stringify(result, null, 2)}\n`);
			return;
		}
		if (parsed.type === "workspace-handoff-collect") {
			const options = compactUndefined({
				cursor: parsed.cursor,
				queue: parsed.queue,
				targetHost: parsed.targetHost,
				capabilities: parsed.capabilities.length > 0 ? parsed.capabilities : undefined,
			});
			const result = hasSshRemote(parsed)
				? await callToybox("localHandoff.collect", compactUndefined({
					...options,
					mode: parsed.mode,
					workspaceRoot: parsed.workspaceRoot,
				}), parsed)
				: await collectLocalHandoffRuns(
					await createWorkspaceContext({
						workspaceRoot: parsed.workspaceRoot,
						mode: parsed.mode,
					}),
					options,
				);
			write(parsed.json
				? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
				: `${JSON.stringify(result, null, 2)}\n`);
			return;
		}
		if (parsed.type === "workspace-handoff-cancel") {
			const result = hasSshRemote(parsed)
				? await callToybox("localHandoff.cancel", compactUndefined({
					id: parsed.intentId,
					mode: parsed.mode,
					workspaceRoot: parsed.workspaceRoot,
				}), parsed)
				: {
					intent: await cancelDeferredRunIntent(
						await createWorkspaceContext({
							workspaceRoot: parsed.workspaceRoot,
							mode: parsed.mode,
						}),
						parsed.intentId,
					),
				};
			writeJson(result, parsed.pretty);
			return;
		}
		if (parsed.type === "workspace-handoff-retry") {
			const result = hasSshRemote(parsed)
				? await callToybox("localHandoff.retry", compactUndefined({
					id: parsed.intentId,
					runAt: parsed.runAt,
					mode: parsed.mode,
					workspaceRoot: parsed.workspaceRoot,
				}), parsed)
				: await retryDeferredRunIntent(
					await createWorkspaceContext({
						workspaceRoot: parsed.workspaceRoot,
						mode: parsed.mode,
					}),
					parsed.intentId,
					compactUndefined({
						runAt: parsed.runAt,
					}),
				);
			writeJson(result, parsed.pretty);
			return;
		}
		if (parsed.type === "workspace-handoff-drain") {
			const action = parsed.materialize ? "materialize" as const : "run" as const;
			const drainParams = compactUndefined({
				queue: parsed.queue,
				hostId: parsed.hostId,
				capabilities: parsed.capabilities.length > 0 ? parsed.capabilities : undefined,
				limit: parsed.limit,
				action,
				promptQueue: parsed.promptQueue,
			});
			const result = hasSshRemote(parsed)
				? await callToybox("localHandoff.drain", compactUndefined({
					...drainParams,
					mode: parsed.mode,
					workspaceRoot: parsed.workspaceRoot,
				}), parsed)
				: await withToyboxRequest(parsed, async (request) =>
					await drainLocalHandoffQueue(
						await createWorkspaceContext({
							workspaceRoot: parsed.workspaceRoot,
							mode: parsed.mode,
						}),
						{
							...drainParams,
							callToybox: request,
							automationCwd: parsed.cwd,
						},
					)
				);
			writeJson(result, parsed.pretty);
			return;
		}
		if (parsed.type === "workspace-deferred-create") {
		const params = await readParams(parsed.paramsText, parsed.paramsFile);
		const result = hasSshRemote(parsed)
			? await callToybox("deferred.create", compactUndefined({
				...record(params),
				mode: parsed.mode,
				workspaceRoot: parsed.workspaceRoot,
			}), parsed)
			: {
				intent: await createDeferredRunIntent(
					await createWorkspaceContext({
						workspaceRoot: parsed.workspaceRoot,
						mode: parsed.mode,
					}),
					params,
				),
			};
		writeJson(result, parsed.pretty);
		return;
	}
	if (parsed.type === "workspace-deferred-list") {
		if (hasSshRemote(parsed)) {
			const result = await callToybox("deferred.list", compactUndefined({
				mode: parsed.mode,
				workspaceRoot: parsed.workspaceRoot,
			}), parsed);
			write(parsed.json
				? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
				: formatDeferredRunList((record(result).intents ?? []) as DeferredRunIntent[]));
			return;
		}
		const context = await createWorkspaceContext({
			workspaceRoot: parsed.workspaceRoot,
			mode: parsed.mode,
		});
		const intents = await listDeferredRunIntents(context);
		write(parsed.json
			? `${JSON.stringify({ intents }, null, parsed.pretty ? 2 : 0)}\n`
			: formatDeferredRunList(intents));
		return;
	}
	if (parsed.type === "workspace-deferred-read") {
		const result = hasSshRemote(parsed)
			? await callToybox("deferred.read", compactUndefined({
				id: parsed.intentId,
				includeOutput: parsed.includeOutput,
				mode: parsed.mode,
				workspaceRoot: parsed.workspaceRoot,
			}), parsed)
			: await readDeferredRun(
				await createWorkspaceContext({
					workspaceRoot: parsed.workspaceRoot,
					mode: parsed.mode,
				}),
				parsed.intentId,
				{ includeOutput: parsed.includeOutput },
			);
		write(parsed.json
			? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
			: `${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	if (parsed.type === "workspace-deferred-collect") {
		const result = hasSshRemote(parsed)
			? await callToybox("deferred.collect", compactUndefined({
				cursor: parsed.cursor,
				mode: parsed.mode,
				workspaceRoot: parsed.workspaceRoot,
			}), parsed)
			: await collectDeferredRuns(
				await createWorkspaceContext({
					workspaceRoot: parsed.workspaceRoot,
					mode: parsed.mode,
				}),
				{ cursor: parsed.cursor },
			);
		write(parsed.json
			? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
			: `${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	if (parsed.type === "workspace-deferred-cancel") {
		const result = hasSshRemote(parsed)
			? await callToybox("deferred.cancel", compactUndefined({
				id: parsed.intentId,
				mode: parsed.mode,
				workspaceRoot: parsed.workspaceRoot,
			}), parsed)
			: {
				intent: await cancelDeferredRunIntent(
					await createWorkspaceContext({
						workspaceRoot: parsed.workspaceRoot,
						mode: parsed.mode,
					}),
					parsed.intentId,
				),
			};
		writeJson(result, parsed.pretty);
		return;
	}
	if (parsed.type === "workspace-deferred-retry") {
		const result = hasSshRemote(parsed)
			? await callToybox("deferred.retry", compactUndefined({
				id: parsed.intentId,
				runAt: parsed.runAt,
				mode: parsed.mode,
				workspaceRoot: parsed.workspaceRoot,
			}), parsed)
			: await retryDeferredRunIntent(
				await createWorkspaceContext({
					workspaceRoot: parsed.workspaceRoot,
					mode: parsed.mode,
				}),
				parsed.intentId,
				compactUndefined({
					runAt: parsed.runAt,
				}),
			);
		writeJson(result, parsed.pretty);
		return;
	}
	if (parsed.type === "workspace-deferred-run-due") {
		const result = hasSshRemote(parsed)
			? await callToybox("deferred.runDue", compactUndefined({
				mode: parsed.mode,
				workspaceRoot: parsed.workspaceRoot,
			}), parsed)
			: await withToyboxRequest(parsed, async (request) =>
				await runDueDeferredRuns(
					await createWorkspaceContext({
						workspaceRoot: parsed.workspaceRoot,
						mode: parsed.mode,
					}),
					{
						callToybox: request,
						automationCwd: parsed.cwd,
					},
				)
			);
		writeJson(result, parsed.pretty);
		return;
	}
	if (parsed.type === "workspace-deferred-prune") {
		const result = hasSshRemote(parsed)
			? await callToybox("deferred.prune", compactUndefined({
				mode: parsed.mode,
				workspaceRoot: parsed.workspaceRoot,
				olderThanDays: parsed.olderThanDays,
				dryRun: parsed.dryRun,
			}), parsed)
			: await pruneDeferredRunHistory(
				await createWorkspaceContext({
					workspaceRoot: parsed.workspaceRoot,
					mode: parsed.mode,
				}),
				{
					olderThanDays: parsed.olderThanDays,
					dryRun: parsed.dryRun,
				},
			);
		writeJson(result, parsed.pretty);
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
			await callToybox(
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
			await callToybox(
				APP_CALL_METHOD,
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

function toyboxLabelForDoctor(toybox: FetchToyboxInfo): string {
	if (toybox.status === "connected") {
		return toybox.url ? `${toybox.transport} connected (${toybox.url})` : `${toybox.transport} connected`;
	}
	return toybox.error ? `unavailable (${toybox.error})` : "unavailable";
}

function formatWorkspaceOverview(overview: WorkspaceOverview): string {
	const lines = [
		`workspace          ${overview.workspace.repoRoot}`,
		`mode               ${overview.workspace.mode}`,
		`config             ${overview.workspace.config.exists ? "found" : "missing"} ${overview.workspace.config.path}`,
		`health             ${overview.health.ok ? "ok" : "attention"}`,
		`deferred           ${overview.deferred.summary.total} total, ${overview.deferred.summary.due} due, ${overview.deferred.summary.running} running, ${overview.deferred.summary.failed} failed`,
		`automations        ${overview.automations.ok ? overview.automations.total : `error: ${overview.automations.error}`}`,
		`functions          ${overview.functions.ok ? overview.functions.total : `error: ${overview.functions.error}`}`,
		`threads            ${overview.threads.ok ? `${overview.threads.total} recent for cwd` : `error: ${overview.threads.error}`}`,
		`git                ${overview.git.ok && overview.git.isRepo ? `${overview.git.branch ?? "unknown"} ${overview.git.commit ?? ""}${overview.git.dirty ? " dirty" : ""}` : overview.git.error ?? "not a git repo"}`,
	];
	if (overview.deferred.latest) {
		lines.push(`latest deferred    ${overview.deferred.latest.status} ${overview.deferred.latest.id} ${overview.deferred.latest.updatedAt}`);
	}
	for (const check of overview.health.checks.filter((item) => !item.ok)) {
		lines.push(`check              ${check.name} ${check.status}${check.error ? `: ${check.error}` : ""}`);
	}
	return `${lines.join("\n")}\n`;
}

async function callAppServer(
	method: string,
	params: unknown,
	options: { url: string; timeoutMs: number } & SshRemoteProviderOptions,
): Promise<unknown> {
	return await callToybox(APP_CALL_METHOD, { method, params }, options);
}

async function listRemoteTurnAutomationsForCli(
	options: {
		workspaceRoot?: string;
		cwd?: string;
		timeoutMs: number;
	} & SshRemoteProviderOptions,
): Promise<RemoteAutomationListResponse["automations"]> {
	return await withSshRemoteToyboxTransport(options, async (transport) => {
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
	return await withSshRemoteToyboxTransport(options, async (transport) => {
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
	let transport: CodexToyboxTransport | undefined;
	const getTransport = async (): Promise<CodexToyboxTransport> => {
		if (transport) {
			return transport;
		}
		if (hasSshRemote(options)) {
			transport = createSshToyboxTransport(options);
		} else {
			transport = createLocalToyboxTransport(options);
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
			await (await getTransport()).request(APP_CALL_METHOD, {
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

async function initializeToybox(options: {
	url: string;
	timeoutMs: number;
} & SshRemoteProviderOptions): Promise<ToyboxInitializeResponse> {
	return await withWorkspaceTransport(options, async (transport) =>
		await initialize(transport)
	);
}

async function callToybox(
	method: string,
	params: unknown,
	options: { url: string; timeoutMs: number } & SshRemoteProviderOptions,
): Promise<unknown> {
	return await withWorkspaceTransport(options, async (transport) => {
		await initialize(transport);
		return await transport.request(method, params);
	});
}

async function withToyboxRequest<T>(
	options: { url: string; timeoutMs: number } & SshRemoteProviderOptions,
	callback: (
		request: (method: string, params: unknown) => Promise<unknown>,
	) => Promise<T>,
): Promise<T> {
	return await withWorkspaceTransport(options, async (transport) => {
		await initialize(transport);
		return await callback(async (method, params) =>
			await transport.request(method, params)
		);
	});
}

async function withWorkspaceTransport<T>(
	options: { url: string; timeoutMs: number } & SshRemoteProviderOptions,
	callback: (transport: CodexToyboxTransport) => Promise<T>,
): Promise<T> {
	if (hasSshRemote(options)) {
		return await withSshRemoteToyboxTransport(options, callback);
	}
	const transport = createLocalToyboxTransport(options);
	try {
		transport.start();
		return await callback(transport);
	} finally {
		transport.close();
	}
}

async function initialize(
	transport: CodexToyboxTransport,
): Promise<ToyboxInitializeResponse> {
	return await transport.request<ToyboxInitializeResponse>(
		TOYBOX_INITIALIZE_METHOD,
		{
			clientInfo: {
				name: "codex-toys-cli",
				title: "Codex Toys CLI",
				version: "0.1.0",
			},
			capabilities: {
				appPassThrough: true,
			},
		},
	);
}

async function collectToyboxInfo(options: {
	appUrl: string;
	workspaceUrl: string;
	timeoutMs: number;
} & SshRemoteProviderOptions): Promise<FetchToyboxInfo> {
	if (hasSshRemote(options)) {
		return await collectSshToyboxInfo(options);
	}
	return await collectLocalToyboxInfo(options);
}

async function collectSshToyboxInfo(
	options: {
		appUrl: string;
		workspaceUrl: string;
		timeoutMs: number;
	} & SshRemoteProviderOptions,
): Promise<FetchToyboxInfo> {
	try {
		return await withSshRemoteToyboxTransport(options, async (transport) =>
			await collectToyboxInfoFromTransport(
				transport,
				"ssh://toybox",
				"ssh",
				options.timeoutMs,
			)
		);
	} catch (error) {
		return {
			transport: "ssh",
			status: "unavailable",
			error: `toybox: ${errorMessage(error)}`,
		};
	}
}

async function collectLocalToyboxInfo(options: {
	timeoutMs: number;
}): Promise<FetchToyboxInfo> {
	const transport = createLocalToyboxTransport(options);
	transport.on("error", () => {});
	try {
		transport.start();
		return await collectToyboxInfoFromTransport(
			transport,
			"toybox://local",
			"local",
			options.timeoutMs,
		);
	} catch (error) {
		return {
			transport: "local",
			status: "unavailable",
			url: "toybox://local",
			error: errorMessage(error),
		};
	} finally {
		transport.close();
	}
}

async function collectToyboxInfoFromTransport(
	transport: CodexToyboxTransport,
	url: string,
	toyboxTransport: FetchToyboxInfo["transport"],
	timeoutMs: number,
): Promise<FetchToyboxInfo> {
	return await withProbeTimeout(async () => {
		const initialized = await initialize(transport);
		const methods = new Set(initialized.capabilities.toyboxMethods);
		const threads = await collectThreadsViaWorkspace(transport);
		const delegations = methods.has("delegation.list")
			? await optionalProbe(() => collectDelegations(transport))
			: undefined;
		return {
			transport: toyboxTransport,
			status: "connected",
			url,
			server: initialized.serverInfo,
			capabilities: {
				toyboxMethods: initialized.capabilities.toyboxMethods.length,
			},
			threads,
			...(delegations ? { delegations } : {}),
		};
	}, timeoutMs, `toybox probe timed out after ${timeoutMs}ms`);
}

async function collectThreadsViaWorkspace(
	transport: CodexToyboxTransport,
): Promise<FetchThreadsInfo> {
	try {
		const response = await transport.request(APP_CALL_METHOD, {
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
	transport: CodexToyboxTransport,
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

	function formatDeferredRunList(intents: DeferredRunIntent[]): string {
		if (intents.length === 0) {
			return "No deferred runs found.\n";
	}
	return intents.map((intent) => [
		intent.id,
		intent.status,
		intent.runAt,
		deferredTargetLabel(intent.target),
	].join("  ")).join("\n") + "\n";
}

function deferredTargetLabel(target: DeferredRunIntent["target"]): string {
	if (target.kind === "workspace-task") {
		return `workspace-task:${target.taskId}`;
	}
	if (target.kind === "automation") {
		return `automation:${target.automation}`;
	}
		return "turn";
	}

	function formatPromptQueueList(intents: DeferredRunIntent[]): string {
		if (intents.length === 0) {
			return "No queued prompts found.\n";
		}
		return intents.map((intent) => [
			intent.id,
			intent.status,
			intent.runAt,
			promptQueueLabel(intent),
		].join("  ")).join("\n") + "\n";
	}

	function promptQueueLabel(intent: DeferredRunIntent): string {
		const source = record(intent.source);
		const queue = stringValue(source.queue) ?? "default";
		const title = stringValue(source.title);
		if (title) {
			return `${queue}:${title}`;
		}
		return queue;
	}

	function formatLocalHandoffList(intents: DeferredRunIntent[]): string {
		if (intents.length === 0) {
			return "No local handoffs found.\n";
		}
		return intents.map((intent) => [
			intent.id,
			intent.status,
			intent.runAt,
			localHandoffLabel(intent),
		].join("  ")).join("\n") + "\n";
	}

	function localHandoffLabel(intent: DeferredRunIntent): string {
		const source = record(intent.source);
		const queue = stringValue(source.queue) ?? "local";
		const targetHost = stringValue(source.targetHost) ?? "local-controller";
		const title = stringValue(source.title);
		if (title) {
			return `${queue}:${targetHost}:${title}`;
		}
		return `${queue}:${targetHost}`;
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
	return `codex-toys controls Codex-native local and SSH toybox surfaces.

Usage:
  codex-toys fetch [--json] [--no-color]
  codex-toys neofetch [--json] [--no-color]
  codex-toys --ssh <target> --cwd <remote-workspace> fetch
  codex-toys toybox serve [--cwd <path>]
  codex-toys mcp serve

  codex-toys --ssh <target> --cwd <remote-workspace> remote preflight [--json]
  codex-toys host overview --json
  codex-toys --ssh <target> --cwd <remote-workspace> remote host-overview --json

  codex-toys turn run <prompt> [--wait] [--thread-id <id>]
  codex-toys --ssh <target> --cwd <remote-workspace> turn run <prompt> --wait

  codex-toys automation list [--json]
  codex-toys automation run <name> [--event <event.json>] [--prompt <text>] [--via workspace|app]
  codex-toys --ssh <target> --cwd <remote-workspace> automation list [--json]
  codex-toys --ssh <target> --cwd <remote-workspace> automation run <name> [--event <event.json>]

  codex-toys app <method> [params-json]
  codex-toys app <method> --params-json <json>
  codex-toys app <method> --params-file <file>
  codex-toys app call <method> [params-json]
  echo '<params-json>' | codex-toys app <method>
  codex-toys app actions

  codex-toys functions list [--json]
  codex-toys functions describe <name> [--json]
  codex-toys functions call <name> [--params-json <json>] [--json]
  codex-toys --ssh <target> --cwd <remote-workspace> functions list [--json]

  codex-toys workspace <method> [params-json]
  codex-toys workspace <method> --params-json <json>
  codex-toys workspace <method> --params-file <file>
  codex-toys workspace call <method> [params-json]
  codex-toys workspace app <method> [params-json]
  codex-toys workspace methods
  codex-toys workspace overview [--json]
  codex-toys workspace delegate list [--json]
  codex-toys workspace delegate start --cwd @/workspaces/name --prompt <text> [--wait]
	  codex-toys workspace doctor [--mode auto|local|actions] [--json]
	  codex-toys workspace tick [--mode auto|local|actions]
	  codex-toys workspace run <task-id> [--mode auto|local|actions]
	  codex-toys workspace prompt enqueue <prompt> [--run-at <iso>] [--after <intent-id>]
	  codex-toys workspace prompt list [--queue <name>] [--status <status>] [--json]
	  codex-toys workspace prompt pull <intent-id> [--json]
	  codex-toys workspace prompt collect [--cursor <name>] [--queue <name>] [--json]
	  codex-toys workspace prompt run-due [--queue <name>] [--limit <n>]
	  codex-toys workspace handoff enqueue <prompt> [--target-host <host>] [--capability <name>]
	  codex-toys workspace handoff list [--queue <name>] [--status <status>] [--json]
	  codex-toys workspace handoff drain [--host-id <host>] [--capability <name>] [--materialize]
	  codex-toys workspace deferred create --params-json <json>
  codex-toys workspace deferred list [--mode auto|local|actions] [--json]
  codex-toys workspace deferred read <intent-id> [--include-output] [--json]
  codex-toys workspace deferred pull <intent-id> [--json]
  codex-toys workspace deferred collect [--cursor <name>] [--json]
  codex-toys workspace deferred cancel <intent-id>
  codex-toys workspace deferred retry <intent-id> [--run-at <iso>]
  codex-toys workspace deferred run-due [--mode auto|local|actions]
  codex-toys workspace deferred prune --older-than-days <days> [--dry-run]
  codex-toys workspace init actions [--forgejo|--github]

  codex-toys actions prepare-auth
  codex-toys actions cleanup

  codex-toys memories transplant global-to-workspace [--apply]
  codex-toys memories transplant workspace-to-global [--apply]

  codex-toys threads locate <thread-id> [--codex-home <home>]
  codex-toys threads inspect <thread-id-or-rollout.jsonl> [--codex-home <home>]
  codex-toys threads install-rollout <rollout.jsonl> [--codex-home <home>] [--replace]
  codex-toys threads transplant <thread-id> --from-codex-home <src> --to-codex-home <dst> [--replace]

  codex-toys pack inspect <source> [--json]
  codex-toys pack add <source> [--apply] [--include <name>] [--exclude <name>]
  codex-toys pack doctor [--json]
  codex-toys pack list [--json]

Options:
  --timeout-ms <ms>                          Request timeout. Defaults to 90000,
                                             1500 for local fetch probes, or
                                             1800000 for automation run and
                                             waited turns.
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
	  --title <text>                             Delegation thread title or queued prompt title.
	  --queue <name>                             Prompt queue name.
	  --label <label>                            Prompt queue label. Repeatable.
	  --after <intent-id>                        Hold queued prompt until another intent finishes.
	  --after-status <status>                    Dependency status: completed, failed,
	                                             canceled, or terminal.
	  --status <status>                          Deferred/prompt status filter.
	  --limit <n>                                Limit listed or due queued work.
	  --run-at <iso>                             Future run time for deferred or queued work.
	  --service-tier <tier>                      Turn service tier for queued prompts.
	  --effort <effort>                          Reasoning effort: none, minimal, low,
	                                             medium, high, or xhigh.
	  --group-id <id>                            Delegation group id.
  --return-mode <mode>                       Delegation return mode: detached,
                                             record_only, wake_on_done,
                                             wake_on_group, or manual.
  --allow-absolute-cwd                       Allow workspace delegation to target
                                             an absolute cwd.
  --target-cwd <path>                        Delegation target cwd. Useful with
                                             --ssh, where --cwd selects the
                                             remote workspace root.
  --dry-run                                  Preview supported write operations.
  --older-than-days <days>                   Retention window for deferred prune.
  --cursor <name>                            Deferred collect cursor name.
  --via <workspace|app>                      Turn surface. Defaults to workspace.
  --sandbox <mode>                           Turn sandbox: danger-full-access,
                                             workspace-write, or read-only.
  --approval-policy <policy>                 Turn approval policy: never,
                                             on-failure, on-request, or untrusted.
  --permissions <profile>                    Turn permissions profile.
  --ssh, --ssh-target <target>               SSH target for remote CodexToys operation
                                             Defaults to CODEX_TOYS_REMOTE_SSH_TARGET.
  --remote-path-prepend <paths>              Colon-separated remote PATH entries for
                                             non-interactive SSH commands.
  --toybox-command <command>                  codex-toys command/path for spawned toyboxes.
                                             Defaults to CODEX_TOYS_TOYBOX_COMMAND
                                             or codex-toys.
  --codex-command <command>                  Codex command used by the toybox.
                                             Defaults to CODEX_TOYS_REMOTE_CODEX_COMMAND or codex.
  --codex-arg <arg>                          Extra Codex argument. Repeatable.
  --cwd <path>                               Remote workspace cwd for SSH operation.
                                             For local workspace delegate, also
                                             accepts @/path relative to the
                                             workspace root.
  -h, --help                                 Show this help.

Examples:
  codex-toys fetch
  codex-toys mcp serve
  codex-toys toybox serve --cwd /repo
  codex-toys --ssh devbox --cwd /repo fetch
  codex-toys host overview --json
  codex-toys --ssh devbox --cwd /repo remote host-overview --json
  codex-toys --ssh devbox --cwd /repo turn run "Scan current folder" --wait
  codex-toys automation list
  codex-toys automation run check-release --event event.json
  codex-toys --ssh devbox --cwd /repo automation list --json
  codex-toys --ssh devbox --cwd /repo automation run check-release --event event.json
  codex-toys --ssh devbox --cwd /repo functions list --json
  codex-toys --ssh devbox --cwd /repo functions call portfolioSnapshot --json
  codex-toys --ssh devbox --cwd /repo app thread/list '{"limit":20,"sourceKinds":[]}'
  codex-toys --ssh devbox --cwd /repo workspace delegation.list
  codex-toys app thread/list '{"limit":20,"sourceKinds":[]}'
  codex-toys workspace app thread/list '{"limit":20,"sourceKinds":[]}'
  codex-toys workspace delegation.list
  codex-toys workspace overview --json
  codex-toys workspace delegate start --cwd @/workspaces/trading --prompt "Inspect status"
  codex-toys workspace doctor --mode actions
  codex-toys workspace deferred create --params-json '{"runAt":"2026-01-01T14:00:00.000Z","target":{"kind":"turn","prompt":"Review the workspace."}}'
  codex-toys workspace init actions --forgejo
  codex-toys memories transplant global-to-workspace
  codex-toys threads inspect 019e3654-1492-70d0-9b01-46b17d6444a9 --codex-home ./.codex
  codex-toys threads install-rollout ./rollout-2026-05-18T15-12-25-019e3ba5-3c2a-74c1-bece-53a8ece3dc0e.jsonl --codex-home ./.codex
  codex-toys threads transplant 019e3654-1492-70d0-9b01-46b17d6444a9 --from-codex-home ~/.codex --to-codex-home ./.codex
  codex-toys pack inspect owner/repo
  codex-toys pack add ./capability-pack --apply
`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
