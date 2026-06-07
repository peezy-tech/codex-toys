import { describe, expect, test } from "vite-plus/test";
import { loadProfiles, loadScenarios } from "../src/manifests.ts";

describe("codex surface eval manifests", () => {
	test("loads the v1 profile matrix", async () => {
		const profiles = await loadProfiles();
		expect(profiles.map((profile) => profile.id).sort()).toEqual([
			"closed-app-server-raw",
			"closed-app-server-toys",
			"native-app",
			"native-app-toys",
		]);
		expect(profiles.filter((profile) => profile.kind === "native-app")).toHaveLength(2);
		expect(profiles.filter((profile) => profile.kind === "closed-app-server")).toHaveLength(2);
	});

	test("loads scenarios for current explicit scheduler/feed surfaces", async () => {
		const scenarios = await loadScenarios();
		expect(scenarios.map((scenario) => scenario.id).sort()).toEqual([
			"codex-state-lookup",
			"feed-to-workflow-dispatch",
			"manual-feed-item-append",
			"scheduler-queue-run-due",
			"workbench-health-triage",
			"workflow-failure-diagnostics",
		]);
		const scheduler = scenarios.find((scenario) => scenario.id === "scheduler-queue-run-due");
		expect(scheduler?.prompt).toContain("workbench dispatch run-due");
		expect(scheduler?.prompt).toContain("does not rely on `workbench tick`");
	});
});
