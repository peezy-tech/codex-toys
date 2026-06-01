import { readFile } from "node:fs/promises";
import { helpText } from "../packages/codex-toys/src/cli/help.ts";

const checks: string[] = [];
const failures: string[] = [];

const root = new URL("..", import.meta.url);

const textFiles = new Map<string, string>();

async function read(relativePath: string): Promise<string> {
	const cached = textFiles.get(relativePath);
	if (cached !== undefined) {
		return cached;
	}
	const text = await readFile(new URL(relativePath, root), "utf8");
	textFiles.set(relativePath, text);
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

async function main(): Promise<void> {
	const help = helpText();

const cliDoc = await read("docs/pages/reference/cli.md");
const requiredCliLines = [
	"codex-toys fetch [--json] [--no-color]",
	"codex-toys mcp serve",
	"codex-toys toybox serve [--cwd <path>]",
	"codex-toys automation list [--json]",
	"codex-toys automation run <name> [--event <event.json>] [--prompt <text>] [--via workbench|app]",
	"codex-toys app <method> [params-json]",
	"codex-toys workbench doctor [--mode auto|local|actions] [--json]",
	"codex-toys workbench delegate list [--json]",
	"codex-toys workbench delegate start --cwd @/workbenches/name --prompt <text> [--wait]",
	"codex-toys workbench tick [--mode auto|local|actions]",
	"codex-toys workbench run <task-id> [--mode auto|local|actions]",
	"codex-toys workbench deferred create --params-json <json>",
	"codex-toys workbench deferred list [--mode auto|local|actions] [--json]",
	"codex-toys workbench deferred read <intent-id> [--include-output] [--json]",
	"codex-toys workbench deferred pull <intent-id> [--json]",
	"codex-toys workbench deferred collect [--cursor <name>] [--json]",
	"codex-toys workbench deferred run-due [--mode auto|local|actions]",
	"codex-toys workbench deferred prune --older-than-days <days> [--dry-run]",
	"codex-toys memories transplant global-to-workbench [--apply]",
	"codex-toys memories transplant workbench-to-global [--apply]",
	"codex-toys threads locate <thread-id> [--codex-home <home>]",
	"codex-toys threads inspect <thread-id-or-rollout.jsonl> [--codex-home <home>]",
	"codex-toys threads install-rollout <rollout.jsonl> [--codex-home <home>] [--replace]",
	"codex-toys threads transplant <thread-id> --from-codex-home <src> --to-codex-home <dst> [--replace]",
	"codex-toys kit inspect <source> [--json]",
	"codex-toys kit add <source> [--apply] [--include <name>] [--exclude <name>]",
	"codex-toys kit doctor [--json]",
	"codex-toys kit list [--json]",
	"--merge codex",
];

for (const line of requiredCliLines) {
	checks.push(`CLI help includes ${line}`);
	if (!help.includes(line)) {
		failures.push(`CLI help is missing ${JSON.stringify(line)}`);
	}
	checks.push(`CLI docs include ${line}`);
	if (!cliDoc.includes(line)) {
		failures.push(`docs/pages/reference/cli.md is missing ${JSON.stringify(line)}`);
	}
}

await expectExcludes("README.md", "Codex Bare");
await expectExcludes("README.md", "DEVELOP.md");
await expectExcludes("package.json", "codex-bare");
await expectExcludes("package.json", "Thin web UI");
await expectExcludes("SECURITY.md", "codex-bare");
await expectIncludes("SECURITY.md", "Memory transplant");
await expectIncludes("README.md", "docs/pages/guides/turn-automation.md");
await expectIncludes("README.md", "docs/pages/guides/workbench-autonomy.md");
await expectIncludes("README.md", "docs/pages/guides/memory-transplant.md");
await expectIncludes("README.md", "docs/pages/guides/thread-transplant.md");
await expectIncludes("README.md", "docs/pages/guides/install-codex-plugin.md");
await expectIncludes("README.md", "docs/pages/guides/install-kit-repos.md");
await expectIncludes("README.md", "docs/pages/concepts/package-stack.md");

await expectIncludes("docs/tome.config.js", "\"guides/turn-automation\"");
await expectIncludes("docs/tome.config.js", "\"guides/workbench-autonomy\"");
await expectIncludes("docs/tome.config.js", "\"guides/memory-transplant\"");
await expectIncludes("docs/tome.config.js", "\"guides/thread-transplant\"");
await expectIncludes("docs/tome.config.js", "\"guides/install-codex-plugin\"");
await expectIncludes("docs/tome.config.js", "\"guides/install-kit-repos\"");
await expectIncludes("docs/tome.config.js", "\"concepts/package-stack\"");
await expectIncludes("docs/tome.config.js", "RELEASE.md");
await expectIncludes("docs/index.html", "<title>codex-toys</title>");

await expectIncludes("docs/pages/index.md", "Turn Automation");
await expectIncludes("docs/pages/index.md", "Workbench autonomy");
await expectIncludes("docs/pages/index.md", "Memory transplant");
await expectIncludes("docs/pages/index.md", "Thread Transplant");
await expectIncludes("docs/pages/index.md", "Plugin Install");
await expectIncludes("docs/pages/index.md", "codex-toys");
await expectIncludes("docs/pages/reference/packages.md", "@codex-toys/bridge");
await expectIncludes("docs/pages/reference/packages.md", "@codex-toys/workbench");
await expectIncludes("docs/pages/reference/packages.md", "@codex-toys/kits");
await expectIncludes("docs/pages/reference/packages.md", "memory transplant");
await expectIncludes("docs/pages/reference/packages.md", "codex-kit.toml");

await expectIncludes("docs/pages/guides/workbench-autonomy.md", "[workbench]");
await expectIncludes("docs/pages/guides/workbench-autonomy.md", ".codex/workbench/local");
await expectIncludes("docs/pages/guides/workbench-autonomy.md", ".codex/workbench/actions");
await expectIncludes("docs/pages/guides/workbench-autonomy.md", "CODEX_WORKBENCH_MODE=actions");

await expectIncludes("docs/pages/guides/memory-transplant.md", "MEMORY.md");
await expectIncludes("docs/pages/guides/memory-transplant.md", "memory_summary.md");
await expectIncludes("docs/pages/guides/memory-transplant.md", "raw_memories.md");
await expectIncludes("docs/pages/guides/memory-transplant.md", "rollout_summaries/*.md");
await expectIncludes("docs/pages/guides/memory-transplant.md", "sqlite");
await expectIncludes("docs/pages/guides/memory-transplant.md", "skills");

await expectIncludes("docs/pages/guides/thread-transplant.md", "install-rollout");
await expectIncludes("docs/pages/guides/thread-transplant.md", "sessions/<YYYY>/<MM>/<DD>/<rollout-file>.jsonl");
await expectIncludes("docs/pages/guides/thread-transplant.md", "--replace");
await expectIncludes("docs/pages/guides/thread-transplant.md", "not app-server-native import");

await expectIncludes("docs/pages/guides/install-codex-plugin.md", "codex plugin marketplace add peezy-tech/skills --ref main");
await expectIncludes("docs/pages/guides/install-codex-plugin.md", "codex plugin add codex-toys-author@peezy-tech");
await expectIncludes("docs/pages/guides/install-codex-plugin.md", "codex plugin add codex-toys-local-workbench@peezy-tech");
await expectIncludes("docs/pages/guides/install-codex-plugin.md", "codex plugin add codex-toys-remote-control@peezy-tech");
await expectIncludes("docs/pages/guides/install-codex-plugin.md", "codex plugin add codex-toys@codex-toys");
await expectIncludes("docs/pages/guides/install-codex-plugin.md", "codex-toys toybox serve --cwd /repo");
await expectIncludes("docs/pages/guides/install-codex-plugin.md", "codex-toys-proxy serve --cwd /repo --static ./dashboard");
await expectIncludes("docs/pages/guides/turn-automation.md", "export default async function run");
await expectIncludes("docs/pages/guides/turn-automation.md", "codex-toys --ssh devbox --cwd /repo automation run");
await expectIncludes("docs/pages/reference/cli.md", "codex-toys toybox serve [--cwd <path>]");
await expectIncludes("docs/pages/reference/cli.md", "codex-toys-proxy serve --cwd <workbench> [--static <dir>]");
await expectIncludes("docs/pages/reference/cli.md", "CODEX_TOYS_TOYBOX_COMMAND");
await expectIncludes("docs/pages/reference/cli.md", "POST /api/workbench/:method");
await expectIncludes("docs/pages/reference/cli.md", "codex-toys automation run <name>");
await expectIncludes("docs/pages/guides/install-kit-repos.md", "kit repo");
await expectIncludes("docs/pages/guides/install-kit-repos.md", "codex-kit.toml");
await expectIncludes("docs/pages/guides/install-kit-repos.md", ".codex/kit-lock.json");
await expectIncludes("docs/pages/guides/install-kit-repos.md", ".agents/plugins/marketplace.json");

await expectIncludes("packages/codex-toys/README.md", "@codex-toys/bridge");
await expectIncludes("packages/codex-toys/README.md", "@codex-toys/workbench");
await expectIncludes("packages/codex-toys/README.md", "@codex-toys/proxy/browser");
await expectIncludes("packages/codex-toys/README.md", "codex-toys automation run");
await expectIncludes("packages/codex-toys/README.md", "codex-toys workbench doctor");
await expectIncludes("packages/codex-toys/README.md", "codex-toys toybox serve --cwd /repo");
await expectIncludes("packages/codex-toys/README.md", "codex-toys-proxy serve --cwd /repo --static ./dashboard");
await expectIncludes("packages/codex-toys/README.md", "codex-toys memories transplant global-to-workbench");
await expectIncludes("packages/codex-toys/README.md", "codex-toys threads transplant <thread-id>");
await expectIncludes("packages/codex-toys/README.md", "guides/install-codex-plugin.md");

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
