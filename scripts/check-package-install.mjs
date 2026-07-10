import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await mkdtemp(path.join(os.tmpdir(), "meka-package-install-"));
const packages = path.join(fixture, "packages");
const consumer = path.join(fixture, "consumer");

try {
  await mkdir(packages);
  await mkdir(consumer);
  process.stdout.write("Cleaning package build artifacts...\n");
  await run("pnpm", ["run", "clean"], root);
  process.stdout.write("Packing @meka/sdk...\n");
  await run(
    "pnpm",
    ["--filter", "@meka/sdk", "pack", "--pack-destination", packages],
    root,
    { quiet: true },
  );
  process.stdout.write("Packing @meka/app...\n");
  await run(
    "pnpm",
    ["--filter", "@meka/app", "pack", "--pack-destination", packages],
    root,
    { quiet: true },
  );
  const archives = await readdir(packages);
  const sdk = archive(packages, archives, "meka-sdk-");
  const app = archive(packages, archives, "meka-app-");
  process.stdout.write("Installing the paired archives into a clean consumer...\n");
  await run("npm", ["install", "--no-package-lock", sdk, app], consumer);
  process.stdout.write("Running the installed CLI...\n");
  await run(path.join(consumer, "node_modules", ".bin", "meka"), ["--help"], consumer);
  process.stdout.write("Clean package-install check passed.\n");
} finally {
  await rm(fixture, { recursive: true, force: true });
}

function archive(directory, entries, prefix) {
  const match = entries.find((entry) => entry.startsWith(prefix) && entry.endsWith(".tgz"));
  if (!match) {
    throw new Error(`Could not find ${prefix} package archive`);
  }
  return path.join(directory, match);
}

function run(command, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const output = [];
    if (options.quiet) {
      child.stdout.on("data", (chunk) => output.push(chunk));
      child.stderr.on("data", (chunk) => output.push(chunk));
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) {
        resolve();
        return;
      }
      const detail = options.quiet ? `\n${Buffer.concat(output).toString("utf8")}` : "";
      reject(
        new Error(`${command} ${args.join(" ")} failed with ${signal ?? code ?? "unknown"}${detail}`),
      );
    });
  });
}
