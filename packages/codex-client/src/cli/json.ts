import { readFile } from "node:fs/promises";

export function parseJsonText(text: string, label = "JSON"): unknown {
	try {
		return JSON.parse(stripJsonBom(text)) as unknown;
	} catch (error) {
		throw new Error(`Failed to parse ${label}: ${errorMessage(error)}`);
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
