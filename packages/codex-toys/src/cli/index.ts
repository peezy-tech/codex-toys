#!/usr/bin/env node
import http from "node:http";
import { helpText } from "./help.ts";
import {
	APP_CALL_METHOD,
	TOYBOX_INITIALIZE_METHOD,
	type ToyboxInitializeResponse,
} from "@codex-toys/toybox";
import {
	COMMON_APP_SERVER_ACTIONS,
	COMMON_TOYBOX_METHODS,
} from "./actions.ts";
import {
	cleanupActionsCodexHome,
	prepareActionsCodexAuth,
} from "@codex-toys/actions";
import {
	parseArgs,
	type ParsedCli,
} from "./args.ts";
import {
	appendFeedItem,
	collectFeedDoctorInfo,
	collectFeedItems,
	createFeedContext,
	dispatchFeedItems,
	advanceFeedCursor,
	FEED_COLLECT_METHOD,
	FEED_CURSOR_ADVANCE_METHOD,
	FEED_DISPATCH_METHOD,
	FEED_DOCTOR_METHOD,
	FEED_ITEM_APPEND_METHOD,
	FEED_ITEM_LIST_METHOD,
	FEED_ITEM_READ_METHOD,
	FEED_POLL_METHOD,
	FEED_PRUNE_METHOD,
	FEED_SOURCE_LIST_METHOD,
	feedAppendItemOptionsFromParams,
	formatFeedDoctorInfo,
	listFeedItems,
	loadFeedConfig,
	pollFeedSources,
	pruneFeedItems,
	readFeedItem,
	toFeedEvent,
	type FeedAdvanceCursorResult,
	type FeedAppendItemResult,
	type FeedCollectResult,
	type FeedDispatchResult,
	type FeedDoctorInfo,
	type FeedItem,
	type FeedPollResult,
	type FeedPruneResult,
	type FeedSource,
} from "@codex-toys/feed";
import {
	collectFetchInfo,
	formatFetchInfo,
	type FetchCountInfo,
	type FetchRuntimeTransportInfo,
	type FetchThreadSummary,
	type FetchThreadsInfo,
} from "@codex-toys/workbench";
import {
	applyMemoryTransplant,
	formatMemoryTransplantPlan,
} from "./memories.ts";
import {
	applyKitAdd,
	collectKitDoctor,
	formatKitAddPlan,
	formatKitDoctor,
	formatKitInspection,
	formatKitList,
	inspectKitSource,
	listInstalledKits,
	planKitAdd,
} from "@codex-toys/kits";
import {
	buildKitSetupPrompt,
	conflictCount,
	formatKitSetupResult,
	hasSetupSkillItem,
} from "./kit-setup.ts";
import {
	formatRemoteTurnStartResult,
	startRemoteTurn,
} from "@codex-toys/remote";
import {
	collectRemotePreflight,
	formatRemotePreflight,
} from "@codex-toys/remote";
import {
	createWorkflowHost,
	formatWorkflowList,
	formatWorkflowRun,
	listWorkflows,
	resolveWorkflowTarget,
	runWorkflowScript,
	type WorkflowBackendRequest,
	type WorkflowHostHandler,
	type WorkflowRun,
	type WorkflowRunTarget,
} from "@codex-toys/workbench";
import {
	createLocalToyboxTransport,
	createSshToyboxTransport,
	hasSshRemote,
	withSshRemoteToyboxTransport,
	type SshRemoteProviderOptions,
} from "@codex-toys/remote";
import {
	REMOTE_WORKFLOW_LIST_METHOD,
	REMOTE_WORKFLOW_RUN_METHOD,
	type RemoteWorkflowListResponse,
	type RemoteWorkflowRunParams,
} from "@codex-toys/workbench";
import { HOST_OVERVIEW_METHOD } from "@codex-toys/workbench";
import {
	WORKBENCH_FUNCTIONS_CALL_METHOD,
	WORKBENCH_FUNCTIONS_DESCRIBE_METHOD,
	WORKBENCH_FUNCTIONS_LIST_METHOD,
	type WorkbenchFunctionMetadata,
	type WorkbenchFunctionsCallResponse,
	type WorkbenchFunctionsDescribeResponse,
	type WorkbenchFunctionsListResponse,
} from "@codex-toys/workbench";
import {
	WORKBENCH_OVERVIEW_METHOD,
	type WorkbenchOverview,
} from "@codex-toys/workbench";
import { serveToybox } from "./toybox.ts";
import { createCodexToysProxyHandler } from "@codex-toys/proxy";
import type { CodexToyboxTransport } from "@codex-toys/toybox";
import {
	formatThreadRolloutInspection,
	formatThreadRolloutInstallation,
	formatThreadRolloutLocation,
	formatThreadRolloutTransplant,
	installThreadRollout,
	inspectThreadRollout,
	locateThreadRollout,
	transplantThreadRollout,
} from "@codex-toys/bridge";
import {
	collectDispatchRuns,
	collectLocalHandoffRuns,
	collectPromptQueueRuns,
	collectWorkbenchDoctorInfo,
	commitActionsWorkbenchState,
	cancelDispatchRunIntent,
	createWorkbenchContext,
	createDispatchRunIntent,
	drainLocalHandoffQueue,
	enqueueLocalHandoffIntent,
	enqueuePromptQueueIntent,
	listLocalHandoffIntents,
	listPromptQueueIntents,
	listDispatchRunIntents,
	pruneDispatchRunHistory,
	readDispatchRun,
	formatWorkbenchDoctorInfo,
	retryDispatchRunIntent,
	runDuePromptQueueIntents,
	runDueDispatchRuns,
	runWorkbenchTaskById,
	scaffoldActionsWorkbench,
	type DispatchRunIntent,
} from "@codex-toys/workbench";
import { serveCodexToysMcp } from "./mcp.ts";
import { parseJsonParamsText, readJsonFile } from "@codex-toys/bridge/json";

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
			workbenchUrl: parsed.workbenchUrl,
			cwd: parsed.sshTarget ? parsed.cwd : undefined,
			runtimeTransport: await collectRuntimeTransportInfo(parsed),
		});
		write(parsed.json
			? `${JSON.stringify(info, null, 2)}\n`
			: formatFetchInfo(info, { color: parsed.color }));
		return;
	}
	if (parsed.type === "runtime-preflight") {
		const result = await collectRemotePreflight(parsed);
		write(parsed.json
			? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
			: formatRemotePreflight(result));
		if (!result.ok) {
			process.exitCode = 1;
		}
		return;
	}
	if (parsed.type === "runtime-serve") {
		await serveToybox({
			cwd: parsed.cwd,
			timeoutMs: parsed.timeoutMs,
			codexCommand: parsed.remoteCodexCommand,
			codexArgs: parsed.remoteCodexArgs,
		});
		return;
	}
	if (parsed.type === "runtime-http") {
		await serveRuntimeHttp(parsed);
		return;
	}
	if (parsed.type === "workflow-run") {
		validateWorkflowTurnOptions(parsed);
		if (hasSshRemote(parsed)) {
			const run = await runRemoteWorkflowForCli(parsed);
			write(parsed.json
				? `${JSON.stringify(run, null, parsed.pretty ? 2 : 0)}\n`
				: formatWorkflowRun(run));
			return;
		}
		const event = parsed.eventPath
			? await readJsonFile(parsed.eventPath)
			: undefined;
		const target = parsed.target
			? await resolveWorkflowTarget(parsed.target, {
					cwd: parsed.workbenchRoot,
				})
			: {
					scriptPath: parsed.scriptPath,
					script: parsed.scriptStdin ? await readStdin() : undefined,
				} satisfies WorkflowRunTarget;
		const prompt = parsed.prompt ?? target.prompt;
		const cwd = parsed.cwd ?? target.cwd;
		const run = await runWorkflowForCli(target, {
			event,
			prompt,
			cwd,
			via: parsed.via,
			appUrl: parsed.appUrl,
			workbenchUrl: parsed.workbenchUrl,
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
			: formatWorkflowRun(run));
		return;
	}
	if (parsed.type === "workflow-list") {
		const workflows = hasSshRemote(parsed)
			? await listRemoteWorkflowsForCli(parsed)
			: await listWorkflows({ cwd: parsed.workbenchRoot });
		write(parsed.json
			? `${JSON.stringify({ workflows }, null, parsed.pretty ? 2 : 0)}\n`
			: formatWorkflowList(workflows));
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
			WORKBENCH_FUNCTIONS_LIST_METHOD,
			{},
			parsed,
		) as WorkbenchFunctionsListResponse;
		write(parsed.json
			? `${JSON.stringify(response, null, parsed.pretty ? 2 : 0)}\n`
			: formatFunctionsList(response.functions));
		return;
	}
	if (parsed.type === "functions-describe") {
		const response = await callToybox(
			WORKBENCH_FUNCTIONS_DESCRIBE_METHOD,
			{ name: parsed.name },
			parsed,
		) as WorkbenchFunctionsDescribeResponse;
		write(parsed.json
			? `${JSON.stringify(response, null, parsed.pretty ? 2 : 0)}\n`
			: formatFunctionDescription(response.function));
		return;
	}
	if (parsed.type === "functions-call") {
		const response = await callToybox(
			WORKBENCH_FUNCTIONS_CALL_METHOD,
			{
				name: parsed.name,
				params: await readParams(parsed.paramsText, parsed.paramsFile),
			},
			parsed,
		) as WorkbenchFunctionsCallResponse;
		write(parsed.json
			? `${JSON.stringify(response, null, parsed.pretty ? 2 : 0)}\n`
			: `${JSON.stringify(response.result, null, 2)}\n`);
		return;
	}
	if (parsed.type === "feed-doctor") {
		const result = hasSshRemote(parsed)
			? await callToybox(FEED_DOCTOR_METHOD, compactUndefined({
				mode: parsed.mode,
				feedRoot: parsed.feedRoot,
			}), parsed) as FeedDoctorInfo
			: await collectFeedDoctorInfo(await createFeedContext({
				root: parsed.feedRoot,
				mode: parsed.mode,
			}));
		write(parsed.json
			? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
			: formatFeedDoctorInfo(result));
		return;
	}
	if (parsed.type === "feed-source-list") {
		const sources = hasSshRemote(parsed)
			? (record(await callToybox(FEED_SOURCE_LIST_METHOD, compactUndefined({
				mode: parsed.mode,
				feedRoot: parsed.feedRoot,
			}), parsed)).sources ?? []) as FeedSource[]
			: (await loadFeedConfig(await createFeedContext({
				root: parsed.feedRoot,
				mode: parsed.mode,
			}))).sources;
		write(parsed.json
			? `${JSON.stringify({ sources }, null, parsed.pretty ? 2 : 0)}\n`
			: formatFeedSourceList(sources));
		return;
	}
	if (parsed.type === "feed-poll") {
		const result = hasSshRemote(parsed)
			? await callToybox(FEED_POLL_METHOD, compactUndefined({
				mode: parsed.mode,
				feedRoot: parsed.feedRoot,
				sourceId: parsed.sourceId,
			}), parsed) as FeedPollResult
			: await pollFeedSources(
				await createFeedContext({
					root: parsed.feedRoot,
					mode: parsed.mode,
				}),
				await loadFeedConfig(await createFeedContext({
					root: parsed.feedRoot,
					mode: parsed.mode,
				})),
				{ sourceId: parsed.sourceId },
			);
		write(parsed.json
			? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
			: formatFeedPollResult(result));
		return;
	}
	if (parsed.type === "feed-item-list") {
		const result = hasSshRemote(parsed)
			? await callToybox(FEED_ITEM_LIST_METHOD, compactUndefined({
				mode: parsed.mode,
				feedRoot: parsed.feedRoot,
				sourceId: parsed.sourceId,
				status: parsed.status,
				limit: parsed.limit,
			}), parsed)
			: {
				items: await listFeedItems(
					await createFeedContext({
						root: parsed.feedRoot,
						mode: parsed.mode,
					}),
					{
						sourceId: parsed.sourceId,
						status: parsed.status,
						limit: parsed.limit,
					},
				),
			};
		const items = (record(result).items ?? []) as FeedItem[];
		write(parsed.json
			? `${JSON.stringify({ items }, null, parsed.pretty ? 2 : 0)}\n`
			: formatFeedItemList(items));
		return;
	}
	if (parsed.type === "feed-item-read") {
		const item = hasSshRemote(parsed)
			? record(await callToybox(FEED_ITEM_READ_METHOD, compactUndefined({
				mode: parsed.mode,
				feedRoot: parsed.feedRoot,
				id: parsed.itemId,
			}), parsed)).item as FeedItem
			: await readFeedItem(
				await createFeedContext({
					root: parsed.feedRoot,
					mode: parsed.mode,
				}),
				parsed.itemId,
			);
		write(parsed.json
			? `${JSON.stringify({ item }, null, parsed.pretty ? 2 : 0)}\n`
			: `${JSON.stringify(item, null, 2)}\n`);
		return;
	}
	if (parsed.type === "feed-item-append") {
		const params = {
			...record(await readParams(parsed.paramsText, parsed.paramsFile)),
			sourceId: parsed.sourceId,
		};
		const result = hasSshRemote(parsed)
			? await callToybox(FEED_ITEM_APPEND_METHOD, compactUndefined({
				...params,
				mode: parsed.mode,
				feedRoot: parsed.feedRoot,
			}), parsed) as FeedAppendItemResult
			: await appendFeedItem(
				await createFeedContext({
					root: parsed.feedRoot,
					mode: parsed.mode,
				}),
				feedAppendItemOptionsFromParams(params),
			);
		write(parsed.json
			? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
			: formatFeedAppendResult(result));
		return;
	}
	if (parsed.type === "feed-collect") {
		const result = hasSshRemote(parsed)
			? await callToybox(FEED_COLLECT_METHOD, compactUndefined({
				mode: parsed.mode,
				feedRoot: parsed.feedRoot,
				cursor: parsed.cursor,
				sourceId: parsed.sourceId,
				status: parsed.status,
				limit: parsed.limit,
				advance: parsed.advance,
			}), parsed) as FeedCollectResult
			: await collectFeedItems(
				await createFeedContext({
					root: parsed.feedRoot,
					mode: parsed.mode,
				}),
				{
					cursor: parsed.cursor,
					sourceId: parsed.sourceId,
					status: parsed.status,
					limit: parsed.limit,
					advance: parsed.advance,
				},
			);
		write(parsed.json
			? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
			: formatFeedCollectResult(result));
		return;
	}
	if (parsed.type === "feed-cursor-advance") {
		const result = hasSshRemote(parsed)
			? await callToybox(FEED_CURSOR_ADVANCE_METHOD, compactUndefined({
				mode: parsed.mode,
				feedRoot: parsed.feedRoot,
				cursor: parsed.cursor,
				itemId: parsed.itemId,
			}), parsed) as FeedAdvanceCursorResult
			: await advanceFeedCursor(
				await createFeedContext({
					root: parsed.feedRoot,
					mode: parsed.mode,
				}),
				{
					cursor: parsed.cursor,
					itemId: parsed.itemId,
				},
			);
		writeJson(result, parsed.pretty);
		return;
	}
	if (parsed.type === "feed-dispatch") {
		const result = hasSshRemote(parsed)
			? await callToybox(FEED_DISPATCH_METHOD, compactUndefined({
				mode: parsed.mode,
				feedRoot: parsed.feedRoot,
				cursor: parsed.cursor,
				sourceId: parsed.sourceId,
				target: parsed.target,
				limit: parsed.limit,
				poll: parsed.poll,
			}), parsed) as FeedDispatchResult
			: await dispatchFeedItems(
				await createFeedContext({
					root: parsed.feedRoot,
					mode: parsed.mode,
				}),
				await loadFeedConfig(await createFeedContext({
					root: parsed.feedRoot,
					mode: parsed.mode,
				})),
				{
					cursor: parsed.cursor,
					sourceId: parsed.sourceId,
					target: parsed.target,
					limit: parsed.limit,
					poll: parsed.poll,
					runTarget: async (target, event) =>
						await runFeedDispatchTarget(target, event, parsed),
				},
			);
		write(parsed.json
			? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
			: formatFeedDispatchResult(result));
		if (result.status === "failed") {
			process.exitCode = 1;
		}
		return;
	}
	if (parsed.type === "feed-prune") {
		const result = hasSshRemote(parsed)
			? await callToybox(FEED_PRUNE_METHOD, compactUndefined({
				mode: parsed.mode,
				feedRoot: parsed.feedRoot,
				olderThanDays: parsed.olderThanDays,
				dryRun: parsed.dryRun,
			}), parsed) as FeedPruneResult
			: await pruneFeedItems(
				await createFeedContext({
					root: parsed.feedRoot,
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
	if (parsed.type === "host-overview") {
		writeJson(await callToybox(HOST_OVERVIEW_METHOD, {}, parsed), parsed.pretty);
		return;
	}
	if (parsed.type === "turn-run") {
		const result = await startRemoteTurn({
			prompt: parsed.prompt,
			threadId: parsed.threadId,
			cwd: parsed.cwd,
			via: "workbench",
			appUrl: parsed.appUrl,
			workbenchUrl: parsed.workbenchUrl,
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
				codexUrl: result.codexUrl,
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
	if (parsed.type === "workbench-methods") {
		const initialized = await initializeToybox(parsed);
		writeJson({
			advertised: initialized.capabilities.toyboxMethods,
			common: COMMON_TOYBOX_METHODS,
		}, parsed.pretty);
		return;
	}
	if (parsed.type === "workbench-doctor") {
		const context = await createWorkbenchContext({
			workbenchRoot: parsed.workbenchRoot,
			mode: parsed.mode,
		});
		const info = await collectWorkbenchDoctorInfo(context);
		const runtimeTransport = await collectRuntimeTransportInfo({
			appUrl: parsed.appUrl,
			workbenchUrl: parsed.workbenchUrl,
			timeoutMs: parsed.timeoutMs,
			sshTarget: parsed.sshTarget,
			cwd: parsed.cwd,
			remotePathPrepend: parsed.remotePathPrepend,
			toyboxCommand: parsed.toyboxCommand,
			remoteCodexCommand: parsed.remoteCodexCommand,
			remoteCodexArgs: parsed.remoteCodexArgs,
		});
		const result = { ...info, runtimeTransport };
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: `${formatWorkbenchDoctorInfo(info)}runtime            ${runtimeTransportLabelForDoctor(runtimeTransport)}\n`);
		return;
	}
	if (parsed.type === "workbench-overview") {
		const overview = await callToybox(
			WORKBENCH_OVERVIEW_METHOD,
			compactUndefined({
				mode: parsed.mode,
				workbenchRoot: parsed.workbenchRoot,
			}),
			parsed,
		) as WorkbenchOverview;
		write(parsed.json
			? `${JSON.stringify(overview, null, parsed.pretty ? 2 : 0)}\n`
			: formatWorkbenchOverview(overview));
		return;
	}
		if (parsed.type === "workbench-run") {
			const context = await createWorkbenchContext({
				workbenchRoot: parsed.workbenchRoot,
				mode: parsed.mode,
		});
		const run = await withToyboxRequest(parsed, async (request) =>
			await runWorkbenchTaskById(context, parsed.taskId, {
				callToybox: request,
				workflowCwd: parsed.cwd,
			})
		);
		writeJson({
			run,
			actionsCommit: await commitActionsWorkbenchState(context, {
				message: `Update Codex workbench state for ${parsed.taskId}`,
			}),
			}, parsed.pretty);
			return;
		}
		if (parsed.type === "workbench-prompt-enqueue") {
			validateWorkflowTurnOptions(parsed);
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
					workbenchRoot: parsed.workbenchRoot,
				}), parsed)
				: {
					intent: await enqueuePromptQueueIntent(
						await createWorkbenchContext({
							workbenchRoot: parsed.workbenchRoot,
							mode: parsed.mode,
						}),
						params,
					),
				};
			writeJson(result, parsed.pretty);
			return;
		}
		if (parsed.type === "workbench-prompt-list") {
			if (hasSshRemote(parsed)) {
				const result = await callToybox("promptQueue.list", compactUndefined({
					status: parsed.status,
					queue: parsed.queue,
					limit: parsed.limit,
					mode: parsed.mode,
					workbenchRoot: parsed.workbenchRoot,
				}), parsed);
				write(parsed.json
					? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
					: formatPromptQueueList((record(result).intents ?? []) as DispatchRunIntent[]));
				return;
			}
			const context = await createWorkbenchContext({
				workbenchRoot: parsed.workbenchRoot,
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
		if (parsed.type === "workbench-prompt-read") {
			const result = hasSshRemote(parsed)
				? await callToybox("promptQueue.read", compactUndefined({
					id: parsed.intentId,
					includeOutput: parsed.includeOutput,
					mode: parsed.mode,
					workbenchRoot: parsed.workbenchRoot,
				}), parsed)
				: await readDispatchRun(
					await createWorkbenchContext({
						workbenchRoot: parsed.workbenchRoot,
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
		if (parsed.type === "workbench-prompt-collect") {
			const result = hasSshRemote(parsed)
				? await callToybox("promptQueue.collect", compactUndefined({
					cursor: parsed.cursor,
					queue: parsed.queue,
					mode: parsed.mode,
					workbenchRoot: parsed.workbenchRoot,
				}), parsed)
				: await collectPromptQueueRuns(
					await createWorkbenchContext({
						workbenchRoot: parsed.workbenchRoot,
						mode: parsed.mode,
					}),
					{ cursor: parsed.cursor, queue: parsed.queue },
				);
			write(parsed.json
				? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
				: `${JSON.stringify(result, null, 2)}\n`);
			return;
		}
		if (parsed.type === "workbench-prompt-cancel") {
			const result = hasSshRemote(parsed)
				? await callToybox("promptQueue.cancel", compactUndefined({
					id: parsed.intentId,
					mode: parsed.mode,
					workbenchRoot: parsed.workbenchRoot,
				}), parsed)
				: {
					intent: await cancelDispatchRunIntent(
						await createWorkbenchContext({
							workbenchRoot: parsed.workbenchRoot,
							mode: parsed.mode,
						}),
						parsed.intentId,
					),
				};
			writeJson(result, parsed.pretty);
			return;
		}
		if (parsed.type === "workbench-prompt-retry") {
			const result = hasSshRemote(parsed)
				? await callToybox("promptQueue.retry", compactUndefined({
					id: parsed.intentId,
					runAt: parsed.runAt,
					mode: parsed.mode,
					workbenchRoot: parsed.workbenchRoot,
				}), parsed)
				: await retryDispatchRunIntent(
					await createWorkbenchContext({
						workbenchRoot: parsed.workbenchRoot,
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
		if (parsed.type === "workbench-prompt-run-due") {
			const result = hasSshRemote(parsed)
				? await callToybox("promptQueue.runDue", compactUndefined({
					queue: parsed.queue,
					limit: parsed.limit,
					mode: parsed.mode,
					workbenchRoot: parsed.workbenchRoot,
				}), parsed)
				: await withToyboxRequest(parsed, async (request) =>
					await runDuePromptQueueIntents(
						await createWorkbenchContext({
							workbenchRoot: parsed.workbenchRoot,
							mode: parsed.mode,
						}),
						{
							queue: parsed.queue,
							limit: parsed.limit,
							callToybox: request,
							workflowCwd: parsed.cwd,
						},
					)
				);
			writeJson(result, parsed.pretty);
			return;
		}
		if (parsed.type === "workbench-handoff-enqueue") {
			validateWorkflowTurnOptions(parsed);
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
					workbenchRoot: parsed.workbenchRoot,
				}), parsed)
				: {
					intent: await enqueueLocalHandoffIntent(
						await createWorkbenchContext({
							workbenchRoot: parsed.workbenchRoot,
							mode: parsed.mode,
						}),
						params,
					),
				};
			writeJson(result, parsed.pretty);
			return;
		}
		if (parsed.type === "workbench-handoff-list") {
			if (hasSshRemote(parsed)) {
				const result = await callToybox("localHandoff.list", compactUndefined({
					status: parsed.status,
					queue: parsed.queue,
					targetHost: parsed.targetHost,
					capabilities: parsed.capabilities.length > 0 ? parsed.capabilities : undefined,
					limit: parsed.limit,
					mode: parsed.mode,
					workbenchRoot: parsed.workbenchRoot,
				}), parsed);
				write(parsed.json
					? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
					: formatLocalHandoffList((record(result).intents ?? []) as DispatchRunIntent[]));
				return;
			}
			const context = await createWorkbenchContext({
				workbenchRoot: parsed.workbenchRoot,
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
		if (parsed.type === "workbench-handoff-read") {
			const result = hasSshRemote(parsed)
				? await callToybox("localHandoff.read", compactUndefined({
					id: parsed.intentId,
					includeOutput: parsed.includeOutput,
					mode: parsed.mode,
					workbenchRoot: parsed.workbenchRoot,
				}), parsed)
				: await readDispatchRun(
					await createWorkbenchContext({
						workbenchRoot: parsed.workbenchRoot,
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
		if (parsed.type === "workbench-handoff-collect") {
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
					workbenchRoot: parsed.workbenchRoot,
				}), parsed)
				: await collectLocalHandoffRuns(
					await createWorkbenchContext({
						workbenchRoot: parsed.workbenchRoot,
						mode: parsed.mode,
					}),
					options,
				);
			write(parsed.json
				? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
				: `${JSON.stringify(result, null, 2)}\n`);
			return;
		}
		if (parsed.type === "workbench-handoff-cancel") {
			const result = hasSshRemote(parsed)
				? await callToybox("localHandoff.cancel", compactUndefined({
					id: parsed.intentId,
					mode: parsed.mode,
					workbenchRoot: parsed.workbenchRoot,
				}), parsed)
				: {
					intent: await cancelDispatchRunIntent(
						await createWorkbenchContext({
							workbenchRoot: parsed.workbenchRoot,
							mode: parsed.mode,
						}),
						parsed.intentId,
					),
				};
			writeJson(result, parsed.pretty);
			return;
		}
		if (parsed.type === "workbench-handoff-retry") {
			const result = hasSshRemote(parsed)
				? await callToybox("localHandoff.retry", compactUndefined({
					id: parsed.intentId,
					runAt: parsed.runAt,
					mode: parsed.mode,
					workbenchRoot: parsed.workbenchRoot,
				}), parsed)
				: await retryDispatchRunIntent(
					await createWorkbenchContext({
						workbenchRoot: parsed.workbenchRoot,
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
		if (parsed.type === "workbench-handoff-drain") {
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
					workbenchRoot: parsed.workbenchRoot,
				}), parsed)
				: await withToyboxRequest(parsed, async (request) =>
					await drainLocalHandoffQueue(
						await createWorkbenchContext({
							workbenchRoot: parsed.workbenchRoot,
							mode: parsed.mode,
						}),
						{
							...drainParams,
							callToybox: request,
							workflowCwd: parsed.cwd,
						},
					)
				);
			writeJson(result, parsed.pretty);
			return;
		}
		if (parsed.type === "workbench-dispatch-create") {
		const params = await readParams(parsed.paramsText, parsed.paramsFile);
		const result = hasSshRemote(parsed)
			? await callToybox("dispatch.create", compactUndefined({
				...record(params),
				mode: parsed.mode,
				workbenchRoot: parsed.workbenchRoot,
			}), parsed)
			: {
				intent: await createDispatchRunIntent(
					await createWorkbenchContext({
						workbenchRoot: parsed.workbenchRoot,
						mode: parsed.mode,
					}),
					params,
				),
			};
		writeJson(result, parsed.pretty);
		return;
	}
	if (parsed.type === "workbench-dispatch-list") {
		if (hasSshRemote(parsed)) {
			const result = await callToybox("dispatch.list", compactUndefined({
				mode: parsed.mode,
				workbenchRoot: parsed.workbenchRoot,
			}), parsed);
			write(parsed.json
				? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
				: formatDispatchRunList((record(result).intents ?? []) as DispatchRunIntent[]));
			return;
		}
		const context = await createWorkbenchContext({
			workbenchRoot: parsed.workbenchRoot,
			mode: parsed.mode,
		});
		const intents = await listDispatchRunIntents(context);
		write(parsed.json
			? `${JSON.stringify({ intents }, null, parsed.pretty ? 2 : 0)}\n`
			: formatDispatchRunList(intents));
		return;
	}
	if (parsed.type === "workbench-dispatch-read") {
		const result = hasSshRemote(parsed)
			? await callToybox("dispatch.read", compactUndefined({
				id: parsed.intentId,
				includeOutput: parsed.includeOutput,
				mode: parsed.mode,
				workbenchRoot: parsed.workbenchRoot,
			}), parsed)
			: await readDispatchRun(
				await createWorkbenchContext({
					workbenchRoot: parsed.workbenchRoot,
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
	if (parsed.type === "workbench-dispatch-collect") {
		const result = hasSshRemote(parsed)
			? await callToybox("dispatch.collect", compactUndefined({
				cursor: parsed.cursor,
				mode: parsed.mode,
				workbenchRoot: parsed.workbenchRoot,
			}), parsed)
			: await collectDispatchRuns(
				await createWorkbenchContext({
					workbenchRoot: parsed.workbenchRoot,
					mode: parsed.mode,
				}),
				{ cursor: parsed.cursor },
			);
		write(parsed.json
			? `${JSON.stringify(result, null, parsed.pretty ? 2 : 0)}\n`
			: `${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	if (parsed.type === "workbench-dispatch-cancel") {
		const result = hasSshRemote(parsed)
			? await callToybox("dispatch.cancel", compactUndefined({
				id: parsed.intentId,
				mode: parsed.mode,
				workbenchRoot: parsed.workbenchRoot,
			}), parsed)
			: {
				intent: await cancelDispatchRunIntent(
					await createWorkbenchContext({
						workbenchRoot: parsed.workbenchRoot,
						mode: parsed.mode,
					}),
					parsed.intentId,
				),
			};
		writeJson(result, parsed.pretty);
		return;
	}
	if (parsed.type === "workbench-dispatch-retry") {
		const result = hasSshRemote(parsed)
			? await callToybox("dispatch.retry", compactUndefined({
				id: parsed.intentId,
				runAt: parsed.runAt,
				mode: parsed.mode,
				workbenchRoot: parsed.workbenchRoot,
			}), parsed)
			: await retryDispatchRunIntent(
				await createWorkbenchContext({
					workbenchRoot: parsed.workbenchRoot,
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
	if (parsed.type === "workbench-dispatch-run-due") {
		const result = hasSshRemote(parsed)
			? await callToybox("dispatch.runDue", compactUndefined({
				mode: parsed.mode,
				workbenchRoot: parsed.workbenchRoot,
			}), parsed)
			: await withToyboxRequest(parsed, async (request) =>
				await runDueDispatchRuns(
					await createWorkbenchContext({
						workbenchRoot: parsed.workbenchRoot,
						mode: parsed.mode,
					}),
					{
						callToybox: request,
						workflowCwd: parsed.cwd,
					},
				)
			);
		writeJson(result, parsed.pretty);
		return;
	}
	if (parsed.type === "workbench-dispatch-prune") {
		const result = hasSshRemote(parsed)
			? await callToybox("dispatch.prune", compactUndefined({
				mode: parsed.mode,
				workbenchRoot: parsed.workbenchRoot,
				olderThanDays: parsed.olderThanDays,
				dryRun: parsed.dryRun,
			}), parsed)
			: await pruneDispatchRunHistory(
				await createWorkbenchContext({
					workbenchRoot: parsed.workbenchRoot,
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
	if (parsed.type === "workbench-init-actions") {
		writeJson(await scaffoldActionsWorkbench({
			workbenchRoot: parsed.workbenchRoot,
			forgejo: parsed.forgejo,
			github: parsed.github,
			runnerImage: parsed.runnerImage,
			overwrite: parsed.overwrite,
		}), parsed.pretty);
		return;
	}
	if (parsed.type === "workbench-call") {
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
	if (parsed.type === "workbench-app-call") {
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
		const context = await createWorkbenchContext({
			workbenchRoot: parsed.workbenchRoot,
			mode: "actions",
		});
		writeJson(await prepareActionsCodexAuth({
			workbenchRoot: context.repoRoot,
			env: process.env,
		}), parsed.pretty);
		return;
	}
	if (parsed.type === "actions-cleanup") {
		const context = await createWorkbenchContext({
			workbenchRoot: parsed.workbenchRoot,
			mode: "actions",
		});
		writeJson(await cleanupActionsCodexHome({
			workbenchRoot: context.repoRoot,
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
	if (parsed.type === "kit-inspect") {
		const inspection = await inspectKitSource(parsed);
		write(parsed.json
			? `${JSON.stringify(inspection, null, 2)}\n`
			: formatKitInspection(inspection));
		return;
	}
	if (parsed.type === "kit-add") {
		const plan = await applyKitAdd(parsed);
		write(parsed.json
			? `${JSON.stringify(plan, null, 2)}\n`
			: formatKitAddPlan(plan));
		return;
	}
	if (parsed.type === "kit-setup") {
		const preflight = await planKitAdd({
			source: parsed.source,
			ref: parsed.ref,
			workbenchRoot: parsed.workbenchRoot,
			overwrite: parsed.overwrite,
		});
		if (!hasSetupSkillItem(preflight)) {
			throw new Error("kit setup requires the kit to include skills/setup/SKILL.md.");
		}
		const conflicts = conflictCount(preflight);
		if (conflicts > 0) {
			throw new Error(
				`kit setup found ${conflicts} conflict(s); rerun kit add to inspect them or use --overwrite.`,
			);
		}
		const plan = await applyKitAdd({
			source: parsed.source,
			ref: parsed.ref,
			workbenchRoot: parsed.workbenchRoot,
			apply: true,
			overwrite: parsed.overwrite,
		});
		const setupPrompt = buildKitSetupPrompt({
			source: parsed.source,
			workbenchRoot: plan.workbenchRoot,
			operatorPrompt: parsed.prompt,
		});
		const turn = await startRemoteTurn({
			prompt: setupPrompt,
			cwd: plan.workbenchRoot,
			via: "workbench",
			appUrl: parsed.appUrl,
			workbenchUrl: parsed.workbenchUrl,
			timeoutMs: parsed.timeoutMs,
			wait: parsed.wait,
			sandbox: parsed.sandbox,
			approvalPolicy: parsed.approvalPolicy,
			permissions: parsed.permissions,
			model: parsed.model,
		});
		write(parsed.json
			? `${JSON.stringify({
				plan,
				prompt: setupPrompt,
				turn: {
					threadId: turn.threadId,
					codexUrl: turn.codexUrl,
					turnId: turn.turnId,
					status: turn.status,
					cwd: turn.cwd ?? plan.workbenchRoot,
					finalMessage: turn.finalMessage,
					error: turn.error,
				},
			}, null, parsed.pretty ? 2 : 0)}\n`
			: formatKitSetupResult({ plan, turn }));
		if (parsed.wait && (turn.status === "failed" || turn.status === "timed_out")) {
			process.exitCode = 1;
		}
		return;
	}
	if (parsed.type === "kit-doctor") {
		const result = await collectKitDoctor(parsed);
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: formatKitDoctor(result));
		return;
	}
	if (parsed.type === "kit-list") {
		const result = await listInstalledKits(parsed);
		write(parsed.json
			? `${JSON.stringify(result, null, 2)}\n`
			: formatKitList(result));
		return;
	}
}

function runtimeTransportLabelForDoctor(runtimeTransport: FetchRuntimeTransportInfo): string {
	if (runtimeTransport.status === "connected") {
		return runtimeTransport.url
			? `${runtimeTransport.transport} connected (${runtimeTransport.url})`
			: `${runtimeTransport.transport} connected`;
	}
	return runtimeTransport.error ? `unavailable (${runtimeTransport.error})` : "unavailable";
}

function formatFeedSourceList(sources: FeedSource[]): string {
	if (sources.length === 0) {
		return "No feed sources configured.\n";
	}
	return `${sources.map((source) => {
		const enabled = source.enabled ? "enabled" : "disabled";
		return `${source.id} [${source.kind}, ${enabled}] ${source.url}`;
	}).join("\n")}\n`;
}

function formatFeedPollResult(result: FeedPollResult): string {
	if (result.runs.length === 0) {
		return "No feed sources polled.\n";
	}
	return `${result.runs.map((run) =>
		`${run.sourceId} ${run.status}: ${run.newItemCount} new, ${run.duplicateItemCount} duplicate, ${run.parsedItemCount} parsed`
	).join("\n")}\n`;
}

function formatFeedItemList(items: FeedItem[]): string {
	if (items.length === 0) {
		return "No feed items found.\n";
	}
	return `${items.map((item) => {
		const when = item.publishedAt ?? item.updatedAt ?? item.observedAt;
		const link = item.url ? ` ${item.url}` : "";
		return `${item.id} [${item.sourceId}] ${when} ${item.title}${link}`;
	}).join("\n")}\n`;
}

function formatFeedAppendResult(result: FeedAppendItemResult): string {
	const status = result.appended ? "appended" : "duplicate";
	const when = result.item.publishedAt ?? result.item.updatedAt ?? result.item.observedAt;
	return `${status} ${result.item.id} [${result.item.sourceId}] ${when} ${result.item.title}\n`;
}

function formatFeedCollectResult(result: FeedCollectResult): string {
	return [
		`cursor             ${result.cursor}`,
		`advanced           ${result.advanced ? "yes" : "no"}`,
		`items              ${result.items.length}`,
		...result.items.map((item) => {
			const when = item.publishedAt ?? item.updatedAt ?? item.observedAt;
			return `${item.id} [${item.sourceId}] ${when} ${item.title}`;
		}),
	].join("\n") + "\n";
}

function formatFeedDispatchResult(result: FeedDispatchResult): string {
	return [
		`status             ${result.status}`,
		`cursor             ${result.cursor}`,
		`source             ${result.sourceId}`,
		`target             ${result.target}`,
		`items              ${result.collect.items.length}`,
		`executions         ${result.executions.length}`,
		...result.executions.map((execution) =>
			`${execution.itemId} ${execution.status}${execution.error ? `: ${execution.error}` : ""}`
		),
	].join("\n") + "\n";
}

async function runFeedDispatchTarget(
	target: string,
	event: ReturnType<typeof toFeedEvent>,
	parsed: Extract<ParsedCli, { type: "feed-dispatch" }>,
): Promise<unknown> {
	const prefix = "workbench-task:";
	if (!target.startsWith(prefix)) {
		throw new Error(`Unsupported feed dispatch target: ${target}`);
	}
	const taskId = target.slice(prefix.length);
	if (!taskId) {
		throw new Error("feed dispatch workbench-task target requires a task id");
	}
	const context = await createWorkbenchContext({
		workbenchRoot: parsed.feedRoot,
		mode: parsed.mode,
	});
	const run = await withToyboxRequest(parsed, async (request) =>
		await runWorkbenchTaskById(context, taskId, {
			callToybox: request,
			workflowCwd: parsed.cwd,
			event,
		})
	);
	if (run.status === "failed") {
		throw new Error(run.error ?? `Workbench task ${taskId} failed`);
	}
	return { workbenchRun: run };
}

function formatWorkbenchOverview(overview: WorkbenchOverview): string {
	const lines = [
		`workbench          ${overview.workbench.repoRoot}`,
		`mode               ${overview.workbench.mode}`,
		`config             ${overview.workbench.config.exists ? "found" : "missing"} ${overview.workbench.config.path}`,
		`health             ${overview.health.ok ? "ok" : "attention"}`,
		`dispatch           ${overview.dispatch.summary.total} total, ${overview.dispatch.summary.due} due, ${overview.dispatch.summary.running} running, ${overview.dispatch.summary.failed} failed`,
		`workflows        ${overview.workflows.ok ? overview.workflows.total : `error: ${overview.workflows.error}`}`,
		`functions          ${overview.functions.ok ? overview.functions.total : `error: ${overview.functions.error}`}`,
		`threads            ${overview.threads.ok ? `${overview.threads.total} recent for cwd` : `error: ${overview.threads.error}`}`,
		`git                ${overview.git.ok && overview.git.isRepo ? `${overview.git.branch ?? "unknown"} ${overview.git.commit ?? ""}${overview.git.dirty ? " dirty" : ""}` : overview.git.error ?? "not a git repo"}`,
	];
	if (overview.dispatch.latest) {
		lines.push(`latest dispatch    ${overview.dispatch.latest.status} ${overview.dispatch.latest.id} ${overview.dispatch.latest.updatedAt}`);
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

async function listRemoteWorkflowsForCli(
	options: {
		workbenchRoot?: string;
		cwd?: string;
		timeoutMs: number;
	} & SshRemoteProviderOptions,
): Promise<RemoteWorkflowListResponse["workflows"]> {
	return await withSshRemoteToyboxTransport(options, async (transport) => {
		await initialize(transport);
		const response = await transport.request<RemoteWorkflowListResponse>(
			REMOTE_WORKFLOW_LIST_METHOD,
			{
				workbenchRoot: options.workbenchRoot,
				cwd: options.cwd,
			},
		);
		return response.workflows;
	});
}

async function runRemoteWorkflowForCli(
	options: {
		target?: string;
		scriptPath?: string;
		scriptStdin?: boolean;
		eventPath?: string;
		prompt?: string;
		workbenchRoot?: string;
		cwd?: string;
		via: "workbench" | "app";
		timeoutMs: number;
		sandbox?: RemoteWorkflowRunParams["sandbox"];
		approvalPolicy?: RemoteWorkflowRunParams["approvalPolicy"];
		permissions?: string;
		model?: string;
	} & SshRemoteProviderOptions,
): Promise<WorkflowRun> {
	const script = options.scriptStdin ? await readStdin() : undefined;
	return await withSshRemoteToyboxTransport(options, async (transport) => {
		await initialize(transport);
		return await transport.request<WorkflowRun>(
			REMOTE_WORKFLOW_RUN_METHOD,
			{
				target: options.target,
				scriptPath: options.scriptPath,
				script,
				eventPath: options.eventPath,
				prompt: options.prompt,
				workbenchRoot: options.workbenchRoot,
				cwd: options.cwd,
				via: options.via,
				timeoutMs: options.timeoutMs,
				sandbox: options.sandbox,
				approvalPolicy: options.approvalPolicy,
				permissions: options.permissions,
				model: options.model,
			} satisfies RemoteWorkflowRunParams,
		);
	});
}

function validateWorkflowTurnOptions(options: {
	sandbox?: string;
	permissions?: string;
}): void {
	if (options.sandbox && options.permissions) {
		throw new Error("--sandbox cannot be combined with --permissions");
	}
}

function formatFunctionsList(functions: WorkbenchFunctionMetadata[]): string {
	if (functions.length === 0) {
		return "No workbench functions found.\n";
	}
	return `${functions.map((fn) => {
		const suffix = fn.description ? ` - ${fn.description}` : "";
		return `${fn.name} [${fn.sideEffects}]${suffix}`;
	}).join("\n")}\n`;
}

function formatFunctionDescription(fn: WorkbenchFunctionMetadata): string {
	return `${JSON.stringify(fn, null, 2)}\n`;
}

async function runWorkflowForCli(
	target: WorkflowRunTarget,
	options: {
		event?: unknown;
		prompt?: string;
		cwd?: string;
		via: "workbench" | "app";
		appUrl: string;
		workbenchUrl: string;
		timeoutMs: number;
		sandbox?: RemoteWorkflowRunParams["sandbox"];
		approvalPolicy?: RemoteWorkflowRunParams["approvalPolicy"];
		permissions?: string;
		model?: string;
	} & SshRemoteProviderOptions,
): Promise<WorkflowRun> {
	const host = createCliWorkflowHost({
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
		return await runWorkflowScript({
			scriptPath: target.scriptPath,
			script: target.script,
			workflow: target.workflow,
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

function createCliWorkflowHost(
	options: {
		via: "workbench" | "app";
		appUrl: string;
		workbenchUrl: string;
		timeoutMs: number;
		defaults: {
			prompt?: string;
			cwd?: string;
			skills?: string[];
			sandbox?: RemoteWorkflowRunParams["sandbox"];
			approvalPolicy?: RemoteWorkflowRunParams["approvalPolicy"];
			permissions?: string;
			model?: string;
		};
	} & SshRemoteProviderOptions,
): { handler: WorkflowHostHandler; close(): void } {
	if (options.via === "workbench") {
		const requester = createLazyWorkbenchRequester({
			...options,
			url: options.workbenchUrl,
		});
		return {
			handler: createWorkflowHost({
				via: "workbench",
				appRequest: requester.appRequest,
				workbenchRequest: requester.workbenchRequest,
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
		handler: createWorkflowHost({
			via: "app-server",
			appRequest: requester.request,
			defaults: options.defaults,
		}),
		close: requester.close,
	};
}

function createLazyAppServerRequester(
	options: { url: string; timeoutMs: number } & SshRemoteProviderOptions,
): { request: WorkflowBackendRequest; close(): void } {
	const requester = createLazyWorkbenchRequester(options);
	return {
		request: requester.appRequest,
		close: requester.close,
	};
}

function createLazyWorkbenchRequester(
	options: { url: string; timeoutMs: number } & SshRemoteProviderOptions,
): {
	appRequest: WorkflowBackendRequest;
	workbenchRequest: WorkflowBackendRequest;
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
		workbenchRequest: async (method, params) =>
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
	return await withWorkbenchTransport(options, async (transport) =>
		await initialize(transport)
	);
}

async function callToybox(
	method: string,
	params: unknown,
	options: { url: string; timeoutMs: number } & SshRemoteProviderOptions,
): Promise<unknown> {
	return await withWorkbenchTransport(options, async (transport) => {
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
	return await withWorkbenchTransport(options, async (transport) => {
		await initialize(transport);
		return await callback(async (method, params) =>
			await transport.request(method, params)
		);
	});
}

async function withWorkbenchTransport<T>(
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

async function collectRuntimeTransportInfo(options: {
	appUrl: string;
	workbenchUrl: string;
	timeoutMs: number;
} & SshRemoteProviderOptions): Promise<FetchRuntimeTransportInfo> {
	if (hasSshRemote(options)) {
		return await collectSshRuntimeTransportInfo(options);
	}
	return await collectLocalRuntimeTransportInfo(options);
}

async function collectSshRuntimeTransportInfo(
	options: {
		appUrl: string;
		workbenchUrl: string;
		timeoutMs: number;
	} & SshRemoteProviderOptions,
): Promise<FetchRuntimeTransportInfo> {
	try {
		return await withSshRemoteToyboxTransport(options, async (transport) =>
			await collectRuntimeTransportInfoFromTransport(
				transport,
				"ssh://runtime",
				"ssh",
				options.timeoutMs,
			)
		);
	} catch (error) {
		return {
			transport: "ssh",
			status: "unavailable",
			error: `runtime: ${errorMessage(error)}`,
		};
	}
}

async function collectLocalRuntimeTransportInfo(options: {
	timeoutMs: number;
}): Promise<FetchRuntimeTransportInfo> {
	const transport = createLocalToyboxTransport(options);
	transport.on("error", () => {});
	try {
		transport.start();
		return await collectRuntimeTransportInfoFromTransport(
			transport,
			"runtime://local",
			"local",
			options.timeoutMs,
		);
	} catch (error) {
		return {
			transport: "local",
			status: "unavailable",
			url: "runtime://local",
			error: errorMessage(error),
		};
	} finally {
		transport.close();
	}
}

async function collectRuntimeTransportInfoFromTransport(
	transport: CodexToyboxTransport,
	url: string,
	runtimeTransport: FetchRuntimeTransportInfo["transport"],
	timeoutMs: number,
): Promise<FetchRuntimeTransportInfo> {
	return await withProbeTimeout(async () => {
		const initialized = await initialize(transport);
		const threads = await collectThreadsViaWorkbench(transport);
		return {
			transport: runtimeTransport,
			status: "connected",
			url,
			server: initialized.serverInfo,
			capabilities: {
				methods: initialized.capabilities.toyboxMethods.length,
			},
			threads,
		};
	}, timeoutMs, `runtime probe timed out after ${timeoutMs}ms`);
}

async function collectThreadsViaWorkbench(
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

	function formatDispatchRunList(intents: DispatchRunIntent[]): string {
		if (intents.length === 0) {
			return "No dispatch runs found.\n";
	}
	return intents.map((intent) => [
		intent.id,
		intent.status,
		intent.runAt,
		dispatchTargetLabel(intent.target),
	].join("  ")).join("\n") + "\n";
}

function dispatchTargetLabel(target: DispatchRunIntent["target"]): string {
	if (target.kind === "workbench-task") {
		return `workbench-task:${target.taskId}`;
	}
	if (target.kind === "workflow") {
		return `workflow:${target.workflow}`;
	}
		return "turn";
	}

	function formatPromptQueueList(intents: DispatchRunIntent[]): string {
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

	function promptQueueLabel(intent: DispatchRunIntent): string {
		const source = record(intent.source);
		const queue = stringValue(source.queue) ?? "default";
		const title = stringValue(source.title);
		if (title) {
			return `${queue}:${title}`;
		}
		return queue;
	}

	function formatLocalHandoffList(intents: DispatchRunIntent[]): string {
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

	function localHandoffLabel(intent: DispatchRunIntent): string {
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

async function serveRuntimeHttp(options: {
	cwd?: string;
	sshTarget?: string;
	staticDir?: string;
	host: string;
	port: number;
	timeoutMs: number;
	toyboxCommand?: string;
	remoteCodexCommand?: string;
	remoteCodexArgs?: string[];
}): Promise<void> {
	const handler = createCodexToysProxyHandler({
		cwd: options.cwd,
		sshTarget: options.sshTarget,
		staticDir: options.staticDir,
		timeoutMs: options.timeoutMs,
		toyboxCommand: options.toyboxCommand,
		remoteCodexCommand: options.remoteCodexCommand,
		remoteCodexArgs: options.remoteCodexArgs,
		apiBasePath: "/api",
	});
	const server = http.createServer((request, response) => {
		void handler(request, response).catch((error: unknown) => {
			response.statusCode = 500;
			response.setHeader("content-type", "application/json; charset=utf-8");
			response.end(`${JSON.stringify({ error: errorMessage(error) })}\n`);
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(options.port, options.host, resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : options.port;
	process.stderr.write(`codex-toys runtime http listening on http://${options.host}:${port}\n`);
	await new Promise<void>((resolve) => {
		server.once("close", resolve);
	});
}

function write(text: string): void {
	process.stdout.write(text);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
