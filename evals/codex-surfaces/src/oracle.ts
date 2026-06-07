import { access } from "node:fs/promises";
import path from "node:path";
import type { NormalizedEvent, OracleCheck, OracleConfig, OracleResult } from "./types.ts";
import { jsonPath, readJsonFile, record, resolveEvalPath } from "./util.ts";

export type OracleContext = {
	cwd: string;
	finalText: string;
	events: NormalizedEvent[];
};

export async function evaluateOracles(configs: OracleConfig[], context: OracleContext): Promise<OracleResult> {
	const checks: OracleCheck[] = [];
	for (const config of configs) {
		checks.push(await evaluateOracle(config, context));
	}
	return {
		status: checks.every((check) => check.passed) ? "passed" : "failed",
		checks,
	};
}

async function evaluateOracle(config: OracleConfig, context: OracleContext): Promise<OracleCheck> {
	if (config.type === "finalTextIncludes") {
		const passed = context.finalText.includes(config.text);
		return check(config.type, passed, passed
			? `final text includes ${JSON.stringify(config.text)}`
			: `final text did not include ${JSON.stringify(config.text)}`);
	}
	if (config.type === "finalTextMatches") {
		const regex = new RegExp(config.pattern, config.flags);
		const passed = regex.test(context.finalText);
		return check(config.type, passed, passed
			? `final text matched /${config.pattern}/${config.flags ?? ""}`
			: `final text did not match /${config.pattern}/${config.flags ?? ""}`);
	}
	if (config.type === "eventTypeSeen") {
		const passed = context.events.some((event) => event.type === config.eventType);
		return check(config.type, passed, passed
			? `saw normalized event ${config.eventType}`
			: `did not see normalized event ${config.eventType}`);
	}
	if (config.type === "eventMethodSeen") {
		const passed = context.events.some((event) => record(event).method === config.method);
		return check(config.type, passed, passed
			? `saw method ${config.method}`
			: `did not see method ${config.method}`);
	}
	if (config.type === "commandSeen") {
		const regex = new RegExp(config.pattern, config.flags);
		const passed = context.events.some((event) => event.type === "command" && regex.test(event.command));
		return check(config.type, passed, passed
			? `saw command matching /${config.pattern}/${config.flags ?? ""}`
			: `did not see command matching /${config.pattern}/${config.flags ?? ""}`);
	}
	if (config.type === "fileExists") {
		const filePath = resolveEvalPath(config.path, context.cwd);
		try {
			await access(filePath);
			return check(config.type, true, `file exists: ${filePath}`);
		} catch {
			return check(config.type, false, `file does not exist: ${filePath}`);
		}
	}
	if (config.type === "jsonPathEquals") {
		const filePath = path.isAbsolute(config.file) ? config.file : path.resolve(context.cwd, config.file);
		const value = jsonPath(await readJsonFile(filePath), config.path);
		const passed = JSON.stringify(value) === JSON.stringify(config.equals);
		return check(config.type, passed, passed
			? `${config.file}.${config.path} matched`
			: `${config.file}.${config.path} was ${JSON.stringify(value)}, expected ${JSON.stringify(config.equals)}`);
	}
	return check("finalTextIncludes", false, `unsupported oracle ${(config as { type: string }).type}`);
}

function check(type: OracleConfig["type"], passed: boolean, message: string): OracleCheck {
	return { type, passed, message };
}
