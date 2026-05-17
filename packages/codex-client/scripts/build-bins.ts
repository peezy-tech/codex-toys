import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";

type BinBuild = {
	name: string;
	entry: string;
	external?: string[];
};

const repoRoot = path.resolve(import.meta.dir, "../../..");
const packageRoot = path.resolve(import.meta.dir, "..");
const outDir = path.join(packageRoot, "dist", "bin");

const selfExternals = ["@peezy.tech/codex-flows", "@peezy.tech/codex-flows/*"];

const builds: BinBuild[] = [
	{
		name: "codex-app",
		entry: "apps/cli/src/index.ts",
		external: selfExternals,
	},
	{
		name: "codex-flow-runner",
		entry: "apps/flow-runner/src/index.ts",
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

for (const build of builds) {
	const outfile = path.join(outDir, `${build.name}.js`);
	const args = [
		"build",
		build.entry,
		"--target=bun",
		"--outfile",
		outfile,
	];
	for (const external of build.external ?? []) {
		args.push("--external", external);
	}

	const proc = Bun.spawn(["bun", ...args], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	if (exitCode !== 0) {
		process.stderr.write(stderr);
		process.stderr.write(stdout);
		process.exit(exitCode);
	}

	await chmod(outfile, 0o755);
	process.stderr.write(`built ${path.relative(packageRoot, outfile)}\n`);
}
