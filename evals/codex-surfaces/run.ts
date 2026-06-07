#!/usr/bin/env tsx
import path from "node:path";
import { createTaskPacket } from "./src/packet.ts";
import { formatReport, loadRunResults } from "./src/report.ts";
import { resultFromSessionJsonl } from "./src/result.ts";
import { runClosedAppServer } from "./src/runner.ts";
import type { RunManifest } from "./src/types.ts";
import { loadProfile, loadProfiles, loadScenario, loadScenarios } from "./src/manifests.ts";
import { EVAL_ROOT, DEFAULT_RUNS_DIR, readJsonFile } from "./src/util.ts";

type CliArgs = {
	command: string;
	flags: Map<string, string | boolean>;
};

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.command === "list") {
		await listCommand();
		return;
	}
	if (args.command === "run") {
		await runCommand(args);
		return;
	}
	if (args.command === "packet") {
		await packetCommand(args);
		return;
	}
	if (args.command === "ingest") {
		await ingestCommand(args);
		return;
	}
	if (args.command === "report") {
		await reportCommand(args);
		return;
	}
	usage(args.command ? `Unknown command: ${args.command}` : undefined);
}

async function listCommand(): Promise<void> {
	const [scenarios, profiles] = await Promise.all([loadScenarios(), loadProfiles()]);
	console.log("Scenarios:");
	for (const scenario of scenarios) {
		console.log(`  ${scenario.id}\t${scenario.title}`);
	}
	console.log("");
	console.log("Profiles:");
	for (const profile of profiles) {
		console.log(`  ${profile.id}\t${profile.kind}\t${profile.label}`);
	}
}

async function runCommand(args: CliArgs): Promise<void> {
	const scenario = await loadScenario(requiredFlag(args, "scenario"));
	const profile = await loadProfile(requiredFlag(args, "profile"));
	if (profile.kind !== "closed-app-server") {
		throw new Error(`Profile ${profile.id} is native-App mediated; use the packet command and then ingest the completed session.`);
	}
	const result = await runClosedAppServer({
		scenario,
		profile,
		outDir: optionalFlag(args, "out"),
	});
	console.log(JSON.stringify(result, null, "\t"));
}

async function packetCommand(args: CliArgs): Promise<void> {
	const scenario = await loadScenario(requiredFlag(args, "scenario"));
	const profile = await loadProfile(requiredFlag(args, "profile"));
	const packet = await createTaskPacket({
		scenario,
		profile,
		outDir: optionalFlag(args, "out"),
	});
	console.log(`Packet: ${path.relative(process.cwd(), packet.packetPath)}`);
	console.log(`Manifest: ${path.relative(process.cwd(), packet.manifestPath)}`);
}

async function ingestCommand(args: CliArgs): Promise<void> {
	const manifestPath = path.resolve(requiredFlag(args, "manifest"));
	const manifest = await readJsonFile<RunManifest>(manifestPath);
	const scenario = await loadScenario(manifest.scenarioId);
	const profile = await loadProfile(manifest.profileId);
	const result = await resultFromSessionJsonl({
		scenario,
		profile,
		manifest: {
			...manifest,
			runDir: path.resolve(path.dirname(manifestPath)),
			packetPath: manifest.packetPath ? path.resolve(path.dirname(manifestPath), path.basename(manifest.packetPath)) : undefined,
		},
		sessionJsonl: path.resolve(requiredFlag(args, "session-jsonl")),
	});
	console.log(JSON.stringify(result, null, "\t"));
}

async function reportCommand(args: CliArgs): Promise<void> {
	const runsDir = optionalFlag(args, "runs") ? path.resolve(requiredFlag(args, "runs")) : DEFAULT_RUNS_DIR;
	const results = await loadRunResults(runsDir);
	if (args.flags.has("json")) {
		console.log(JSON.stringify(results, null, "\t"));
		return;
	}
	console.log(formatReport(results));
}

function parseArgs(argv: string[]): CliArgs {
	const [command = "", ...rest] = argv;
	const flags = new Map<string, string | boolean>();
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		if (!arg?.startsWith("--")) {
			usage(`Unexpected argument: ${arg}`);
		}
		const key = arg.slice(2);
		const next = rest[index + 1];
		if (!next || next.startsWith("--")) {
			flags.set(key, true);
			continue;
		}
		flags.set(key, next);
		index += 1;
	}
	return { command, flags };
}

function requiredFlag(args: CliArgs, key: string): string {
	const value = args.flags.get(key);
	if (typeof value !== "string" || !value.trim()) {
		usage(`Missing --${key}`);
	}
	return value;
}

function optionalFlag(args: CliArgs, key: string): string | undefined {
	const value = args.flags.get(key);
	return typeof value === "string" ? value : undefined;
}

function usage(error?: string): never {
	if (error) {
		console.error(error);
	}
	console.error(`Usage:
  vp exec tsx ${path.relative(process.cwd(), path.join(EVAL_ROOT, "run.ts"))} list
  vp exec tsx ${path.relative(process.cwd(), path.join(EVAL_ROOT, "run.ts"))} run --scenario <id> --profile <closed-profile> [--out <dir>]
  vp exec tsx ${path.relative(process.cwd(), path.join(EVAL_ROOT, "run.ts"))} packet --scenario <id> --profile <native-profile> [--out <dir>]
  vp exec tsx ${path.relative(process.cwd(), path.join(EVAL_ROOT, "run.ts"))} ingest --manifest <run.json> --session-jsonl <path>
  vp exec tsx ${path.relative(process.cwd(), path.join(EVAL_ROOT, "run.ts"))} report [--runs <dir>] [--json]`);
	process.exit(2);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
