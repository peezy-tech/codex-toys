import { Context } from "effect";
import type { Effect } from "effect";
import type {
  DurableJob,
  DurableJobRequest,
  ManagedMekaRunRequest,
  WorkflowServiceError,
} from "./model.ts";

/** Durable job operations exposed to a workflow handler. */
export interface DurableJobsService {
  readonly enqueue: (request: DurableJobRequest) => Effect.Effect<DurableJob, WorkflowServiceError>;
  readonly read: (jobId: string) => Effect.Effect<DurableJob | null, WorkflowServiceError>;
  readonly cancel: (
    jobId: string,
    options?: { readonly reason?: string },
  ) => Effect.Effect<DurableJob, WorkflowServiceError>;
}

export const DurableJobs = Context.GenericTag<DurableJobsService>("@meka/workflow/DurableJobs");

/**
 * The only workflow-facing path for creating provider runs. Implementations
 * persist the intent in its configured queue before asking Meka to execute it.
 */
export interface MekaRunsService {
  readonly enqueue: (
    request: ManagedMekaRunRequest,
  ) => Effect.Effect<DurableJob, WorkflowServiceError>;
}

export const MekaRuns = Context.GenericTag<MekaRunsService>("@meka/workflow/MekaRuns");
