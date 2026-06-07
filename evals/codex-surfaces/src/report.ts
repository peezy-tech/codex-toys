import { readdir } from "node:fs/promises";
import path from "node:path";
import type { RunResult } from "./types.ts";
import { DEFAULT_RUNS_DIR, readJsonFile } from "./util.ts";

export async function loadRunResults(runsDir = DEFAULT_RUNS_DIR): Promise<RunResult[]> {
	const files = await resultFiles(runsDir);
	return await Promise.all(files.map(async (file) => await readJsonFile<RunResult>(file)));
}

export function formatReport(results: RunResult[]): string {
	const sorted = [...results].sort((left, right) => left.completedAt.localeCompare(right.completedAt));
	const passed = sorted.filter((result) => result.status === "passed").length;
	const knownTokens = sorted
		.map((result) => result.tokenUsage)
		.filter((usage): usage is Extract<RunResult["tokenUsage"], { status: "known" }> => usage.status === "known");
	const tokenTotal = knownTokens.reduce((sum, usage) => sum + usage.total.totalTokens, 0);
	const lines = [
		"# Codex Surface Eval Report",
		"",
		`Runs: ${sorted.length}`,
		`Passed: ${passed}`,
		`Known token total: ${knownTokens.length > 0 ? tokenTotal : "unknown"}`,
		"",
		"| Run | Scenario | Profile | Status | Tokens | Commands | Tools |",
		"| --- | --- | --- | --- | ---: | ---: | ---: |",
	];
	for (const result of sorted) {
		lines.push([
			result.id,
			result.scenarioId,
			result.profileId,
			result.status,
			result.tokenUsage.status === "known" ? String(result.tokenUsage.total.totalTokens) : "unknown",
			String(result.metrics.commandCount),
			String(result.metrics.toolCallCount),
		].map(tableCell).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
	}
	return `${lines.join("\n")}\n`;
}

async function resultFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...await resultFiles(fullPath));
		} else if (entry.isFile() && entry.name === "result.json") {
			files.push(fullPath);
		}
	}
	return files.sort();
}

function tableCell(value: string): string {
	return value.replaceAll("|", "\\|");
}
