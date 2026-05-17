import { access } from "node:fs/promises";
import path from "node:path";

const appRoot = path.resolve(import.meta.dir, "..");
const binPath = path.join(appRoot, "dist", "index.js");

await access(binPath);

const proc = Bun.spawn(["bun", binPath, "--help"], {
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

if (!stdout.includes("codex-discord-bridge")) {
	throw new Error("codex-discord-bridge --help did not mention codex-discord-bridge");
}

console.log("bin smoke test passed");
