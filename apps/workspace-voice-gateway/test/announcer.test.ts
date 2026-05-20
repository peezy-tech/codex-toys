import { describe, expect, test } from "vite-plus/test";

import {
	TemplateTurnAnnouncer,
	parseAnnouncerDecision,
} from "../src/announcer.ts";

describe("parseAnnouncerDecision", () => {
	test("accepts strict JSON and cleans text", () => {
		expect(parseAnnouncerDecision(JSON.stringify({
			speak: true,
			priority: "high",
			text: "Release check failed. See https://example.com for logs.",
		}))).toEqual({
			speak: true,
			priority: "high",
			text: "Release check failed. See for logs.",
		});
	});

	test("finds JSON inside model wrapper text", () => {
		const decision = parseAnnouncerDecision("```json\n{\"speak\":false,\"text\":\"skip\"}\n```");
		expect(decision).toEqual({
			speak: false,
			priority: "normal",
			text: "skip",
		});
	});
});

describe("TemplateTurnAnnouncer", () => {
	test("speaks failures even without final text", async () => {
		const announcer = new TemplateTurnAnnouncer();
		const decision = await announcer.polish({
			threadId: "thread",
			turnId: "turn",
			status: "failed",
			durationMs: null,
			finalText: "",
			errorMessage: "Tests failed.",
		});
		expect(decision).toMatchObject({
			speak: true,
			priority: "high",
			text: "Workspace turn failed. Tests failed.",
		});
	});

	test("does not mechanically truncate long fallback text", async () => {
		const announcer = new TemplateTurnAnnouncer();
		const finalText = "Completed. ".repeat(80);
		const decision = await announcer.polish({
			threadId: "thread",
			turnId: "turn",
			status: "completed",
			durationMs: null,
			finalText,
			errorMessage: null,
		});
		expect(decision.text).toContain(finalText.trim());
		expect(decision.text).not.toContain("...");
	});
});
