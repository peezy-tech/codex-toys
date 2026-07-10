import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appEntrypoint = path.join(root, "apps", "meka", "dist", "main.js");
const sdkEntrypoint = path.join(root, "packages", "sdk", "dist", "index.js");
const originalArgs = process.argv.slice(2);
const mekaArgs = originalArgs.at(0) === "--" ? originalArgs.slice(1) : originalArgs;

let launch = true;
if (!(await exists(appEntrypoint)) || !(await exists(sdkEntrypoint))) {
  const build = await run("pnpm", ["run", "build"], { cwd: root });
  if (build.code !== 0 || build.signal) {
    finish(build);
    launch = false;
  }
}

if (launch) {
  finish(await run(process.execPath, [appEntrypoint, ...mekaArgs], { cwd: process.cwd() }));
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function finish(result) {
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}
