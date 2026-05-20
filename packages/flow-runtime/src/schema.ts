import { readFile } from "node:fs/promises";

type JsonSchema = {
	type?: string | string[];
	required?: string[];
	properties?: Record<string, JsonSchema>;
	enum?: unknown[];
};

export type SchemaValidationResult =
	| { ok: true }
	| { ok: false; errors: string[] };

export async function readJsonSchema(path: string): Promise<JsonSchema> {
	const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`Schema must be a JSON object: ${path}`);
	}
	return parsed as JsonSchema;
}

export function validateJsonSchema(value: unknown, schema: JsonSchema): SchemaValidationResult {
	const errors: string[] = [];
	validateValue(value, schema, "$", errors);
	return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateValue(
	value: unknown,
	schema: JsonSchema,
	path: string,
	errors: string[],
): void {
	if (schema.enum && !schema.enum.some((entry) => Object.is(entry, value))) {
		errors.push(`${path} must be one of ${schema.enum.map(String).join(", ")}`);
		return;
	}

	if (schema.type && !typeMatches(value, schema.type)) {
		errors.push(`${path} must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}`);
		return;
	}

	if (schema.type === "object" || (schema.properties && isRecord(value))) {
		if (!isRecord(value)) {
			errors.push(`${path} must be object`);
			return;
		}
		for (const key of schema.required ?? []) {
			if (!(key in value)) {
				errors.push(`${path}.${key} is required`);
			}
		}
		for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
			if (key in value) {
				validateValue(value[key], childSchema, `${path}.${key}`, errors);
			}
		}
	}
}

function typeMatches(value: unknown, type: string | string[]): boolean {
	const types = Array.isArray(type) ? type : [type];
	return types.some((entry) => {
		if (entry === "array") {
			return Array.isArray(value);
		}
		if (entry === "null") {
			return value === null;
		}
		if (entry === "integer") {
			return Number.isInteger(value);
		}
		if (entry === "object") {
			return isRecord(value);
		}
		return typeof value === entry;
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
