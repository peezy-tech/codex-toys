import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { helpText } from "../packages/codex-toys/src/cli/help.ts";

const checks: string[] = [];
const failures: string[] = [];
const root = new URL("..", import.meta.url);
const cache = new Map<string, string>();

async function read(relativePath: string): Promise<string> {
	const cached = cache.get(relativePath);
	if (cached !== undefined) {
		return cached;
	}
	const text = await readFile(new URL(relativePath, root), "utf8");
	cache.set(relativePath, text);
	return text;
}

async function expectIncludes(file: string, needle: string, label?: string): Promise<void> {
	const text = await read(file);
	checks.push(`${file}: ${label ?? needle}`);
	if (!text.includes(needle)) {
		failures.push(`${file} is missing ${JSON.stringify(needle)}`);
	}
}

async function expectExcludes(file: string, needle: string, label?: string): Promise<void> {
	const text = await read(file);
	checks.push(`${file}: excludes ${label ?? needle}`);
	if (text.includes(needle)) {
		failures.push(`${file} should not contain ${JSON.stringify(needle)}`);
	}
}

async function markdownFiles(dir: string): Promise<string[]> {
	const absolute = new URL(dir, root);
	const entries = await readdir(absolute, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const relative = path.posix.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...await markdownFiles(relative));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(relative);
		}
	}
	return files;
}

