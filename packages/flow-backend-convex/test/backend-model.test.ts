import { expect, test } from "vite-plus/test";
import {
	acceptedDispatchResult,
	duplicateDispatchResult,
	flowRunId,
	matchingManifestSteps,
	normalizeFlowEvent,
} from "../src/backend-model.ts";

test("normalizes generic flow events", () => {
	const event = normalizeFlowEvent({
		id: "event-1",
		type: "pet-game.player_asset_generation.requested",
		payload: { requestId: "request-1" },
	});

	expect(event).toMatchObject({
		id: "event-1",
		type: "pet-game.player_asset_generation.requested",
		payload: { requestId: "request-1" },
	});
	expect(typeof event.receivedAt).toBe("string");
});

test("matches synced manifest steps by event type", () => {
	const matches = matchingManifestSteps(
		[
			{
				name: "player-character-asset",
				version: 1,
				steps: [
					{
						name: "generate",
						runner: "node",
						script: "exec/generate.ts",
						timeoutMs: 1000,
						trigger: { type: "pet-game.player_asset_generation.requested" },
					},
				],
			},
		],
		{
			id: "event-1",
			type: "pet-game.player_asset_generation.requested",
			receivedAt: "2026-05-13T00:00:00.000Z",
			payload: {},
		},
	);

	expect(matches.map((match) => `${match.manifest.name}/${match.step.name}`)).toEqual([
		"player-character-asset/generate",
	]);
});

test("builds stable run ids and dispatch result shapes", () => {
	const first = flowRunId({
		eventId: "event-1",
		flowName: "player-character-asset",
		stepName: "generate",
	});
	const second = flowRunId({
		eventId: "event-1",
		flowName: "player-character-asset",
		stepName: "generate",
	});
	const replay = flowRunId({
		eventId: "event-1",
		flowName: "player-character-asset",
		stepName: "generate",
		replayNonce: "1",
	});

	expect(first).toBe(second);
	expect(replay).not.toBe(first);
	expect(acceptedDispatchResult("event-1", [first], 1)).toEqual({
		status: "accepted",
		eventId: "event-1",
		runIds: [first],
		matched: 1,
	});
	expect(duplicateDispatchResult("event-1", [first])).toEqual({
		status: "duplicate",
		eventId: "event-1",
		runIds: [first],
		matched: 0,
	});
});
