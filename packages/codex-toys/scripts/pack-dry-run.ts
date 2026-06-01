import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "../..");

const requiredTarEntries = [
	"package/dist/index.js",
	"package/dist/workbench.js",
	"package/dist/proxy/browser.js",
	"package/dist/bridge/json.js",
	"package/node_modules/@codex-toys/actions/dist/index.js",
	"package/node_modules/@codex-toys/bridge/dist/index.js",
	"package/node_modules/@codex-toys/kits/dist/index.js",
	"package/node_modules/@codex-toys/proxy/dist/index.js",
	"package/node_modules/@codex-toys/proxy/dist/bin/codex-toys-proxy.js",
	"package/node_modules/@codex-toys/remote/dist/index.js",
	"package/node_modules/@codex-toys/toybox/dist/index.js",
	"package/node_modules/@codex-toys/workbench/dist/index.js",
] as const;

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-toys-pack-"));

try {
	const packDir = path.join(tempRoot, "pack");
	const installDir = path.join(tempRoot, "install");
	await mkdir(packDir, { recursive: true });
	await mkdir(installDir, { recursive: true });
	await run("tsx", [
		path.join(repoRoot, "scripts", "pack-public-package.ts"),
		"--pack-destination",
		packDir,
	]);

	const tarballName = (await readdir(packDir)).find((file) => file.endsWith(".tgz"));
	if (!tarballName) {
		throw new Error("pnpm pack did not create a tarball");
	}
	const tarballPath = path.join(packDir, tarballName);
	const tarEntries = await listTarEntries(tarballPath);
	for (const entry of requiredTarEntries) {
		if (!tarEntries.has(entry)) {
			throw new Error(`packed tarball is missing ${entry}`);
		}
	}

	await run("npm", [
		"install",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		tarballPath,
	], { cwd: installDir });

	await run(process.execPath, [
		"--input-type=module",
		"--eval",
		`
const checks = [
	["codex-toys", ["CodexAppServerClient", "collectWorkbenchOverview"]],
	["codex-toys/actions", ["repoCodexHome", "prepareActionsCodexAuth"]],
	["codex-toys/bridge", ["CodexAppServerClient", "JsonRpcError"]],
	["codex-toys/bridge/generated", ["v2"]],
	["codex-toys/bridge/json", ["parseJsonText"]],
	["codex-toys/kits", ["inspectKitSource", "applyKitAdd"]],
	["codex-toys/proxy", ["createCodexToysProxyHandler"]],
	["codex-toys/proxy/browser", ["createCodexToysBrowserClient", "codexToys"]],
	["codex-toys/proxy/vite", ["codexToysRemote"]],
	["codex-toys/remote", ["createSshToyboxTransport", "collectRemotePreflight"]],
	["codex-toys/toybox", ["CodexToyboxClient", "CodexToyboxProtocolServer"]],
	["codex-toys/workbench", ["collectHostOverview", "collectWorkbenchOverview", "defineFunctions"]],
];
for (const [specifier, expectedExports] of checks) {
	const module = await import(specifier);
	for (const exportName of expectedExports) {
		if (!(exportName in module)) {
			throw new Error(\`\${specifier} is missing export \${exportName}\`);
		}
	}
}
`,
	], { cwd: installDir });

	await run(path.join(installDir, "node_modules", ".bin", "codex-toys"), ["--help"], {
		cwd: installDir,
	});
	await run(path.join(installDir, "node_modules", ".bin", "codex-toys-proxy"), ["--help"], {
		cwd: installDir,
	});

	const byTopLevel = new Map<string, number>();
	for (const entry of tarEntries) {
		const relative = entry.replace(/^package\//, "");
		const [topLevel = relative] = relative.split("/");
		byTopLevel.set(topLevel, (byTopLevel.get(topLevel) ?? 0) + 1);
	}

	const topLevelSummary = [...byTopLevel.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, count]) => `${name}: ${count}`)
		.join(", ");

	console.log(`codex-toys pack/install smoke passed`);
	console.log(`tarball: ${tarballName}`);
	console.log(`files: ${tarEntries.size} (${topLevelSummary})`);
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}

async function listTarEntries(tarballPath: string): Promise<Set<string>> {
	const result = await run("tar", ["-tf", tarballPath]);
	return new Set(result.stdout.split("\n").filter(Boolean));
}

async function run(
	command: string,
	args: string[],
	options: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
	});

	if (result.status !== 0) {
		process.stderr.write(result.stderr ?? "");
		process.stderr.write(result.stdout ?? "");
		throw new Error(`${command} ${args.join(" ")} exited with code ${result.status}`);
	}

	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}
