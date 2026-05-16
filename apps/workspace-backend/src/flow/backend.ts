import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
	discoverFlows,
	matchingSteps,
	type FlowEvent,
	type FlowStep,
	type LoadedFlow,
} from "@peezy.tech/flow-runtime";
import type { FlowBackendConfig } from "./config.ts";
import {
	executeCommand,
	flowCommand,
	flowRunExecutionEnv,
	parseRunnerResult,
} from "./executor.ts";
import { FlowBackendStore, type FlowRunRecord } from "./store.ts";

export type DispatchFlowEventOptions = {
	config: FlowBackendConfig;
	store: FlowBackendStore;
	event: FlowEvent;
	wait?: boolean;
	env?: Record<string, string | undefined>;
	replay?: boolean;
};

export type DispatchFlowEventResult = {
	status: "accepted" | "duplicate";
	eventId: string;
	runIds: string[];
	matched: number;
};

export async function dispatchFlowEvent(options: DispatchFlowEventOptions): Promise<DispatchFlowEventResult> {
	const inserted = options.replay ? false : options.store.insertEvent(options.event);
	if (!inserted && !options.replay) {
		return {
			status: "duplicate",
			eventId: options.event.id,
			runIds: options.store.listRunsByEvent(options.event.id).map((run) => run.id),
			matched: 0,
		};
	}

	const eventPath = await writeEventFile(options.config.dataDir, options.event, options.replay ? "replay" : undefined);
	const flows = await discoverFlows({ cwd: options.config.cwd });
	const matches = await matchingSteps(flows, options.event);
	const promises: Array<Promise<void>> = [];
	const replayNonce = options.replay ? `${Date.now()}:${Math.random()}` : undefined;
	for (const match of matches) {
		const run = createRunRecord(options.config, options.event, match.flow, match.step, eventPath, replayNonce);
		options.store.createRun(run);
		const promise = executeAndRecord({
			config: options.config,
			store: options.store,
			run,
			env: options.env,
		});
		if (options.wait) {
			promises.push(promise);
		} else {
			promise.catch((error) => {
				options.store.markRunCompleted(run.id, {
					status: "failed",
					stdout: "",
					stderr: "",
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}
	}
	if (promises.length > 0) {
		await Promise.all(promises);
	}
	return {
		status: "accepted",
		eventId: options.event.id,
		runIds: matches.map((match) => runId(options.event.id, match.flow.manifest.name, match.step.name, replayNonce)),
		matched: matches.length,
	};
}

export async function replayFlowEvent(options: Omit<DispatchFlowEventOptions, "event" | "replay"> & {
	eventId: string;
}): Promise<DispatchFlowEventResult> {
	const event = options.store.getEvent(options.eventId);
	if (!event) {
		throw new Error(`Unknown event: ${options.eventId}`);
	}
	return dispatchFlowEvent({
		...options,
		event: event.raw,
		replay: true,
	});
}

export async function readFlowEvent(pathValue: string): Promise<FlowEvent> {
	return normalizeFlowEvent(JSON.parse(await Bun.file(path.resolve(pathValue)).text()) as unknown);
}

export function normalizeFlowEvent(value: unknown): FlowEvent {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") {
		throw new Error("FlowEvent requires string id and type");
	}
	return {
		receivedAt: typeof value.receivedAt === "string" ? value.receivedAt : new Date().toISOString(),
		payload: isRecord(value.payload) ? value.payload : {},
		...value,
	} as FlowEvent;
}

async function executeAndRecord(options: {
	config: FlowBackendConfig;
	store: FlowBackendStore;
	run: FlowRunRecord;
	env?: Record<string, string | undefined>;
}): Promise<void> {
	const command = flowCommand({
		config: options.config,
		runId: options.run.id,
		eventId: options.run.eventId,
		eventPath: options.run.eventPath,
		flowName: options.run.flowName,
		stepName: options.run.stepName,
		attemptId: options.run.id,
		replay: options.run.id.endsWith("_replay"),
		workspaceBackendUrl: options.config.workspaceBackendUrl,
		env: options.env,
	});
	options.store.markRunRunning(options.run.id, JSON.stringify(command), command.unit);
	let result: Awaited<ReturnType<typeof executeCommand>>;
	try {
		result = await executeCommand(command, options.config, flowRunExecutionEnv({
			config: options.config,
			runId: options.run.id,
			eventId: options.run.eventId,
			eventPath: options.run.eventPath,
			flowName: options.run.flowName,
			stepName: options.run.stepName,
			attemptId: options.run.id,
			replay: options.run.id.endsWith("_replay"),
			workspaceBackendUrl: options.config.workspaceBackendUrl,
			env: options.env,
		}));
	} catch (error) {
		options.store.markRunCompleted(options.run.id, {
			status: "failed",
			stdout: "",
			stderr: "",
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	const status = result.exitCode === 0 ? "completed" : "failed";
	options.store.markRunCompleted(options.run.id, {
		status,
		resultJson: parseRunnerResult(result.stdout),
		stdout: result.stdout,
		stderr: result.stderr,
		...(status === "failed" ? { error: `flow runner exited with ${result.exitCode ?? "unknown"}` } : {}),
	});
}

function createRunRecord(
	config: FlowBackendConfig,
	event: FlowEvent,
	flow: LoadedFlow,
	step: FlowStep,
	eventPath: string,
	replayNonce?: string,
): FlowRunRecord {
	return {
		id: runId(event.id, flow.manifest.name, step.name, replayNonce),
		eventId: event.id,
		flowName: flow.manifest.name,
		stepName: step.name,
		status: "queued",
		backend: "workspace-local",
		executor: config.executor,
		eventPath,
		createdAt: new Date().toISOString(),
	};
}

function runId(eventId: string, flowName: string, stepName: string, replayNonce?: string): string {
	const hash = createHash("sha256")
		.update(`${eventId}\0${flowName}\0${stepName}${replayNonce ? `\0${replayNonce}` : ""}`)
		.digest("hex")
		.slice(0, 12);
	return replayNonce ? `run_${hash}_replay` : `run_${hash}`;
}

async function writeEventFile(dataDir: string, event: FlowEvent, suffix?: string): Promise<string> {
	const directory = path.join(dataDir, "events");
	await mkdir(directory, { recursive: true });
	const filePath = path.join(directory, `${safeFileName(suffix ? `${event.id}:${suffix}:${Date.now()}` : event.id)}.json`);
	await Bun.write(filePath, JSON.stringify(event, null, 2));
	return filePath;
}

function safeFileName(value: string): string {
	const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
	const base = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
	return `${base || "event"}-${hash}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
