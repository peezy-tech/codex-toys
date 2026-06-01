import { readFile } from "node:fs/promises";

export function parseJsonText(text: string, label = "JSON"): unknown {
	try {
		return JSON.parse(stripJsonBom(text)) as unknown;
	} catch (error) {
		throw new Error(`Failed to parse ${label}: ${errorMessage(error)}`);
	}
}

export function parseJsonParamsText(text: string, label = "JSON params"): unknown {
	try {
		return parseJsonText(text, label);
	} catch (firstError) {
		const repaired = repairPowerShellStrippedJson(text);
		if (repaired !== text) {
			try {
				return parseJsonText(repaired, label);
			} catch {
				// Keep the original parser error; it points at the user's input.
			}
		}
		throw firstError;
	}
}

export async function readJsonFile(
	filePath: string | URL,
	label = String(filePath),
): Promise<unknown> {
	return parseJsonText(await readFile(filePath, "utf8"), label);
}

export function stripJsonBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function repairPowerShellStrippedJson(text: string): string {
	let repaired = stripJsonBom(text).trim();
	if (!repaired.startsWith("{") && !repaired.startsWith("[")) {
		return text;
	}
	repaired = repaired.replace(
		/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$-]*)(\s*:)/g,
		(_, prefix: string, key: string, suffix: string) => `${prefix}${JSON.stringify(key)}${suffix}`,
	);
	repaired = repaired.replace(
		/(:\s*)([^'",{}\[\]\s][^,}\]\r\n]*)(\s*)(?=[,}\]])/g,
		(_, prefix: string, token: string, suffix: string) =>
			`${prefix}${jsonBareToken(token)}${suffix}`,
	);
	repaired = repaired.replace(
		/([\[,]\s*)([^'",{}\[\]\s][^,\]\r\n]*)(\s*)(?=[,\]])/g,
		(_, prefix: string, token: string, suffix: string) =>
			`${prefix}${jsonBareToken(token)}${suffix}`,
	);
	return repaired;
}

function jsonBareToken(token: string): string {
	const value = token.trim();
	if (
		value === "true" ||
		value === "false" ||
		value === "null" ||
		/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
	) {
		return value;
	}
	return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
