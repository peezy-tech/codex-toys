import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import type { DurableJob } from "@meka/workflow";
import { executeWorkflowModule, inspectWorkflowModule } from "../src/workflow-runtime.ts";

test("inspects and executes a TypeScript workflow through host services", async () => {
  const parent = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(`${parent}.workflow-test-`);
  const modulePath = `${directory}/review.ts`;
  await writeFile(
    modulePath,
    `
      import { Effect, MekaRuns, MekaWorkflow, Schema, WorkflowDecision } from "@meka/workflow";
      export default MekaWorkflow.make({
        id: "review-new-pr",
        on: ["github.pull_request", "a.first"],
        input: Schema.Struct({ action: Schema.String, number: Schema.Number }),
        handler: (event) => Effect.gen(function* () {
          if (event.payload.action !== "opened") return WorkflowDecision.skipped("not opened");
          const runs = yield* MekaRuns;
          const job = yield* runs.enqueue({
            queue: "reviews",
            intent: { _tag: "meka.run", provider: "codex", prompt: "Review PR " + event.payload.number },
          });
          return WorkflowDecision.enqueued([job.id]);
        }),
      });
    `,
    "utf8",
  );
  try {
    await expect(inspectWorkflowModule(modulePath)).resolves.toEqual({
      id: "review-new-pr",
      on: ["github.pull_request", "a.first"],
    });
    const requested: unknown[] = [];
    const durableJob = makeJob("run-job-1");
    const execution = await executeWorkflowModule({
      filePath: modulePath,
      cwd: directory,
      identity: {
        id: "review-new-pr",
        on: ["a.first", "github.pull_request"],
        revision: "1",
        hash: "abc123",
      },
      event: {
        id: "event-1",
        type: "github.pull_request",
        source: "github:test",
        observedAt: new Date().toISOString(),
        verified: true,
        deliveryId: "delivery-1",
        payload: { action: "opened", number: 42 },
      },
      services: {
        enqueueRun: async (request) => {
          requested.push(request);
          return durableJob;
        },
        enqueueJob: async () => durableJob,
        readJob: async () => durableJob,
        cancelJob: async () => durableJob,
      },
    });
    expect(execution.result).toMatchObject({
      _tag: "completed",
      workflow: { id: "review-new-pr", revision: "1", hash: "abc123" },
      decision: { _tag: "enqueued", jobIds: ["run-job-1"] },
    });
    expect(requested).toEqual([
      {
        queue: "reviews",
        intent: { _tag: "meka.run", provider: "codex", prompt: "Review PR 42" },
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("executes a workflow from the configured workspace cwd", async () => {
  const parent = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(`${parent}.workflow-cwd-test-`);
  const workspace = `${directory}/workspace`;
  const modulePath = `${directory}/cwd.ts`;
  await mkdir(workspace);
  await writeFile(
    modulePath,
    `
      import { writeFileSync } from "node:fs";
      import { Effect, MekaWorkflow, Schema, WorkflowDecision } from "@meka/workflow";
      export default MekaWorkflow.make({
        id: "workflow-cwd",
        input: Schema.Unknown,
        handler: () => {
          writeFileSync("observed-cwd.txt", process.cwd());
          return Effect.succeed(WorkflowDecision.completed());
        },
      });
    `,
    "utf8",
  );
  try {
    await executeWorkflowModule({
      filePath: modulePath,
      cwd: workspace,
      identity: { id: "workflow-cwd", on: [], revision: "1", hash: "cwd" },
      event: workflowEvent("event-cwd"),
      services: unusedServices(),
    });
    expect(await readFile(`${workspace}/observed-cwd.txt`, "utf8")).toBe(workspace);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminates workflow descendants when a one-shot child times out", async () => {
  if (process.platform === "win32") return;
  const parent = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(`${parent}.workflow-tree-test-`);
  const modulePath = `${directory}/tree.ts`;
  const pidPath = `${directory}/descendant.pid`;
  let descendantPid: number | undefined;
  await writeFile(
    modulePath,
    `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { Effect, MekaWorkflow, Schema } from "@meka/workflow";
      export default MekaWorkflow.make({
        id: "workflow-tree-timeout",
        input: Schema.Unknown,
        handler: () => Effect.async(() => {
          const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
          writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
        }),
      });
    `,
    "utf8",
  );
  try {
    await expect(
      executeWorkflowModule({
        filePath: modulePath,
        cwd: directory,
        identity: { id: "workflow-tree-timeout", on: [], revision: "1", hash: "tree" },
        event: {
          id: "event-tree",
          type: "manual",
          source: "test",
          observedAt: new Date().toISOString(),
          verified: true,
          payload: {},
        },
        services: unusedServices(),
        timeoutMs: 1_500,
      }),
    ).rejects.toThrow("Workflow child timed out");
    descendantPid = Number(await readFile(pidPath, "utf8"));
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    await waitForProcessExit(descendantPid);
  } finally {
    if (descendantPid && isProcessAlive(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminates workflow descendants after normal completion", async () => {
  if (process.platform === "win32") return;
  const parent = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(`${parent}.workflow-complete-tree-test-`);
  const modulePath = `${directory}/tree.ts`;
  const pidPath = `${directory}/descendant.pid`;
  let descendantPid: number | undefined;
  await writeFile(
    modulePath,
    `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { Effect, MekaWorkflow, Schema, WorkflowDecision } from "@meka/workflow";
      export default MekaWorkflow.make({
        id: "workflow-tree-complete",
        input: Schema.Unknown,
        handler: () => {
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
          child.unref();
          writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
          return Effect.succeed(WorkflowDecision.completed());
        },
      });
    `,
    "utf8",
  );
  try {
    await expect(
      executeWorkflowModule({
        filePath: modulePath,
        cwd: directory,
        identity: { id: "workflow-tree-complete", on: [], revision: "1", hash: "tree" },
        event: workflowEvent("event-tree-complete"),
        services: unusedServices(),
      }),
    ).resolves.toMatchObject({ result: { _tag: "completed" } });
    descendantPid = Number(await readFile(pidPath, "utf8"));
    await waitForProcessExit(descendantPid);
  } finally {
    if (descendantPid && isProcessAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("aborts a workflow and its descendants", async () => {
  if (process.platform === "win32") return;
  const parent = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(`${parent}.workflow-abort-tree-test-`);
  const modulePath = `${directory}/tree.ts`;
  const pidPath = `${directory}/descendant.pid`;
  let descendantPid: number | undefined;
  await writeFile(
    modulePath,
    `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { Effect, MekaWorkflow, Schema } from "@meka/workflow";
      export default MekaWorkflow.make({
        id: "workflow-tree-abort",
        input: Schema.Unknown,
        handler: () => Effect.async(() => {
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
          child.unref();
          writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
        }),
      });
    `,
    "utf8",
  );
  const controller = new AbortController();
  try {
    const execution = executeWorkflowModule({
      filePath: modulePath,
      cwd: directory,
      identity: { id: "workflow-tree-abort", on: [], revision: "1", hash: "tree" },
      event: workflowEvent("event-tree-abort"),
      services: unusedServices(),
      signal: controller.signal,
    });
    descendantPid = Number(await waitForFile(pidPath));
    controller.abort(new Error("test stop"));
    await expect(execution).rejects.toThrow("Workflow execution aborted: test stop");
    await waitForProcessExit(descendantPid);
  } finally {
    controller.abort();
    if (descendantPid && isProcessAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects workflow results above the durable JSON ceiling", async () => {
  const parent = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(`${parent}.workflow-result-limit-test-`);
  const modulePath = `${directory}/large.ts`;
  await writeFile(
    modulePath,
    `
      import { Effect, MekaWorkflow, Schema, WorkflowDecision } from "@meka/workflow";
      export default MekaWorkflow.make({
        id: "workflow-large-result",
        input: Schema.Unknown,
        handler: () => Effect.succeed(WorkflowDecision.completed("x".repeat(800 * 1024))),
      });
    `,
    "utf8",
  );
  try {
    await expect(
      executeWorkflowModule({
        filePath: modulePath,
        cwd: directory,
        identity: { id: "workflow-large-result", on: [], revision: "1", hash: "large" },
        event: workflowEvent("event-large"),
        services: unusedServices(),
      }),
    ).rejects.toThrow("Workflow IPC message exceeds");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function makeJob(id: string): DurableJob {
  const now = new Date().toISOString();
  return {
    id,
    queue: "reviews",
    kind: "meka.run",
    state: "pending",
    payload: {},
    priority: 0,
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function unusedServices() {
  const job = makeJob("unused");
  return {
    enqueueRun: async () => job,
    enqueueJob: async () => job,
    readJob: async () => job,
    cancelJob: async () => job,
  };
}

function workflowEvent(id: string) {
  return {
    id,
    type: "manual",
    source: "test",
    observedAt: new Date().toISOString(),
    verified: true,
    payload: {},
  };
}

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Workflow descendant remained alive after timeout: ${pid}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}
