import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "packages/app-server/src/app-server/generated");
const codexCommand = process.env.CODEX_APP_SERVER_CODEX_COMMAND ?? "codex";
const args = [
	"app-server",
	"generate-ts",
	"--experimental",
	"--out",
	outDir,
];

const child = spawn(codexCommand, args, {
	cwd: root,
	stdio: "inherit",
	env: process.env,
});

child.once("exit", (code, signal) => {
	if (code === 0) {
		return;
	}
	process.exitCode = typeof code === "number" ? code : 1;
	if (signal) {
		process.stderr.write(`codex app-server generate-ts exited with ${signal}\n`);
	}
});
