import { AgentHarness, type HarnessProvider } from "@codex-appkit/harness";

const provider = providerFrom(process.env.AGENT_PROVIDER ?? "");
const prompt = process.argv.slice(2).join(" ") || "Inspect this repository and summarize the next useful action.";
const harness = new AgentHarness();

const run = await harness.run({
	provider,
	prompt,
	cwd: process.cwd(),
	onEvent: (event) => console.log(JSON.stringify(event)),
});

console.log(JSON.stringify({
	type: "run.started",
	provider: run.provider,
	sessionId: run.sessionId,
	runId: run.runId,
}));

function providerFrom(value: string): HarnessProvider {
	if (value === "codex" || value === "claude") {
		return value;
	}
	throw new Error("Set AGENT_PROVIDER to codex or claude before running this example.");
}
