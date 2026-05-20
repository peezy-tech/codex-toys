import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const binPath = path.join(appRoot, "dist", "index.js");

await access(binPath);

const proc = spawn(process.execPath, [binPath, "--help"], {
	cwd: appRoot,
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

if (!stdout.includes("codex-workspace-voice-gateway")) {
	throw new Error(
		"codex-workspace-voice-gateway --help did not mention codex-workspace-voice-gateway",
	);
}

console.log("bin smoke test passed");

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
