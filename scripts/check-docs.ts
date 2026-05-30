import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const checks: string[] = [];
const failures: string[] = [];

const root = new URL("..", import.meta.url);
const rootPath = fileURLToPath(root);

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
	const helpProc = spawn(process.execPath, ["--import", "tsx", "packages/codex-client/src/cli/index.ts", "--help"], {
		cwd: rootPath,
	});
	const [help, helpError, helpExit] = await Promise.all([
		collectText(helpProc.stdout),
		collectText(helpProc.stderr),
		exitCodeFor(helpProc),
	]);

if (helpExit !== 0) {
	process.stderr.write(helpError);
	process.stderr.write(help);
	process.exit(helpExit);
}

const cliDoc = await read("docs/pages/reference/cli.md");
const requiredCliLines = [
	"codex-toys fetch [--json] [--no-color]",
	"codex-toys mcp serve",
	"codex-toys toybox serve [--cwd <path>]",
	"codex-toys automation list [--json]",
	"codex-toys automation run <name> [--event <event.json>] [--prompt <text>] [--via workspace|app]",
	"codex-toys app <method> [params-json]",
	"codex-toys workspace doctor [--mode auto|local|actions] [--json]",
	"codex-toys workspace delegate list [--json]",
	"codex-toys workspace delegate start --cwd @/workspaces/name --prompt <text> [--wait]",
	"codex-toys workspace tick [--mode auto|local|actions]",
	"codex-toys workspace run <task-id> [--mode auto|local|actions]",
	"codex-toys workspace deferred create --params-json <json>",
	"codex-toys workspace deferred list [--mode auto|local|actions] [--json]",
	"codex-toys workspace deferred read <intent-id> [--include-output] [--json]",
	"codex-toys workspace deferred pull <intent-id> [--json]",
	"codex-toys workspace deferred run-due [--mode auto|local|actions]",
	"codex-toys workspace deferred prune --older-than-days <days> [--dry-run]",
	"codex-toys memories transplant global-to-workspace [--apply]",
	"codex-toys memories transplant workspace-to-global [--apply]",
	"codex-toys threads locate <thread-id> [--codex-home <home>]",
	"codex-toys threads inspect <thread-id-or-rollout.jsonl> [--codex-home <home>]",
	"codex-toys threads install-rollout <rollout.jsonl> [--codex-home <home>] [--replace]",
	"codex-toys threads transplant <thread-id> --from-codex-home <src> --to-codex-home <dst> [--replace]",
	"codex-toys pack inspect <source> [--json]",
	"codex-toys pack add <source> [--apply] [--include <name>] [--exclude <name>]",
	"codex-toys pack doctor [--json]",
	"codex-toys pack list [--json]",
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
await expectIncludes("README.md", "docs/pages/guides/workspace-autonomy.md");
await expectIncludes("README.md", "docs/pages/guides/memory-transplant.md");
await expectIncludes("README.md", "docs/pages/guides/thread-transplant.md");
await expectIncludes("README.md", "docs/pages/guides/install-codex-plugin.md");
await expectIncludes("README.md", "docs/pages/guides/install-pack-repos.md");

await expectIncludes("docs/tome.config.js", "\"guides/turn-automation\"");
await expectIncludes("docs/tome.config.js", "\"guides/workspace-autonomy\"");
await expectIncludes("docs/tome.config.js", "\"guides/memory-transplant\"");
await expectIncludes("docs/tome.config.js", "\"guides/thread-transplant\"");
await expectIncludes("docs/tome.config.js", "\"guides/install-codex-plugin\"");
await expectIncludes("docs/tome.config.js", "\"guides/install-pack-repos\"");
await expectIncludes("docs/tome.config.js", "RELEASE.md");
await expectIncludes("docs/index.html", "<title>codex-toys</title>");

await expectIncludes("docs/pages/index.md", "Turn Automation");
await expectIncludes("docs/pages/index.md", "Workspace autonomy");
await expectIncludes("docs/pages/index.md", "Memory transplant");
await expectIncludes("docs/pages/index.md", "Thread Transplant");
await expectIncludes("docs/pages/index.md", "Plugin Install");
await expectIncludes("docs/pages/index.md", "codex-toys");
await expectIncludes("docs/pages/reference/packages.md", "workspace autonomy");
await expectIncludes("docs/pages/reference/packages.md", "memory transplant");
await expectIncludes("docs/pages/reference/packages.md", "codex-toys/threads");

await expectIncludes("docs/pages/guides/workspace-autonomy.md", "[workspace]");
await expectIncludes("docs/pages/guides/workspace-autonomy.md", ".codex/workspace/local");
await expectIncludes("docs/pages/guides/workspace-autonomy.md", ".codex/workspace/actions");
await expectIncludes("docs/pages/guides/workspace-autonomy.md", "CODEX_WORKSPACE_MODE=actions");

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
await expectIncludes("docs/pages/guides/install-codex-plugin.md", "codex plugin add codex-toys-local-workspace@peezy-tech");
await expectIncludes("docs/pages/guides/install-codex-plugin.md", "codex plugin add codex-toys-remote-control@peezy-tech");
await expectIncludes("docs/pages/guides/install-codex-plugin.md", "codex plugin add codex-toys@codex-toys");
await expectIncludes("docs/pages/guides/install-codex-plugin.md", "hooks/hooks.json");
await expectIncludes("docs/pages/guides/install-codex-plugin.md", "plugin_hooks = true");
await expectIncludes("docs/pages/guides/install-codex-plugin.md", "CODEX_TOYS_HOOK_SPOOL_DIR");
await expectIncludes("docs/pages/guides/install-codex-plugin.md", "codex-toys toybox serve --cwd /repo");
await expectIncludes("docs/pages/guides/install-codex-plugin.md", "codex-toys-proxy serve --cwd /repo --static ./dashboard");
await expectIncludes("docs/pages/guides/turn-automation.md", "export default async function run");
await expectIncludes("docs/pages/guides/turn-automation.md", "codex-toys --ssh devbox --cwd /repo automation run");
await expectIncludes("docs/pages/reference/cli.md", "codex-toys toybox serve [--cwd <path>]");
await expectIncludes("docs/pages/reference/cli.md", "codex-toys-proxy serve --cwd <workspace> [--static <dir>]");
await expectIncludes("docs/pages/reference/cli.md", "CODEX_TOYS_TOYBOX_COMMAND");
await expectIncludes("docs/pages/reference/cli.md", "POST /api/workspace/:method");
await expectIncludes("docs/pages/reference/cli.md", "codex-toys automation run <name>");
await expectIncludes("docs/pages/guides/install-pack-repos.md", "pack repo");
await expectIncludes("docs/pages/guides/install-pack-repos.md", ".codex/pack-lock.json");
await expectIncludes("docs/pages/guides/install-pack-repos.md", ".agents/plugins/marketplace.json");
await expectIncludes("docs/pages/guides/install-pack-repos.md", "[features].plugin_hooks = true");

await expectIncludes("packages/codex-client/README.md", "codex-toys automation run");
await expectIncludes("packages/codex-client/README.md", "codex-toys workspace doctor");
await expectIncludes("packages/codex-client/README.md", "codex-toys toybox serve --cwd /repo");
await expectIncludes("packages/codex-client/README.md", "codex-toys-proxy serve --cwd /repo --static ./dashboard");
await expectIncludes("packages/codex-client/README.md", "codex-toys memories transplant global-to-workspace");
await expectIncludes("packages/codex-client/README.md", "codex-toys threads transplant <thread-id>");
await expectIncludes("packages/codex-client/README.md", "guides/install-codex-plugin.md");

if (failures.length > 0) {
	for (const failure of failures) {
		console.error(`docs check failed: ${failure}`);
	}
	console.error(`docs check inspected ${checks.length} conditions`);
	process.exit(1);
}

	console.log(`docs check passed (${checks.length} conditions)`);
}

function collectText(stream: NodeJS.ReadableStream | null): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = "";
		if (!stream) {
			resolve(output);
			return;
		}
		stream.setEncoding("utf8");
		stream.on("data", (chunk: string) => {
			output += chunk;
		});
		stream.once("error", reject);
		stream.once("end", () => resolve(output));
	});
}

function exitCodeFor(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
