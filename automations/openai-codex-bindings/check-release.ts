type AutomationContext = {
	event?: {
		type?: string;
		payload?: Record<string, unknown>;
	};
	prompt?: string;
	cwd?: string;
	turn: {
		start(params: {
			id?: string;
			prompt: string;
			cwd?: string;
		}): Promise<{
			threadId: string;
			turnId: string;
		}>;
	};
};

export default async function checkRelease(context: AutomationContext) {
	const payload = context.event?.payload ?? {};
	if (payload.repo !== "openai/codex") {
		return {
			status: "skipped",
			reason: "release is not for openai/codex",
		};
	}
	if (typeof payload.tag !== "string" || payload.tag.length === 0) {
		return {
			status: "skipped",
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
	const turn = await context.turn.start({
		id: "binding-check",
		cwd: context.cwd,
		prompt: lines.join("\n"),
	});
	return {
		status: "started",
		message: `Started openai/codex binding check for ${payload.tag}.`,
		turn,
	};
}
