import { fork, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  DurableJob,
  DurableJobRequest,
  ManagedMekaRunRequest,
  WorkflowExecutionResult,
} from "@meka/workflow";
import { killProcessTree, USES_PROCESS_GROUPS } from "./process-tree.ts";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
// Workflow results are persisted in a store with a 1 MiB JSON ceiling. Keep
// the entire IPC envelope comfortably below it so a successful workflow can
// always be settled durably.
const MAX_MESSAGE_BYTES = 768 * 1024;
const MAX_LOG_BYTES = 64 * 1024;

export type WorkflowModuleInfo = {
  id: string;
  on: string[];
};

export type WorkflowIdentity = WorkflowModuleInfo & {
  revision: string;
  hash: string;
};

export type WorkflowHostServices = {
  enqueueJob(request: DurableJobRequest): Promise<DurableJob>;
  readJob(jobId: string): Promise<DurableJob | null>;
  cancelJob(jobId: string, reason?: string): Promise<DurableJob>;
  enqueueRun(request: ManagedMekaRunRequest): Promise<DurableJob>;
};

export type WorkflowExecution = {
  result: WorkflowExecutionResult;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

type ParentRequest =
  | { type: "inspect"; filePath: string }
  | {
      type: "execute";
      filePath: string;
      identity: WorkflowIdentity;
      event: unknown;
    }
  | { type: "call.result"; id: number; value: unknown }
  | { type: "call.error"; id: number; message: string };

type ChildMessage =
  | { type: "inspect.result"; value: WorkflowModuleInfo }
  | { type: "execute.result"; value: WorkflowExecutionResult }
  | {
      type: "call";
      id: number;
      method: "jobs.enqueue" | "jobs.read" | "jobs.cancel" | "runs.enqueue";
      params: unknown;
    }
  | { type: "fatal"; message: string };

/** Imports a trusted TypeScript workflow in a one-shot child process. */
export async function inspectWorkflowModule(
  filePath: string,
  timeoutMs = 30_000,
): Promise<WorkflowModuleInfo> {
  const resolved = await realpath(filePath);
  const outcome = await runChild<WorkflowModuleInfo>({
    initial: { type: "inspect", filePath: resolved },
    timeoutMs,
    terminalType: "inspect.result",
  });
  return outcome.value;
}

/**
 * Executes trusted workflow code outside the daemon process. Host operations
 * cross a narrow request/response IPC boundary and remain durable in Meka.
 */
export async function executeWorkflowModule(options: {
  filePath: string;
  cwd: string;
  identity: WorkflowIdentity;
  event: unknown;
  services: WorkflowHostServices;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<WorkflowExecution> {
  const resolved = await realpath(options.filePath);
  const resolvedCwd = await realpath(options.cwd);
  const outcome = await runChild<WorkflowExecutionResult>({
    initial: {
      type: "execute",
      filePath: resolved,
      identity: options.identity,
      event: options.event,
    },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    terminalType: "execute.result",
    services: options.services,
    signal: options.signal,
    cwd: resolvedCwd,
  });
  return { result: outcome.value, ...outcome.logs };
}

async function runChild<T>(options: {
  initial: ParentRequest;
  timeoutMs: number;
  terminalType: "inspect.result" | "execute.result";
  services?: WorkflowHostServices;
  signal?: AbortSignal;
  cwd?: string;
}): Promise<{ value: T; logs: CapturedLogs }> {
  if (options.signal?.aborted) {
    throw abortError(options.signal);
  }
  assertMessageSize(options.initial);
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const childPath = fileURLToPath(
    new URL(`./workflow-runtime-child.${extension}`, import.meta.url),
  );
  const aliasPath = fileURLToPath(new URL(`./workflow-module-alias.${extension}`, import.meta.url));
  const workflowModuleUrl =
    extension === "ts"
      ? new URL("../../../packages/workflow/src/index.ts", import.meta.url).href
      : import.meta.resolve("@meka/workflow");
  const tsxImport = import.meta.resolve("tsx");
  const child = fork(childPath, [], {
    cwd: options.cwd,
    execArgv: ["--import", tsxImport, "--import", aliasPath],
    // Give each one-shot workflow its own process group so timeout or normal
    // completion also terminates descendants accidentally left behind by
    // trusted workflow code.
    detached: USES_PROCESS_GROUPS,
    env: {
      ...process.env,
      MEKA_WORKFLOW_MODULE_URL: workflowModuleUrl,
      ...(extension === "ts"
        ? {
            TSX_TSCONFIG_PATH: fileURLToPath(
              new URL("../../../tsconfig.base.json", import.meta.url),
            ),
          }
        : {}),
    },
    serialization: "json",
    silent: true,
  });
  const stdout = capture(child.stdout, MAX_LOG_BYTES);
  const stderr = capture(child.stderr, MAX_LOG_BYTES);

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Workflow child timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    timer.unref();
    const onAbort = () => finish(abortError(options.signal as AbortSignal));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      child.removeAllListeners();
      const logs = { ...stdout.read(), ...asStderr(stderr.read()) };
      if (child.connected) child.disconnect();
      // A workflow invocation is one-shot. Descendants are never permitted to
      // survive its terminal result, timeout, abort, or premature child exit.
      killProcessTree(child);
      if (error) {
        const detail = logs.stderr ? `\nChild stderr:\n${logs.stderr}` : "";
        reject(new Error(`${error.message}${detail}`, { cause: error }));
      } else {
        resolve({ value: value as T, logs });
      }
    };

    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled) {
        finish(
          new Error(`Workflow child exited before responding (${signal ?? code ?? "unknown"})`),
        );
      }
    });
    child.on("message", (raw: unknown) => {
      void handleChildMessage(raw).catch((error: unknown) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );
    });

    const handleChildMessage = async (raw: unknown): Promise<void> => {
      assertMessageSize(raw);
      const message = asChildMessage(raw);
      if (message.type === options.terminalType) {
        finish(undefined, message.value as T);
        return;
      }
      if (message.type === "fatal") {
        finish(new Error(message.message));
        return;
      }
      if (message.type !== "call") {
        throw new Error(`Unexpected workflow child message: ${message.type}`);
      }
      if (!options.services) {
        send(child, { type: "call.error", id: message.id, message: "Host services unavailable" });
        return;
      }
      try {
        const value = await dispatchHostCall(options.services, message);
        send(child, { type: "call.result", id: message.id, value });
      } catch (error) {
        send(child, {
          type: "call.error",
          id: message.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    try {
      send(child, options.initial);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function dispatchHostCall(
  services: WorkflowHostServices,
  call: Extract<ChildMessage, { type: "call" }>,
): Promise<unknown> {
  const params = asRecord(call.params, "workflow host call parameters");
  switch (call.method) {
    case "jobs.enqueue":
      return await services.enqueueJob(params.request as DurableJobRequest);
    case "jobs.read":
      return await services.readJob(requiredString(params.jobId, "jobId"));
    case "jobs.cancel":
      return await services.cancelJob(
        requiredString(params.jobId, "jobId"),
        typeof params.reason === "string" ? params.reason : undefined,
      );
    case "runs.enqueue":
      return await services.enqueueRun(params.request as ManagedMekaRunRequest);
  }
}

function asChildMessage(value: unknown): ChildMessage {
  const record = asRecord(value, "workflow child message");
  if (typeof record.type !== "string") throw new Error("Workflow child message type is required");
  return record as ChildMessage;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function send(child: ChildProcess, message: ParentRequest): void {
  assertMessageSize(message);
  if (!child.connected) throw new Error("Workflow child IPC channel closed");
  child.send(message);
}

function assertMessageSize(message: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new Error(`Workflow IPC message exceeds ${MAX_MESSAGE_BYTES} bytes`);
  }
}

type Capture = { read(): { stdout: string; stdoutTruncated: boolean } };
type CapturedLogs = {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

function capture(stream: NodeJS.ReadableStream | null, limit: number): Capture {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  stream?.on("data", (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = limit - bytes;
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      chunks.push(retained);
      bytes += retained.length;
    }
    if (chunk.length > remaining) truncated = true;
  });
  return {
    read: () => ({ stdout: Buffer.concat(chunks).toString("utf8"), stdoutTruncated: truncated }),
  };
}

function asStderr(value: { stdout: string; stdoutTruncated: boolean }): {
  stderr: string;
  stderrTruncated: boolean;
} {
  return { stderr: value.stdout, stderrTruncated: value.stdoutTruncated };
}

function abortError(signal: AbortSignal): Error {
  const detail =
    signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "");
  const error = new Error(
    detail ? `Workflow execution aborted: ${detail}` : "Workflow execution aborted",
  );
  error.name = "AbortError";
  return error;
}
