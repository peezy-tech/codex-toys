export function cleanForSpeech(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " code block ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
		.replace(/https?:\/\/\S+/g, "")
		.replace(/<#[0-9]+>/g, "channel")
		.replace(/<@!?[0-9]+>/g, "user")
		.replace(/<@&[0-9]+>/g, "role")
		.replace(/[*_~>#|]/g, " ")
		.replace(/\b([0-9a-f]{7})[0-9a-f]{6,}\b/gi, "$1")
		.replace(/[ \t\r\n]+/g, " ")
		.trim();
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

export function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}
