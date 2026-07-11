import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { openAutomationStore } from "../src/automation/index.ts";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE_ENTRYPOINT = path.join(REPOSITORY_ROOT, "apps", "meka", "src", "main.ts");
const TSX_IMPORT = import.meta.resolve("tsx");

test("direct job cancellation cannot settle an active daemon-owned worker", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-cli-jobs-test-"));
  const workspace = path.join(temporaryDirectory, "workspace");
  const stateRoot = path.join(temporaryDirectory, "state");
  await mkdir(workspace);
  const store = await Effect.runPromise(openAutomationStore({ cwd: workspace, stateRoot }));

  try {
    const queued = await Effect.runPromise(
      store.enqueueJob({
        id: "active-worker",
        queueName: "default",
        payload: { kind: "test.active-worker" },
      }),
    );
    const claimResult = await Effect.runPromise(store.claimNextJob({ queueName: "default" }));
    if (claimResult.kind !== "claimed") {
      throw new Error(`Expected claimed job, received ${claimResult.kind}`);
    }
    await Effect.runPromise(
      store.startJob({
        jobId: queued.job.id,
        leaseToken: claimResult.claim.leaseToken,
      }),
    );

    const cancellation = await executeCli([
      "jobs",
      "cancel",
      queued.job.id,
      "--lease-token",
      claimResult.claim.leaseToken,
      "--cwd",
      workspace,
      "--state-root",
      stateRoot,
    ]);

    expect(cancellation).toMatchObject({ code: 2, stdout: "" });
    expect(cancellation.stderr).toContain("--lease-token cannot be used from the state CLI");
    expect(cancellation.stderr).toContain("meka interrupt <run-id>");
    await expect(Effect.runPromise(store.getJob(queued.job.id))).resolves.toMatchObject({
      status: "running",
    });
    await expect(Effect.runPromise(store.getJobAttempts(queued.job.id))).resolves.toMatchObject([
      { status: "running", leaseToken: claimResult.claim.leaseToken },
    ]);

    const tokenlessCancellation = await executeCli([
      "jobs",
      "cancel",
      queued.job.id,
      "--cwd",
      workspace,
      "--state-root",
      stateRoot,
    ]);
    expect(tokenlessCancellation).toMatchObject({ code: 2, stdout: "" });
    expect(tokenlessCancellation.stderr).toContain(
      "Active jobs cannot be canceled from the state CLI",
    );
    expect(tokenlessCancellation.stderr).toContain("meka interrupt <run-id>");
    await expect(Effect.runPromise(store.getJob(queued.job.id))).resolves.toMatchObject({
      status: "running",
    });
    await expect(Effect.runPromise(store.getJobAttempts(queued.job.id))).resolves.toMatchObject([
      { status: "running", leaseToken: claimResult.claim.leaseToken },
    ]);
  } finally {
    await Effect.runPromise(store.close());
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("job help describes the pending and daemon-owned cancellation boundary", async () => {
  const help = await executeCli(["jobs", "--help"]);

  expect(help).toMatchObject({ code: 0, stderr: "" });
  expect(help.stdout).toContain("jobs cancel only settles pending jobs");
  expect(help.stdout).toContain("meka interrupt");
  expect(help.stdout).not.toContain("--lease-token TOKEN");
});

test("direct job cancellation still settles pending work", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-cli-pending-job-test-"));
  const workspace = path.join(temporaryDirectory, "workspace");
  const stateRoot = path.join(temporaryDirectory, "state");
  await mkdir(workspace);
  const store = await Effect.runPromise(openAutomationStore({ cwd: workspace, stateRoot }));

  try {
    const queued = await Effect.runPromise(
      store.enqueueJob({
        id: "pending-worker",
        queueName: "default",
        payload: { kind: "test.pending-worker" },
      }),
    );
    const cancellation = await executeCli([
      "jobs",
      "cancel",
      queued.job.id,
      "--reason",
      "operator canceled before dispatch",
      "--cwd",
      workspace,
      "--state-root",
      stateRoot,
    ]);

    expect(cancellation).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(cancellation.stdout) as unknown).toMatchObject({ status: "canceled" });
    await expect(Effect.runPromise(store.getJobDetail(queued.job.id))).resolves.toMatchObject({
      status: "canceled",
      error: "operator canceled before dispatch",
    });
  } finally {
    await Effect.runPromise(store.close());
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

async function executeCli(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", TSX_IMPORT, SOURCE_ENTRYPOINT, ...args],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: path.join(REPOSITORY_ROOT, "tsconfig.base.json"),
        },
        timeout: 20_000,
      },
      (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== "number")) {
          reject(error);
          return;
        }
        const code = error && typeof error.code === "number" ? error.code : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}
