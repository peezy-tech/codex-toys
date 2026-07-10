import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceEntrypoint = path.join(root, "apps", "meka", "src", "main.ts");
const originalArgs = process.argv.slice(2);
const mekaArgs = originalArgs.at(0) === "--" ? originalArgs.slice(1) : originalArgs;
const tsxImport = import.meta.resolve("tsx");

const result = await run(process.execPath, ["--import", tsxImport, sourceEntrypoint, ...mekaArgs], {
  cwd: process.cwd(),
  env: { ...process.env, TSX_TSCONFIG_PATH: path.join(root, "tsconfig.base.json") },
});

if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exitCode = result.code ?? 1;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}
