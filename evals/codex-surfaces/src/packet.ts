import path from "node:path";
import type { Profile, RunManifest, Scenario } from "./types.ts";
import { scenarioTargetCwd } from "./manifests.ts";
import { DEFAULT_RUNS_DIR, REPO_ROOT, ensureDir, runId, writeJsonFile } from "./util.ts";

export type PacketResult = {
	manifest: RunManifest;
	packetText: string;
	packetPath: string;
	manifestPath: string;
};

export async function createTaskPacket(options: {
	scenario: Scenario;
	profile: Profile;
	outDir?: string;
	now?: Date;
}): Promise<PacketResult> {
	if (options.profile.kind !== "native-app") {
		throw new Error(`packet is only for native App profiles, got ${options.profile.id}`);
	}
	const now = options.now ?? new Date();
	const id = runId(options.scenario.id, options.profile.id, now);
	const runDir = path.resolve(options.outDir ?? path.join(DEFAULT_RUNS_DIR, id));
	await ensureDir(runDir);
	const targetCwd = scenarioTargetCwd(options.scenario);
	const manifest: RunManifest = {
		id,
		scenarioId: options.scenario.id,
		profileId: options.profile.id,
		profileKind: options.profile.kind,
		status: "created",
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		repoRoot: REPO_ROOT,
		targetCwd,
		runDir,
		packetPath: path.join(runDir, "packet.md"),
		notes: ["Run this packet in Codex App, then ingest the resulting session JSONL."],
	};
	const packetText = renderTaskPacket(options.scenario, options.profile, manifest);
	const packetPath = path.join(runDir, "packet.md");
	const manifestPath = path.join(runDir, "run.json");
	await BunSafe.writeText(packetPath, packetText);
	await writeJsonFile(manifestPath, manifest);
	return { manifest, packetText, packetPath, manifestPath };
}

export function renderTaskPacket(scenario: Scenario, profile: Profile, manifest: RunManifest): string {
	const checklist = [
		...(profile.taskPacket?.operatorInstructions ?? []),
		...(scenario.nativePacket?.checklist ?? []),
	];
	const hints = [
		...profile.affordances,
		...(scenario.nativePacket?.affordanceHints ?? []),
	];
	return [
		`# Codex Surface Eval Packet: ${scenario.title}`,
		"",
		`Run id: \`${manifest.id}\``,
		`Scenario: \`${scenario.id}\``,
		`Profile: \`${profile.id}\` (${profile.label})`,
		`Target cwd: \`${manifest.targetCwd}\``,
		"",
		"## Goal",
		"",
		scenario.description,
		"",
		"## Prompt To Run",
		"",
		"```text",
		scenario.prompt,
		"```",
		"",
		"## Available Surface",
		"",
		`- Native Codex App lane: ${profile.toysEnabled ? "with codex-toys affordances" : "native App only"}.`,
		"- Use the real Codex App workflow for this profile; do not translate this into a `codex exec` run.",
		...hints.map((hint) => `- ${hint}`),
		"",
		"## Operator Checklist",
		"",
		...(checklist.length > 0 ? checklist.map((item) => `- ${item}`) : ["- Run the prompt in the Codex App and let the App use its native tools."]),
		"- After the run, save or locate the session rollout JSONL.",
		`- Ingest it with: \`vp exec tsx evals/codex-surfaces/run.ts ingest --manifest ${path.relative(REPO_ROOT, path.join(manifest.runDir, "run.json"))} --session-jsonl <path>\``,
		"",
		"## Oracle Hints",
		"",
		...scenario.oracle.map((oracle) => `- ${oracle.type}`),
		"",
	].join("\n");
}

class BunSafe {
	static async writeText(filePath: string, text: string): Promise<void> {
		const { mkdir, writeFile } = await import("node:fs/promises");
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, text);
	}
}
