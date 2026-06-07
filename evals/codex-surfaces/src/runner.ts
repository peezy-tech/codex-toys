import path from "node:path";
import { CodexAppServerClient } from "../../../packages/bridge/src/index.ts";
import type { Profile, RunManifest, RunResult, Scenario } from "./types.ts";
import { scenarioTargetCwd } from "./manifests.ts";
import { buildRunResult, writeRunArtifacts } from "./result.ts";
import { DEFAULT_RUNS_DIR, REPO_ROOT, ensureDir, errorMessage, record, runId, writeJsonFile } from "./util.ts";

export async function runClosedAppServer(options: {
	scenario: Scenario;
	profile: Profile;
	outDir?: string;
	now?: Date;
}): Promise<RunResult> {
	if (options.profile.kind !== "closed-app-server") {
		throw new Error(`run is only automated for closed app-server profiles, got ${options.profile.id}`);
	}
	const startedAt = options.now ?? new Date();
	const id = runId(options.scenario.id, options.profile.id, startedAt);
	const runDir = path.resolve(options.outDir ?? path.join(DEFAULT_RUNS_DIR, id));
	await ensureDir(runDir);
	const targetCwd = scenarioTargetCwd(options.scenario);
	const manifest: RunManifest = {
		id,
		scenarioId: options.scenario.id,
		profileId: options.profile.id,
		profileKind: options.profile.kind,
		status: "running",
		createdAt: startedAt.toISOString(),
		updatedAt: startedAt.toISOString(),
		repoRoot: REPO_ROOT,
		targetCwd,
		runDir,
	};
	await writeJsonFile(path.join(runDir, "run.json"), manifest);
	const rawEvents: unknown[] = [];
	const client = new CodexAppServerClient({
		clientName: "codex-toys-surface-evals",
		clientTitle: "Codex Surface Evals",
		clientVersion: "0.1.0",
		transportOptions: {
			codexCommand: options.profile.appServer?.codexCommand,
			args: options.profile.appServer?.args,
			env: options.profile.appServer?.env,
			cwd: targetCwd,
			requestTimeoutMs: options.profile.appServer?.requestTimeoutMs,
		},
	});
	client.on("notification", (message) => rawEvents.push(message));
	client.on("stderr", (line) => rawEvents.push({ type: "stderr", text: line }));
	let runError: unknown;
	try {
		await client.connect();
		const threadResponse = await client.request("thread/start", threadStartParams(options.scenario, options.profile, targetCwd));
		const threadId = nestedId(threadResponse, "thread", "thread/start");
		manifest.threadId = threadId;
		rawEvents.push({ type: "thread.started", threadId });
		const turnResponse = await client.request("turn/start", turnStartParams(options.scenario, options.profile, threadId, targetCwd));
		const turnId = nestedId(turnResponse, "turn", "turn/start");
		manifest.turnId = turnId;
		rawEvents.push({ type: "turn.started", threadId, turnId });
		await waitForTurnCompleted(client, threadId, turnId, options.scenario.timeoutMs ?? 30 * 60_000);
		const thread = await client.request("thread/read", { threadId, includeTurns: true });
		const turn = findTurn(thread, turnId);
		if (turn) {
			rawEvents.push({ method: "turn/completed", params: { threadId, turn } });
		}
	} catch (error) {
		runError = error;
		rawEvents.push({ type: "error", message: errorMessage(error) });
	} finally {
		client.close();
	}
	const completedAt = new Date();
	const { result, events } = await buildRunResult({
		scenario: options.scenario,
		profile: options.profile,
		manifest,
		rawEvents,
		startedAt,
		completedAt,
		error: runError,
		rawEventsPath: path.join(runDir, "raw-events.jsonl"),
		normalizedEventsPath: path.join(runDir, "normalized-events.jsonl"),
	});
	await writeRunArtifacts({ manifest, rawEvents, events, result });
	return result;
}

function threadStartParams(scenario: Scenario, profile: Profile, cwd: string): Record<string, unknown> {
	return compact({
		cwd,
		ephemeral: false,
		permissions: scenario.permissions?.permissions,
		sandbox: scenario.permissions?.permissions ? undefined : scenario.permissions?.sandbox,
		approvalPolicy: scenario.permissions?.approvalPolicy,
		baseInstructions: profile.toysEnabled ? profile.promptAddendum : undefined,
	});
}

function turnStartParams(scenario: Scenario, profile: Profile, threadId: string, cwd: string): Record<string, unknown> {
	return compact({
		threadId,
		cwd,
		input: [{
			type: "text",
			text: promptForProfile(scenario, profile),
			text_elements: [],
		}],
		permissions: scenario.permissions?.permissions,
		approvalPolicy: scenario.permissions?.approvalPolicy,
	});
}

function promptForProfile(scenario: Scenario, profile: Profile): string {
	if (!profile.toysEnabled || !profile.promptAddendum) {
		return scenario.prompt;
	}
	return `${scenario.prompt}\n\nProfile affordances:\n${profile.promptAddendum}`;
}

function waitForTurnCompleted(
	client: CodexAppServerClient,
	threadId: string,
	turnId: string,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			client.off("notification", onNotification);
			reject(new Error(`Timed out after ${timeoutMs}ms waiting for turn ${turnId}`));
		}, timeoutMs);
		const onNotification = (message: unknown) => {
			const input = record(message);
			if (input.method !== "turn/completed") {
				return;
			}
			const params = record(input.params);
			const turn = record(params.turn);
			if (
				(optionalString(params.threadId) === threadId || !optionalString(params.threadId)) &&
				(optionalString(turn.id) === turnId || optionalString(params.turnId) === turnId)
			) {
				clearTimeout(timer);
				client.off("notification", onNotification);
				resolve();
			}
		};
		client.on("notification", onNotification);
	});
}

function findTurn(threadResponse: unknown, turnId: string): unknown | undefined {
	const thread = record(record(threadResponse).thread ?? threadResponse);
	return Array.isArray(thread.turns)
		? thread.turns.find((turn) => record(turn).id === turnId)
		: undefined;
}

function nestedId(value: unknown, key: string, label: string): string {
	const input = record(value);
	const nested = record(input[key]);
	const id = optionalString(nested.id) ?? optionalString(input.id);
	if (!id) {
		throw new Error(`${label} did not return an id`);
	}
	return id;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
