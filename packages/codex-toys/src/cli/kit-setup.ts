import { formatKitAddPlan, type KitAddPlan } from "@codex-toys/kits";
import { formatRemoteTurnStartResult, type RemoteTurnStartResult } from "@codex-toys/remote";

export const setupSkillRelativePath = ".agents/skills/setup/SKILL.md";

export function buildKitSetupPrompt(options: {
	source: string;
	workbenchRoot: string;
	operatorPrompt?: string;
}): string {
	const lines = [
		"You are setting up this Codex workbench from an installed workbench kit.",
		`Workbench root: ${options.workbenchRoot}`,
		`Kit source: ${options.source}`,
		"",
		`If ${setupSkillRelativePath} exists, use that setup skill before doing any other work in this repository.`,
		"Follow the setup skill exactly. Invoke only the shipped scripts and resources under .agents/skills/setup.",
		"Use those shipped files for setup, validation, retirement, and teardown.",
		"Do not create, generate, or substitute validation scripts.",
		"Run setup, run validation with JSON output, and retire the setup skill only after validation passes.",
		"Report the receipt path, validation result, and any remaining manual steps.",
	];
	if (options.operatorPrompt) {
		lines.push("", "Additional operator instructions:", options.operatorPrompt);
	}
	return `${lines.join("\n")}\n`;
}

export function hasSetupSkillItem(plan: KitAddPlan): boolean {
	return plan.items.some((item) => item.kind === "skill" && item.name === "setup");
}

export function conflictCount(plan: KitAddPlan): number {
	return plan.items.filter((item) => item.action === "conflict").length;
}

export function formatKitSetupResult(options: {
	plan: KitAddPlan;
	turn: RemoteTurnStartResult;
}): string {
	return [
		formatKitAddPlan(options.plan).trimEnd(),
		"",
		"setup skill          .agents/skills/setup",
		formatRemoteTurnStartResult(options.turn).trimEnd(),
		"",
	].join("\n");
}
