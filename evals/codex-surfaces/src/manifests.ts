import path from "node:path";
import type { Profile, ProfileKind, Scenario } from "./types.ts";
import {
	EVAL_ROOT,
	REPO_ROOT,
	listJsonFiles,
	optionalNumber,
	optionalString,
	readJsonFile,
	record,
	resolveEvalPath,
} from "./util.ts";

export async function loadScenarios(root = EVAL_ROOT): Promise<Scenario[]> {
	const files = await listJsonFiles(path.join(root, "scenarios"));
	return await Promise.all(files.map(async (file) => validateScenario(await readJsonFile(file), file)));
}

export async function loadProfiles(root = EVAL_ROOT): Promise<Profile[]> {
	const files = await listJsonFiles(path.join(root, "profiles"));
	return await Promise.all(files.map(async (file) => validateProfile(await readJsonFile(file), file)));
}

export async function loadScenario(id: string, root = EVAL_ROOT): Promise<Scenario> {
	const scenarios = await loadScenarios(root);
	const scenario = scenarios.find((entry) => entry.id === id);
	if (!scenario) {
		throw new Error(`Unknown scenario: ${id}`);
	}
	return scenario;
}

export async function loadProfile(id: string, root = EVAL_ROOT): Promise<Profile> {
	const profiles = await loadProfiles(root);
	const profile = profiles.find((entry) => entry.id === id);
	if (!profile) {
		throw new Error(`Unknown profile: ${id}`);
	}
	return profile;
}

export function scenarioTargetCwd(scenario: Scenario): string {
	return resolveEvalPath(scenario.targetCwd ?? "@", REPO_ROOT);
}

function validateScenario(value: unknown, source: string): Scenario {
	const input = record(value);
	const id = requiredString(input.id, "scenario id", source);
	if (id.includes(" ")) {
		throw new Error(`${source}: scenario id must be slug-like`);
	}
	const oracle = Array.isArray(input.oracle) ? input.oracle : [];
	return {
		id,
		title: requiredString(input.title, "scenario title", source),
		description: requiredString(input.description, "scenario description", source),
		prompt: requiredString(input.prompt, "scenario prompt", source),
		targetCwd: optionalString(input.targetCwd),
		timeoutMs: optionalNumber(input.timeoutMs),
		permissions: permissions(input.permissions),
		tags: stringArray(input.tags),
		expectedArtifacts: stringArray(input.expectedArtifacts),
		nativePacket: {
			checklist: stringArray(record(input.nativePacket).checklist),
			affordanceHints: stringArray(record(input.nativePacket).affordanceHints),
		},
		oracle: oracle.map((entry, index) => {
			const item = record(entry);
			const type = requiredString(item.type, `oracle[${index}].type`, source);
			if (![
				"finalTextIncludes",
				"finalTextMatches",
				"eventTypeSeen",
				"eventMethodSeen",
				"commandSeen",
				"fileExists",
				"jsonPathEquals",
			].includes(type)) {
				throw new Error(`${source}: unsupported oracle type ${type}`);
			}
			return entry as Scenario["oracle"][number];
		}),
	};
}

function validateProfile(value: unknown, source: string): Profile {
	const input = record(value);
	const kind = requiredString(input.kind, "profile kind", source);
	if (kind !== "closed-app-server" && kind !== "native-app") {
		throw new Error(`${source}: unsupported profile kind ${kind}`);
	}
	const codexHomeMode = requiredString(input.codexHomeMode, "profile codexHomeMode", source);
	if (codexHomeMode !== "global" && codexHomeMode !== "repo-local" && codexHomeMode !== "operator-app") {
		throw new Error(`${source}: unsupported codexHomeMode ${codexHomeMode}`);
	}
	return {
		id: requiredString(input.id, "profile id", source),
		label: requiredString(input.label, "profile label", source),
		kind: kind as ProfileKind,
		description: requiredString(input.description, "profile description", source),
		toysEnabled: Boolean(input.toysEnabled),
		codexHomeMode,
		affordances: stringArray(input.affordances),
		promptAddendum: optionalString(input.promptAddendum),
		appServer: input.appServer ? {
			codexCommand: optionalString(record(input.appServer).codexCommand),
			args: stringArray(record(input.appServer).args),
			env: stringRecord(record(input.appServer).env),
			requestTimeoutMs: optionalNumber(record(input.appServer).requestTimeoutMs),
		} : undefined,
		taskPacket: {
			operatorInstructions: stringArray(record(input.taskPacket).operatorInstructions),
		},
	};
}

function requiredString(value: unknown, label: string, source: string): string {
	const text = optionalString(value);
	if (!text?.trim()) {
		throw new Error(`${source}: missing ${label}`);
	}
	return text;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function permissions(value: unknown): Scenario["permissions"] {
	const input = record(value);
	return {
		sandbox: optionalString(input.sandbox),
		approvalPolicy: optionalString(input.approvalPolicy),
		permissions: optionalString(input.permissions),
	};
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	const entries = Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string");
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
