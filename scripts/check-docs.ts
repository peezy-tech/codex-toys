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
	const file = Bun.file(new URL(relativePath, root));
	const text = await file.text();
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

const helpProc = Bun.spawn([process.execPath, "packages/codex-client/src/cli/index.ts", "--help"], {
	cwd: rootPath,
	stdout: "pipe",
	stderr: "pipe",
});
const [help, helpError, helpExit] = await Promise.all([
	new Response(helpProc.stdout).text(),
	new Response(helpProc.stderr).text(),
	helpProc.exited,
]);

if (helpExit !== 0) {
	process.stderr.write(helpError);
	process.stderr.write(help);
	process.exit(helpExit);
}

const cliDoc = await read("docs/pages/reference/cli.md");
const requiredCliLines = [
	"codex-flows fetch [--json] [--no-color]",
	"codex-flows app <method> [params-json]",
	"codex-flows workspace doctor [--mode auto|local|actions] [--json]",
	"codex-flows workspace tick [--mode auto|local|actions]",
	"codex-flows workspace run <task-id> [--mode auto|local|actions]",
	"codex-flows memories transplant global-to-workspace [--apply]",
	"codex-flows memories transplant workspace-to-global [--apply]",
	"codex-flows threads locate <thread-id> [--codex-home <home>]",
	"codex-flows threads export <thread-id> --output <bundle-dir> [--codex-home <home>]",
	"codex-flows threads inspect <bundle-dir>",
	"codex-flows threads import <bundle-dir> [--codex-home <home>] [--replace]",
	"codex-flows threads transplant <thread-id> --from-codex-home <src> --to-codex-home <dst> [--replace]",
	"codex-flows pack inspect <source> [--json]",
	"codex-flows pack add <source> [--apply] [--include <name>] [--exclude <name>]",
	"codex-flows pack doctor [--json]",
	"codex-flows pack list [--json]",
	"codex-flows flow dispatch --event <event.json>",
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
await expectIncludes("README.md", "docs/pages/guides/workspace-autonomy.md");
await expectIncludes("README.md", "docs/pages/guides/memory-transplant.md");
await expectIncludes("README.md", "docs/pages/guides/thread-transplant.md");
await expectIncludes("README.md", "docs/pages/guides/install-pack-repos.md");

await expectIncludes("docs/tome.config.js", "\"guides/workspace-autonomy\"");
await expectIncludes("docs/tome.config.js", "\"guides/memory-transplant\"");
await expectIncludes("docs/tome.config.js", "\"guides/thread-transplant\"");
await expectIncludes("docs/tome.config.js", "\"guides/install-pack-repos\"");
await expectIncludes("docs/tome.config.js", "RELEASE.md");
await expectIncludes("docs/index.html", "<title>codex-flows</title>");

await expectIncludes("docs/pages/index.md", "Workspace autonomy");
await expectIncludes("docs/pages/index.md", "Memory transplant");
await expectIncludes("docs/pages/index.md", "Thread Transplant");
await expectIncludes("docs/pages/index.md", "Pack Install");
await expectIncludes("docs/pages/index.md", "@peezy.tech/codex-flows");
await expectIncludes("docs/pages/reference/packages.md", "workspace autonomy");
await expectIncludes("docs/pages/reference/packages.md", "memory transplant");
await expectIncludes("docs/pages/reference/packages.md", "@peezy.tech/codex-flows/threads");

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

await expectIncludes("docs/pages/guides/thread-transplant.md", "manifest.json");
await expectIncludes("docs/pages/guides/thread-transplant.md", "sessions/<YYYY>/<MM>/<DD>/<rollout-file>.jsonl");
await expectIncludes("docs/pages/guides/thread-transplant.md", "--replace");
await expectIncludes("docs/pages/guides/thread-transplant.md", "not app-server-native import");

await expectIncludes("docs/pages/guides/install-pack-repos.md", "pack repo");
await expectIncludes("docs/pages/guides/install-pack-repos.md", ".codex/pack-lock.json");
await expectIncludes("docs/pages/guides/install-pack-repos.md", ".agents/plugins/marketplace.json");
await expectIncludes("docs/pages/guides/install-pack-repos.md", "[features].plugin_hooks = true");

await expectIncludes("packages/codex-client/README.md", "codex-flows workspace doctor");
await expectIncludes("packages/codex-client/README.md", "codex-flows memories transplant global-to-workspace");
await expectIncludes("packages/codex-client/README.md", "codex-flows threads transplant <thread-id>");
await expectIncludes("packages/codex-client/README.md", "codex-flows pack inspect owner/repo");

if (failures.length > 0) {
	for (const failure of failures) {
		console.error(`docs check failed: ${failure}`);
	}
	console.error(`docs check inspected ${checks.length} conditions`);
	process.exit(1);
}

console.log(`docs check passed (${checks.length} conditions)`);
