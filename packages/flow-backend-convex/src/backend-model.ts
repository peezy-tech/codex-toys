import type { FlowEvent } from "@peezy.tech/codex-flows/flow-runtime";
import type { DispatchConvexFlowEventResult, SyncedFlowManifest } from "./types.ts";

export type StoredFlowRunInput = {
	eventId: string;
	flowName: string;
	stepName: string;
	replayNonce?: string;
};

export function flowRunId(input: StoredFlowRunInput): string {
	return [
		"run",
		safeId(input.eventId),
		safeId(input.flowName),
		safeId(input.stepName),
		...(input.replayNonce ? [safeId(input.replayNonce), "replay"] : []),
	].join(":");
}

export function normalizeFlowEvent(value: unknown): FlowEvent {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") {
		throw new Error("FlowEvent requires string id and type");
	}
	return {
		receivedAt: typeof value.receivedAt === "string" ? value.receivedAt : new Date().toISOString(),
		payload: "payload" in value ? value.payload : {},
		...value,
	} as FlowEvent;
}

export function matchingManifestSteps(
	manifests: SyncedFlowManifest[],
	event: FlowEvent,
): Array<{ manifest: SyncedFlowManifest; step: SyncedFlowManifest["steps"][number] }> {
	const matches: Array<{ manifest: SyncedFlowManifest; step: SyncedFlowManifest["steps"][number] }> = [];
	for (const manifest of manifests) {
		for (const step of manifest.steps) {
			if (step.trigger?.type === event.type) {
				matches.push({ manifest, step });
			}
		}
	}
	return matches;
}

export function duplicateDispatchResult(eventId: string, runIds: string[]): DispatchConvexFlowEventResult {
	return {
		status: "duplicate",
		eventId,
		runIds,
		matched: 0,
	};
}

export function acceptedDispatchResult(
	eventId: string,
	runIds: string[],
	matched: number,
): DispatchConvexFlowEventResult {
	return {
		status: "accepted",
		eventId,
		runIds,
		matched,
	};
}

export function clampLimit(value: number | undefined): number {
	if (!value || !Number.isFinite(value)) {
		return 50;
	}
	return Math.max(1, Math.min(500, Math.trunc(value)));
}

export function leaseMs(value: number | undefined): number {
	return Math.max(10_000, Math.min(value ?? 120_000, 30 * 60_000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeId(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "item"
	);
}
