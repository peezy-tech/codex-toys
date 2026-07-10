import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await mkdtemp(path.join(os.tmpdir(), "meka-package-install-"));
const packages = path.join(fixture, "packages");
const consumer = path.join(fixture, "consumer");
const workspace = path.join(fixture, "workspace");
let daemon;

try {
  await mkdir(packages);
  await mkdir(consumer);
  await mkdir(workspace);
  process.stdout.write("Cleaning package build artifacts...\n");
  await run("pnpm", ["run", "clean"], root);
  process.stdout.write("Packing @meka/workflow...\n");
  await run("pnpm", ["--filter", "@meka/workflow", "pack", "--pack-destination", packages], root, {
    quiet: true,
  });
  process.stdout.write("Packing @meka/sdk...\n");
  await run("pnpm", ["--filter", "@meka/sdk", "pack", "--pack-destination", packages], root, {
    quiet: true,
  });
  process.stdout.write("Packing @meka/app...\n");
  await run("pnpm", ["--filter", "@meka/app", "pack", "--pack-destination", packages], root, {
    quiet: true,
  });
  const archives = await readdir(packages);
  const sdk = archive(packages, archives, "meka-sdk-");
  const workflow = archive(packages, archives, "meka-workflow-");
  const app = archive(packages, archives, "meka-app-");
  process.stdout.write("Installing the three archives into a clean consumer...\n");
  await run("npm", ["install", "--no-package-lock", workflow, sdk, app], consumer);
  await access(
    path.join(
      consumer,
      "node_modules",
      "@meka",
      "app",
      "assets",
      "meka-integrations",
      "plugins",
      "meka",
      "scripts",
      "meka-hook-relay.mjs",
    ),
  );
  await access(
    path.join(
      consumer,
      "node_modules",
      "@meka",
      "app",
      "assets",
      "meka-integrations",
      ".agents",
      "plugins",
      "marketplace.json",
    ),
  );
  await access(
    path.join(
      consumer,
      "node_modules",
      "@meka",
      "app",
      "assets",
      "meka-integrations",
      ".claude-plugin",
      "marketplace.json",
    ),
  );
  process.stdout.write("Importing the installed workflow authoring API...\n");
  await run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { MekaWorkflow, Schema, Effect, WorkflowDecision } from "@meka/workflow"; MekaWorkflow.make({ id: "smoke", input: Schema.Unknown, handler: () => Effect.succeed(WorkflowDecision.completed()) });',
    ],
    consumer,
  );
  const workflowFile = path.join(workspace, "smoke-workflow.ts");
  await writeFile(
    workflowFile,
    `import { DurableCommand, DurableJobs, Effect, MekaWorkflow, Schema, WorkflowDecision } from "@meka/workflow";\nexport default MekaWorkflow.make({ id: "package-smoke", input: Schema.Unknown, handler: (event) => Effect.gen(function* () { const jobs = yield* DurableJobs; const job = yield* jobs.enqueue(DurableCommand.make({ queue: "package-actions", argv: [process.execPath, "-e", "process.stdout.write('package-action-ok')"], idempotencyKey: event.id })); return WorkflowDecision.enqueued([job.id]); }) });\n`,
    "utf8",
  );
  process.stdout.write("Registering a TypeScript workflow from outside the install tree...\n");
  const meka = path.join(consumer, "node_modules", ".bin", "meka");
  const stateRoot = path.join(fixture, "state");
  const runtimeRoot = path.join(fixture, "runtime");
  await run(
    meka,
    [
      "queue",
      "configure",
      "package-actions",
      "--concurrency",
      "1",
      "--window-ms",
      "60000",
      "--max-starts",
      "10",
      "--lease-ms",
      "60000",
      "--cwd",
      workspace,
      "--state-root",
      stateRoot,
    ],
    workspace,
  );
  await run(
    meka,
    [
      "workflow",
      "add",
      workflowFile,
      "--cwd",
      workspace,
      "--state-root",
      stateRoot,
    ],
    workspace,
  );
  process.stdout.write("Running the installed CLI...\n");
  await run(meka, ["--help"], consumer);
  process.stdout.write("Starting the installed daemon and executing a queued workflow...\n");
  daemon = await startDaemon(
    meka,
    [
      "serve",
      "--cwd",
      workspace,
      "--runtime-root",
      runtimeRoot,
      "--state-root",
      stateRoot,
    ],
    workspace,
  );
  await run(meka, ["status", "--socket", daemon.ready.socketPath], workspace, { quiet: true });
  const execution = JSON.parse(
    await runCaptured(
      meka,
      ["workflow", "run", "package-smoke", "--cwd", workspace, "--state-root", stateRoot],
      workspace,
      "{}\n",
    ),
  );
  const jobId = execution.jobIds?.[0];
  if (typeof jobId !== "string") {
    throw new Error("Installed workflow run did not enqueue a durable job");
  }
  await waitForJob(meka, jobId, workspace, stateRoot);
  await waitForQueueJob(meka, "package-actions", workspace, stateRoot);
  await stopDaemon(daemon.child);
  daemon = undefined;
  process.stdout.write("Clean package-install check passed.\n");
} finally {
  if (daemon) await stopDaemon(daemon.child);
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
        new Error(
          `${command} ${args.join(" ")} failed with ${signal ?? code ?? "unknown"}${detail}`,
        ),
      );
    });
  });
}

function runCaptured(command, args, cwd, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal ?? code ?? "unknown"}\n${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
    child.stdin.end(input);
  });
}

function startDaemon(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Installed daemon did not become ready\n${stderr}`));
    }, 15_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      try {
        const ready = JSON.parse(stdout.slice(0, newline));
        if (typeof ready.socketPath !== "string") throw new Error("missing socketPath");
        settled = true;
        clearTimeout(timer);
        resolve({ child, ready });
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error(`Installed daemon emitted invalid readiness JSON: ${error.message}`));
      }
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Installed daemon exited before readiness with ${signal ?? code ?? "unknown"}\n${stderr}`,
        ),
      );
    });
  });
}

async function waitForJob(command, jobId, cwd, stateRoot) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const output = await runCaptured(
      command,
      ["jobs", "show", jobId, "--cwd", cwd, "--state-root", stateRoot],
      cwd,
    );
    const status = JSON.parse(output).job?.status;
    if (status === "succeeded") return;
    if (["failed", "canceled", "uncertain"].includes(status)) {
      throw new Error(`Installed workflow job ended in ${status}: ${output.trim()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Installed workflow job did not finish: ${jobId}`);
}

async function waitForQueueJob(command, queueName, cwd, stateRoot) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const output = await runCaptured(
      command,
      ["jobs", "list", "--queue", queueName, "--cwd", cwd, "--state-root", stateRoot],
      cwd,
    );
    const jobs = JSON.parse(output);
    if (jobs.some((job) => job.status === "succeeded")) return;
    const terminalFailure = jobs.find((job) =>
      ["failed", "canceled", "uncertain"].includes(job.status),
    );
    if (terminalFailure) {
      throw new Error(
        `Installed command action ended in ${terminalFailure.status}: ${output.trim()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Installed command action did not finish in queue: ${queueName}`);
}

function stopDaemon(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
