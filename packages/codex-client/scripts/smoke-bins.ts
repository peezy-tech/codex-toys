import { access } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");

const checks = [
	{ name: "codex-flows", path: "dist/cli/index.js" },
	{ name: "codex-app", path: "dist/bin/codex-app.js" },
	{ name: "codex-flow-runner", path: "dist/bin/codex-flow-runner.js" },
	{
		name: "codex-workspace-backend-local",
		path: "dist/bin/codex-workspace-backend-local.js",
	},
] as const;

for (const check of checks) {
	const binPath = path.join(packageRoot, check.path);
	await access(binPath);
	const proc = Bun.spawn(["bun", binPath, "--help"], {
		cwd: packageRoot,
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
		throw new Error(`${check.name} --help exited with code ${exitCode}`);
	}

	if (!stdout.includes(check.name)) {
		throw new Error(`${check.name} --help did not mention ${check.name}`);
	}
}

console.log("bin smoke test passed");
