import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await mkdtemp(path.join(os.tmpdir(), "meka-source-install-"));
const checkout = path.join(fixture, "checkout");

try {
  await cp(root, checkout, { recursive: true, filter: shouldCopy });
  await run("pnpm", ["install", "--frozen-lockfile"], checkout);
  await run("pnpm", ["run", "meka", "--", "--help"], checkout);
  await run("pnpm", ["exec", "meka", "--help"], checkout);
  process.stdout.write("Clean source-install check passed.\n");
} finally {
  await rm(fixture, { recursive: true, force: true });
}

function shouldCopy(source) {
  const relative = path.relative(root, source);
  if (!relative) {
    return true;
  }
  return !relative.split(path.sep).some((part) =>
    [".git", "node_modules", "dist", ".turbo"].includes(part),
  );
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? code ?? "unknown"}`));
    });
  });
}
