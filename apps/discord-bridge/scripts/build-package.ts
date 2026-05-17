import { chmod, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const appRoot = path.resolve(import.meta.dir, "..");
const outDir = path.join(appRoot, "dist");
const outfile = path.join(outDir, "index.js");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const proc = Bun.spawn([
	"bun",
	"build",
	"src/index.ts",
	"--target=bun",
	"--outfile",
	outfile,
	"--external",
	"@peezy.tech/codex-flows",
	"--external",
	"@peezy.tech/codex-flows/*",
	"--external",
	"discord.js",
], {
	cwd: appRoot,
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
process.stderr.write(`built ${path.relative(appRoot, outfile)}\n`);
