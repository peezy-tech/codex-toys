import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type BinBuild = {
	name: string;
	entry: string;
	external?: string[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const packageRoot = path.resolve(__dirname, "..");
const cliBin = path.join(packageRoot, "dist", "cli", "index.js");
const outDir = path.join(packageRoot, "dist", "bin");

const selfExternals = ["@peezy.tech/codex-flows", "@peezy.tech/codex-flows/*"];

const builds: BinBuild[] = [
	{
		name: "codex-app",
		entry: "apps/cli/src/index.ts",
		external: selfExternals,
	},
	{
		name: "codex-workspace-backend-local",
		entry: "apps/workspace-backend/src/index.ts",
		external: selfExternals,
	},
];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await chmod(cliBin, 0o755);

for (const build of builds) {
	const outfile = path.join(outDir, `${build.name}.js`);
	const packOutDir = path.join(outDir, `.pack-${build.name}`);
	const args = [
		"pack",
		build.entry,
		"--platform=node",
		"--format=esm",
		"--target=node24",
		"--out-dir",
		packOutDir,
	];
	for (const external of build.external ?? []) {
		args.push("--deps.never-bundle", external);
	}

	const proc = spawn("vp", args, {
		cwd: repoRoot,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(proc.stdout),
		collectText(proc.stderr),
		exitCodeFor(proc),
	]);

	if (exitCode !== 0) {
		process.stderr.write(stderr);
		process.stderr.write(stdout);
		process.exit(exitCode);
	}

	await movePackOutput(packOutDir, outfile);
	await rm(packOutDir, { recursive: true, force: true });
	await chmod(outfile, 0o755);
	process.stderr.write(`built ${path.relative(packageRoot, outfile)}\n`);
}

async function movePackOutput(packDir: string, entryOutfile: string): Promise<void> {
	await rename(path.join(packDir, "index.mjs"), entryOutfile);
	for (const entry of await readdir(packDir, { withFileTypes: true })) {
		if (!entry.isFile()) {
			continue;
		}
		await rename(path.join(packDir, entry.name), path.join(outDir, entry.name));
	}
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
