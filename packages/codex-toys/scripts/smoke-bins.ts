import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

const checks = [
	{ name: "codex-toys", path: "dist/cli/index.js" },
	{
		name: "codex-toys-proxy",
		path: "node_modules/@codex-toys/proxy/dist/bin/codex-toys-proxy.js",
	},
] as const;

for (const check of checks) {
	const binPath = path.join(packageRoot, check.path);
	await access(binPath, constants.X_OK);
	const proc = spawn(binPath, ["--help"], {
		cwd: packageRoot,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(proc.stdout),
		collectText(proc.stderr),
		exitCodeFor(proc),
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
