type AutomationContext = {
	event?: {
		type?: string;
		payload?: Record<string, unknown>;
	};
	prompt?: string;
	cwd?: string;
};

export default function checkRelease(context: AutomationContext) {
	const payload = context.event?.payload ?? {};
	if (payload.repo !== "openai/codex") {
		return {
			action: "skip",
			reason: "release is not for openai/codex",
		};
	}
	if (typeof payload.tag !== "string" || payload.tag.length === 0) {
		return {
			action: "skip",
			reason: "release signal did not include payload.tag",
		};
	}
	const lines = [
		context.prompt?.trim() || "Inspect this openai/codex release.",
		"",
		`Release tag: ${payload.tag}`,
		typeof payload.url === "string" ? `Release URL: ${payload.url}` : undefined,
		typeof payload.publishedAt === "string"
			? `Published at: ${payload.publishedAt}`
			: undefined,
		"",
		"Start by checking whether the matching @openai/codex package exists and whether regenerated app-server TypeScript bindings would change this repository.",
	].filter(Boolean);
	return {
		action: "turn",
		cwd: context.cwd,
		prompt: lines.join("\n"),
	};
}
