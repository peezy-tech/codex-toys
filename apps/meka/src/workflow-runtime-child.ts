import { pathToFileURL } from "node:url";
import {
  DurableJobs,
  Effect,
  MekaRuns,
  executeWorkflow,
  getWorkflowTriggers,
  isMekaWorkflow,
  registerWorkflow,
  type AnyMekaWorkflow,
  type DurableJob,
  type DurableJobRequest,
  type ManagedMekaRunRequest,
  type WorkflowExecutionResult,
  type WorkflowServiceError,
} from "@meka/workflow";

type InitialMessage =
  | { type: "inspect"; filePath: string }
  | {
      type: "execute";
      filePath: string;
      identity: { id: string; on: string[]; revision: string; hash: string };
      event: unknown;
    };

type ResponseMessage =
  | { type: "call.result"; id: number; value: unknown }
  | { type: "call.error"; id: number; message: string };

const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
let nextCallId = 1;

process.on("message", (raw: unknown) => {
  const message = raw as InitialMessage | ResponseMessage;
  if (message.type === "call.result" || message.type === "call.error") {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.type === "call.result") request.resolve(message.value);
    else request.reject(new Error(message.message));
    return;
  }
  void run(message).catch((error: unknown) => {
    send({ type: "fatal", message: error instanceof Error ? error.message : String(error) });
  });
});

async function run(message: InitialMessage): Promise<void> {
  const workflow = await loadWorkflow(message.filePath);
  if (message.type === "inspect") {
    send({
      type: "inspect.result",
      value: { id: workflow.id, on: [...getWorkflowTriggers(workflow)] },
    });
    return;
  }
  if (
    workflow.id !== message.identity.id ||
    !sameStrings(getWorkflowTriggers(workflow), message.identity.on)
  ) {
    throw new Error("Workflow metadata changed after registration; register the file again");
  }
  const registered = registerWorkflow(workflow, message.identity);
  const jobs = {
    enqueue: (request: DurableJobRequest) => hostEffect<DurableJob>("jobs.enqueue", { request }),
    read: (jobId: string) => hostEffect<DurableJob | null>("jobs.read", { jobId }),
    cancel: (jobId: string, options?: { readonly reason?: string }) =>
      hostEffect<DurableJob>("jobs.cancel", { jobId, reason: options?.reason }),
  };
  const runs = {
    enqueue: (request: ManagedMekaRunRequest) =>
      hostEffect<DurableJob>("runs.enqueue", { request }),
  };
  const effect = executeWorkflow(registered, message.event).pipe(
    Effect.provideService(DurableJobs, jobs),
    Effect.provideService(MekaRuns, runs),
  );
  const result = await Effect.runPromise(
    effect as Effect.Effect<WorkflowExecutionResult, never, never>,
  );
  send({ type: "execute.result", value: result });
}

async function loadWorkflow(filePath: string): Promise<AnyMekaWorkflow> {
  const module = (await import(`${pathToFileURL(filePath).href}?meka=${Date.now()}`)) as Record<
    string,
    unknown
  >;
  const candidates = [module.default, module.workflow, ...Object.values(module)].filter(isWorkflow);
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) {
    throw new Error(
      unique.length === 0
        ? "Workflow module must export one Meka workflow (default or named `workflow`)"
        : "Workflow module exports more than one Meka workflow",
    );
  }
  return unique[0] as AnyMekaWorkflow;
}

function isWorkflow(value: unknown): value is AnyMekaWorkflow {
  return isMekaWorkflow(value);
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function hostEffect<T>(method: string, params: unknown): Effect.Effect<T, WorkflowServiceError> {
  return Effect.tryPromise({
    try: () => hostCall<T>(method, params),
    catch: (error): WorkflowServiceError => ({
      _tag: "WorkflowServiceError",
      operation: method,
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    }),
  });
}

function hostCall<T>(method: string, params: unknown): Promise<T> {
  const id = nextCallId++;
  const completion = Promise.withResolvers<unknown>();
  pending.set(id, completion);
  send({ type: "call", id, method, params });
  return completion.promise as Promise<T>;
}

function send(message: unknown): void {
  if (!process.send) throw new Error("Workflow child has no IPC channel");
  process.send(message);
}
