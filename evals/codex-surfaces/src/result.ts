import path from "node:path";
import type { NormalizedEvent, Profile, RunManifest, RunResult, Scenario } from "./types.ts";
import { aggregateTokenUsage, finalTextFromEvents, normalizeRawEvents, runMetrics } from "./events.ts";
import { evaluateOracles } from "./oracle.ts";
import { errorMessage, readJsonl, writeJsonFile, writeJsonl } from "./util.ts";

export async function buildRunResult(options: {
	scenario: Scenario;
	profile: Profile;
	manifest: RunManifest;
	rawEvents: unknown[];
	startedAt: Date;
	completedAt?: Date;
	error?: unknown;
	rawEventsPath?: string;
	normalizedEventsPath?: string;
	packetPath?: string;
}): Promise<{ result: RunResult; events: NormalizedEvent[] }> {
	const completedAt = options.completedAt ?? new Date();
	const events = normalizeRawEvents(options.rawEvents);
	const finalText = finalTextFromEvents(events);
	const oracle = await evaluateOracles(options.scenario.oracle, {
		cwd: options.manifest.targetCwd,
		finalText,
		events,
	});
	const errored = options.error ? errorMessage(options.error) : undefined;
	const result: RunResult = {
		id: options.manifest.id,
		scenarioId: options.scenario.id,
		profileId: options.profile.id,
		status: errored ? "error" : oracle.status === "passed" ? "passed" : "failed",
		createdAt: options.startedAt.toISOString(),
		completedAt: completedAt.toISOString(),
		elapsedMs: Math.max(0, completedAt.getTime() - options.startedAt.getTime()),
		tokenUsage: aggregateTokenUsage(events),
		metrics: runMetrics(events),
		finalText,
		oracle,
		artifacts: {
			manifest: path.join(options.manifest.runDir, "run.json"),
			rawEvents: options.rawEventsPath,
			normalizedEvents: options.normalizedEventsPath,
			packet: options.packetPath,
		},
		error: errored,
	};
	return { result, events };
}

export async function writeRunArtifacts(options: {
	manifest: RunManifest;
	rawEvents: unknown[];
	events: NormalizedEvent[];
	result: RunResult;
}): Promise<void> {
	await writeJsonl(path.join(options.manifest.runDir, "raw-events.jsonl"), options.rawEvents);
	await writeJsonl(path.join(options.manifest.runDir, "normalized-events.jsonl"), options.events);
	await writeJsonFile(path.join(options.manifest.runDir, "result.json"), options.result);
	await writeJsonFile(path.join(options.manifest.runDir, "run.json"), {
		...options.manifest,
		status: options.result.status === "error" ? "failed" : "completed",
		updatedAt: options.result.completedAt,
	});
}

export async function resultFromSessionJsonl(options: {
	scenario: Scenario;
	profile: Profile;
	manifest: RunManifest;
	sessionJsonl: string;
}): Promise<RunResult> {
	const rawEvents = await readJsonl(options.sessionJsonl);
	const manifest = {
		...options.manifest,
		sessionJsonl: options.sessionJsonl,
		status: "completed" as const,
		updatedAt: new Date().toISOString(),
	};
	const { result, events } = await buildRunResult({
		scenario: options.scenario,
		profile: options.profile,
		manifest,
		rawEvents,
		startedAt: new Date(options.manifest.createdAt),
		rawEventsPath: path.join(manifest.runDir, "raw-events.jsonl"),
		normalizedEventsPath: path.join(manifest.runDir, "normalized-events.jsonl"),
		packetPath: manifest.packetPath,
	});
	await writeRunArtifacts({ manifest, rawEvents, events, result });
	return result;
}