async function main(): Promise<void> {
	const help = helpText();
	const cliDoc = await read("docs/pages/components/cli.md");
	const requiredCliLines = [
		"codex-toys fetch [--json] [--no-color]",
		"codex-toys runtime serve [--cwd <path>]",
		"codex-toys runtime http [--cwd <path>] [--static <dir>] [--host <host>] [--port <port>]",
		"codex-toys mcp serve",
		"codex-toys --ssh <target> --cwd <remote-workspace> runtime preflight [--json]",
		"codex-toys runtime host-overview --json",
		"codex-toys --ssh <target> --cwd <remote-workspace> runtime host-overview --json",
		"codex-toys workflow list [--json]",
		"codex-toys workflow run <name> [--event <event.json>] [--prompt <text>] [--via workbench|app]",
		"codex-toys workflow run --script <path> [--event <event.json>] [--prompt <text>] [--via workbench|app]",
		"codex-toys workflow run --script-stdin [--event <event.json>] [--prompt <text>] [--via workbench|app]",
		"codex-toys app <method> [params-json]",
		"codex-toys functions list [--json]",
		"codex-toys feed dispatch --source <source-id> --cursor <name> --target workbench-task:<task-id> [--limit <n>] [--no-poll] [--json]",
		"codex-toys workbench doctor [--mode auto|local|actions] [--json]",
		"codex-toys workbench dispatch create --params-json <json>",
		"codex-toys workbench dispatch read <intent-id> [--include-output] [--json]",
		"codex-toys workbench dispatch prune --older-than-days <days> [--dry-run]",
		"codex-toys memories transplant global-to-workbench [--apply]",
		"codex-toys threads install-rollout <rollout.jsonl> [--codex-home <home>] [--cwd <path>] [--replace]",
		"codex-toys kit setup <source> [--wait]",
	];

	for (const line of requiredCliLines) {
		checks.push(`CLI help includes ${line}`);
		if (!help.includes(line)) {
			failures.push(`CLI help is missing ${JSON.stringify(line)}`);
		}
		checks.push(`CLI docs include ${line}`);
		if (!cliDoc.includes(line)) {
			failures.push(`docs/pages/components/cli.md is missing ${JSON.stringify(line)}`);
		}
	}

	const requiredDocs = [
		"docs/pages/index.md",
		"docs/pages/primitives/workflow.md",
		"docs/pages/primitives/workbench.md",
		"docs/pages/primitives/dispatch-queues.md",
		"docs/pages/primitives/feed.md",
		"docs/pages/components/runtime.md",
		"docs/pages/components/kits.md",
		"docs/pages/components/cli.md",
		"docs/pages/guides/repository-autonomy.md",
		"docs/pages/guides/remote-runtime.md",
		"docs/pages/guides/local-scheduled-workbench.md",
		"docs/pages/guides/dashboard-over-runtime.md",
		"docs/pages/guides/feed-to-workflow.md",
		"docs/pages/guides/capability-kit-setup.md",
		"docs/pages/operations/codex-state.md",
		"docs/pages/operations/plugins.md",
		"docs/pages/reference/packages.md",
	];

	for (const file of requiredDocs) {
		await expectIncludes(file, "#", "markdown heading");
	}

	await expectIncludes("docs/tome.config.js", "\"primitives/workflow\"");
	await expectIncludes("docs/tome.config.js", "\"primitives/dispatch-queues\"");
	await expectIncludes("docs/tome.config.js", "\"components/runtime\"");
	await expectIncludes("docs/tome.config.js", "\"components/cli\"");
	await expectIncludes("docs/tome.config.js", "\"guides/repository-autonomy\"");
	await expectIncludes("docs/tome.config.js", "\"guides/remote-runtime\"");
	await expectIncludes("docs/tome.config.js", "\"guides/dashboard-over-runtime\"");
	await expectIncludes("docs/tome.config.js", "\"operations/codex-state\"");
	await expectIncludes("docs/tome.config.js", "\"/codex-toys\"");
	await expectIncludes("README.md", "docs/pages/primitives/workflow.md");
	await expectIncludes("README.md", "docs/pages/components/cli.md");
	await expectIncludes("README.md", "docs/pages/guides/repository-autonomy.md");
	await expectIncludes("README.md", "docs/pages/guides/remote-runtime.md");
	await expectIncludes("README.md", "docs/pages/operations/codex-state.md");
	await expectIncludes("packages/codex-toys/README.md", "docs/pages/primitives/workflow.md");
	await expectIncludes("packages/codex-toys/README.md", "docs/pages/components/cli.md");
	await expectIncludes("packages/codex-toys/README.md", "docs/pages/guides/remote-runtime.md");
	await expectIncludes("packages/codex-toys/README.md", "codex-toys/runtime");
	await expectIncludes("docs/pages/index.md", "Primitive Map");
	await expectIncludes("docs/pages/primitives/workflow.md", "export default async function run");
	await expectIncludes("docs/pages/primitives/workbench.md", ".codex/workbench/actions");
	await expectIncludes("docs/pages/primitives/dispatch-queues.md", "source.kind = \"prompt-queue\"");
	await expectIncludes("docs/pages/primitives/dispatch-queues.md", "source.kind = \"local-handoff\"");
	await expectIncludes("docs/pages/components/runtime.md", "POST /api/workbench/overview");
	await expectIncludes("docs/pages/components/kits.md", "codex-kit.toml");
	await expectIncludes("docs/pages/guides/repository-autonomy.md", "codex-toys workbench init actions --github");
	await expectIncludes("docs/pages/guides/repository-autonomy.md", "CODEX_AUTH_JSON_B64");
	await expectIncludes("docs/pages/guides/remote-runtime.md", "CODEX_TOYS_REMOTE_PATH_PREPEND");
	await expectIncludes("docs/pages/guides/local-scheduled-workbench.md", "systemctl --user");
	await expectIncludes("docs/pages/guides/dashboard-over-runtime.md", "codexToysRuntime");
	await expectIncludes("docs/pages/guides/feed-to-workflow.md", "feed.dispatch");
	await expectIncludes("docs/pages/guides/capability-kit-setup.md", "codex-toys kit add ./capability-kit --apply");
	await expectIncludes("docs/pages/operations/codex-state.md", "MEMORY.md");
	await expectIncludes("docs/pages/operations/codex-state.md", "sessions/<YYYY>/<MM>/<DD>/<rollout-file>.jsonl");
	await expectIncludes("docs/pages/reference/packages.md", "codex-toys/workbench");
	await expectIncludes("docs/pages/reference/packages.md", "codex-toys/runtime");

	const docs = await markdownFiles("docs/pages");
	const retiredTurnScript = ["auto", "mation"].join("");
	const staleNeedles = [
		`turn ${retiredTurnScript}`,
		`Turn ${retiredTurnScript}`,
		`remote ${retiredTurnScript}`,
		`${retiredTurnScript}.json`,
		"codex-pack",
		"codex-workspace",
		"workspace delegate",
		"workbench delegate",
		"context.delegate",
		"delegation.",
		"codex-toys-proxy",
		"codex-toys toybox",
		"codex-toys remote",
		"codex-toys/proxy",
		"codex-toys/remote",
		"codex-toys/toybox",
		"components/proxy",
		"components/toybox",
		"guides/remote-codex-workbench",
		"guides/dashboard-over-toybox",
		"guides/delegated-repo-work",
		"primitives/delegation",
		"workspace prompt",
		"workspace handoff",
		"workspace dispatch",
		"workbench deferred",
		"workbench defer",
		"workbench tick",
		"schedule =",
		"workbench.reactive",
		"Deferred Queues",
		"deferred queues",
		"/home/peezy",
		"rammstein",
		"portfolioSnapshot",
		"openai-codex-bindings",
	];
	for (const file of docs) {
		for (const needle of staleNeedles) {
			await expectExcludes(file, needle);
		}
	}

	await expectExcludes(".codex-plugin/plugin.json", `turn ${retiredTurnScript}`);
	await expectExcludes("plugins/codex-toys-author/.codex-plugin/plugin.json", `turn ${retiredTurnScript}`);

	if (failures.length > 0) {
		for (const failure of failures) {
			console.error(`docs check failed: ${failure}`);
		}
		console.error(`docs check inspected ${checks.length} conditions`);
		process.exit(1);
	}

	console.log(`docs check passed (${checks.length} conditions)`);
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
