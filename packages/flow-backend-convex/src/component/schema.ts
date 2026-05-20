import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const flowStep = v.object({
	name: v.string(),
	runner: v.union(v.literal("node"), v.literal("code-mode")),
	script: v.string(),
	timeoutMs: v.number(),
	cwd: v.optional(v.string()),
	trigger: v.optional(
		v.object({
			type: v.string(),
			schema: v.optional(v.string()),
			schemaJson: v.optional(v.any()),
		}),
	),
});

export const flowEventArg = v.object({
	id: v.string(),
	type: v.string(),
	source: v.optional(v.string()),
	occurredAt: v.optional(v.string()),
	receivedAt: v.optional(v.string()),
	payload: v.any(),
});

export const flowStepArg = flowStep;

export default defineSchema({
	flowManifests: defineTable({
		name: v.string(),
		version: v.number(),
		description: v.optional(v.string()),
		root: v.optional(v.string()),
		config: v.optional(v.any()),
		steps: v.array(flowStep),
		syncedAt: v.number(),
		updatedAt: v.number(),
	}).index("by_name", ["name"]),

	flowEvents: defineTable({
		eventId: v.string(),
		type: v.string(),
		source: v.optional(v.string()),
		occurredAt: v.optional(v.string()),
		receivedAt: v.string(),
		payload: v.any(),
		raw: v.any(),
		createdAt: v.number(),
	})
		.index("by_event_id", ["eventId"])
		.index("by_type_created", ["type", "createdAt"]),

	flowRuns: defineTable({
		runId: v.string(),
		eventId: v.string(),
		flowName: v.string(),
		flowVersion: v.number(),
		stepName: v.string(),
		runner: v.union(v.literal("node"), v.literal("code-mode")),
		status: v.union(
			v.literal("queued"),
			v.literal("running"),
			v.literal("completed"),
			v.literal("failed"),
			v.literal("canceled"),
		),
		attemptCount: v.number(),
		latestAttemptId: v.optional(v.string()),
		result: v.optional(v.any()),
		error: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
		startedAt: v.optional(v.number()),
		completedAt: v.optional(v.number()),
	})
		.index("by_run_id", ["runId"])
		.index("by_event_id", ["eventId"])
		.index("by_status_created", ["status", "createdAt"]),

	flowRunAttempts: defineTable({
		attemptId: v.string(),
		runId: v.string(),
		eventId: v.string(),
		flowName: v.string(),
		stepName: v.string(),
		attemptNumber: v.number(),
		status: v.union(
			v.literal("running"),
			v.literal("completed"),
			v.literal("failed"),
			v.literal("canceled"),
		),
		workerId: v.string(),
		leaseToken: v.string(),
		leaseExpiresAt: v.number(),
		lastHeartbeatAt: v.number(),
		transcriptStreamId: v.optional(v.string()),
		result: v.optional(v.any()),
		error: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
		completedAt: v.optional(v.number()),
	})
		.index("by_attempt_id", ["attemptId"])
		.index("by_run_id", ["runId"])
		.index("by_status_lease", ["status", "leaseExpiresAt"]),

	flowOutputEvents: defineTable({
		attemptId: v.string(),
		runId: v.string(),
		kind: v.union(
			v.literal("system"),
			v.literal("stdout"),
			v.literal("stderr"),
			v.literal("agent"),
		),
		text: v.string(),
		createdAt: v.number(),
	})
		.index("by_attempt", ["attemptId", "createdAt"])
		.index("by_run", ["runId", "createdAt"]),
});
