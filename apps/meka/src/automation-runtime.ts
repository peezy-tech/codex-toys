import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { Effect, Schema } from "effect";
import {
  DurableCommandPayloadSchema,
  DurableJobRequestSchema,
  ManagedMekaRunRequestSchema,
  type DurableCommandPayload,
  type DurableJob as WorkflowJob,
  type DurableJobRequest,
  type ManagedMekaRunRequest,
} from "@meka/workflow";
import { AutomationStore, openAutomationStore } from "./automation/store.ts";
import { AutomationValidationError } from "./automation/errors.ts";
import type {
  AgentHookEventInput,
  AutomationStateOptions,
  ClaimedJob,
  DurableJobDetail,
  QueuePolicy,
  SourceRegistration,
  SourceRegistrationInput,
  WorkflowEventDetail,
  WorkflowEventInput,
  WorkflowRegistration,
} from "./automation/types.ts";
import {
  decodeGitHubWebhook,
  pollRssSource,
  runCommandSource,
  runConfiguredCommand,
  type ConfiguredCommandResult,
} from "./sources.ts";
import {
  executeWorkflowModule,
  inspectWorkflowModule,
  type WorkflowExecution,
} from "./workflow-runtime.ts";
import { hashWorkflowRevision } from "./workflow-revision.ts";
import {
  drainHookIngress,
  registerHookIngressConsumer,
  releaseHookIngressConsumer,
  renewHookIngressConsumer,
  type HookIngressConsumerRegistration,
} from "./hook-ingress.ts";

const DEFAULT_QUEUE = "default";
const WORKFLOW_JOB_KIND = "meka.workflow";
const RUN_JOB_KIND = "meka.run";
const COMMAND_JOB_KIND = "command";

type JobEnvelope = {
  version: 1;
  kind: string;
  payload: unknown;
};

export type ManagedRunPayload = {
  runId: string;
  provider: "codex" | "claude";
  prompt: string;
  model?: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
};

export type ClaimedAutomationJob = {
  claim: ClaimedJob;
  envelope: JobEnvelope;
};

/** High-level durable automation operations shared by the CLI and daemon. */
export class AutomationRuntime {
  readonly cwd: string;
  readonly store: AutomationStore;
  readonly hookStateHome: string | undefined;
  #hookConsumer: HookIngressConsumerRegistration | undefined;
  #lastHookPruneAt = 0;

  private constructor(cwd: string, store: AutomationStore, hookStateHome?: string) {
    this.cwd = cwd;
    this.store = store;
    this.hookStateHome = hookStateHome;
  }

  static async open(options: AutomationStateOptions = {}): Promise<AutomationRuntime> {
    const cwd = await realpath(path.resolve(options.cwd ?? process.cwd()));
    const store = await Effect.runPromise(openAutomationStore({ ...options, cwd }));
    return new AutomationRuntime(cwd, store, options.stateHome);
  }

  async close(): Promise<void> {
    const consumer = this.#hookConsumer;
    this.#hookConsumer = undefined;
    const errors: unknown[] = [];
    if (consumer) {
      try {
        await releaseHookIngressConsumer(
          consumer,
          this.hookStateHome ? { stateHome: this.hookStateHome } : {},
        );
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await Effect.runPromise(this.store.close());
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Automation runtime cleanup did not complete cleanly");
    }
  }

  /** Activates deterministic hook routing for this long-lived daemon. */
  async activateHookIngressConsumer(): Promise<void> {
    if (this.#hookConsumer) return;
    this.#hookConsumer = await registerHookIngressConsumer({
      workspaceRoot: this.cwd,
      ...(this.hookStateHome ? { stateHome: this.hookStateHome } : {}),
    });
  }

  async configureQueue(policy: QueuePolicy): Promise<QueuePolicy> {
    return await Effect.runPromise(this.store.configureQueue(policy));
  }

  async registerWorkflow(
    filePath: string,
    queueName = DEFAULT_QUEUE,
  ): Promise<WorkflowRegistration> {
    const absolutePath = path.resolve(this.cwd, filePath);
    const module = await inspectWorkflowModule(absolutePath);
    const revisionHash = await hashWorkflowRevision(absolutePath);
    const existing = await Effect.runPromise(this.store.getWorkflowRegistration(module.id));
    if (existing) {
      return await Effect.runPromise(
        this.store.updateWorkflowRegistration({
          id: module.id,
          modulePath: absolutePath,
          revisionHash,
          triggerTypes: module.on,
          queueName,
          enabled: true,
        }),
      );
    }
    return await Effect.runPromise(
      this.store.createWorkflowRegistration({
        id: module.id,
        modulePath: absolutePath,
        revisionHash,
        triggerTypes: module.on,
        queueName,
      }),
    );
  }

  async ingestEvent(
    input: WorkflowEventInput,
    targetWorkflowId?: string,
  ): Promise<{ inserted: boolean; event: WorkflowEventDetail; jobIds: string[] }> {
    const ingested = await Effect.runPromise(this.store.ingestWorkflowEvent(input));
    const event = await Effect.runPromise(this.store.getWorkflowEvent(ingested.event.id));
    if (!event) throw new Error(`Ingested event disappeared: ${ingested.event.id}`);
    // Routing is intentionally replayable. Queue-scoped idempotency keys make
    // this safe and close the crash window between event commit and job commit.
    const jobIds = await this.enqueueEventWorkflows(event, targetWorkflowId);
    return { inserted: ingested.inserted, event, jobIds };
  }

  async enqueueEventWorkflows(
    event: WorkflowEventDetail,
    targetWorkflowId?: string,
  ): Promise<string[]> {
    const workflows = targetWorkflowId
      ? [await Effect.runPromise(this.store.getWorkflowRegistration(targetWorkflowId))].filter(
          (workflow): workflow is WorkflowRegistration => Boolean(workflow),
        )
      : await Effect.runPromise(
          this.store.listWorkflowRegistrations({ enabled: true, triggerType: event.type }),
        );
    const jobIds: string[] = [];
    for (const workflow of workflows) {
      if (!workflow.enabled) continue;
      if (!targetWorkflowId && !workflow.triggerTypes.includes(event.type)) continue;
      const routingIdentity = `workflow:${workflow.id}:${workflow.revisionHash}:${event.id}`;
      const result = await Effect.runPromise(
        this.store.enqueueJob({
          // Workflow routing is globally identified independently of the
          // current queue. Moving an unchanged registration to another queue
          // must not execute an already-routed event a second time.
          id: `job-workflow-${createHash("sha256").update(routingIdentity).digest("hex")}`,
          queueName: workflow.queueName,
          idempotencyKey: routingIdentity,
          payload: envelope(WORKFLOW_JOB_KIND, {
            workflowId: workflow.id,
            revisionHash: workflow.revisionHash,
            eventId: event.id,
          }),
        }),
      );
      jobIds.push(result.job.id);
    }
    return jobIds;
  }

  async runWorkflow(
    workflowId: string,
    payload: unknown,
  ): Promise<{
    inserted: boolean;
    event: WorkflowEventDetail;
    jobIds: string[];
  }> {
    const workflow = await Effect.runPromise(this.store.getWorkflowRegistration(workflowId));
    if (!workflow) throw new Error(`Workflow registration not found: ${workflowId}`);
    return await this.ingestEvent(
      {
        type: `meka.manual.${workflowId}`,
        source: "meka:manual",
        deliveryId: randomUUID(),
        verified: true,
        payload,
      },
      workflowId,
    );
  }

  async enqueueJob(requestInput: DurableJobRequest): Promise<WorkflowJob> {
    const request = await Effect.runPromise(
      Schema.decodeUnknown(DurableJobRequestSchema)(requestInput),
    );
    if (request.kind !== COMMAND_JOB_KIND) {
      throw new Error(
        `Unsupported durable job kind: ${request.kind}. Use DurableCommand for commands or MekaRuns for provider work.`,
      );
    }
    const payload = await decodeCommandPayload(request.payload);
    const result = await Effect.runPromise(
      this.store.enqueueJob({
        queueName: request.queue,
        idempotencyKey: request.idempotencyKey,
        priority: request.priority,
        notBefore: request.notBefore,
        payload: envelope(COMMAND_JOB_KIND, payload),
      }),
    );
    return await this.readWorkflowJob(result.job.id);
  }

  async enqueueRun(requestInput: ManagedMekaRunRequest, runId?: string): Promise<WorkflowJob> {
    const request = await Effect.runPromise(
      Schema.decodeUnknown(ManagedMekaRunRequestSchema)(requestInput),
    );
    const effectiveRunId =
      runId ??
      (request.idempotencyKey
        ? `run-${createHash("sha256")
            .update(`${request.queue}\0${request.idempotencyKey}`)
            .digest("hex")}`
        : randomUUID());
    const payload: ManagedRunPayload = {
      runId: effectiveRunId,
      provider: request.intent.provider,
      prompt: request.intent.prompt,
      ...(request.intent.model ? { model: request.intent.model } : {}),
      ...(request.intent.cwd ? { cwd: request.intent.cwd } : {}),
      ...(request.intent.metadata ? { metadata: { ...request.intent.metadata } } : {}),
    };
    const result = await Effect.runPromise(
      this.store.enqueueJob({
        queueName: request.queue,
        idempotencyKey: request.idempotencyKey,
        priority: request.priority,
        notBefore: request.notBefore,
        payload: envelope(RUN_JOB_KIND, payload),
      }),
    );
    return await this.readWorkflowJob(result.job.id);
  }

  async readWorkflowJob(jobId: string): Promise<WorkflowJob> {
    const detail = await Effect.runPromise(this.store.getJobDetail(jobId));
    if (!detail) throw new Error(`Durable job not found: ${jobId}`);
    return toWorkflowJob(detail);
  }

  async cancelWorkflowJob(jobId: string, reason?: string): Promise<WorkflowJob> {
    await Effect.runPromise(this.store.cancelJob({ jobId, reason }));
    return await this.readWorkflowJob(jobId);
  }

  async claim(
    queueName: string,
    options: { allowManagedRuns?: boolean } = {},
  ): Promise<ClaimedAutomationJob | undefined> {
    for (;;) {
      const result = await Effect.runPromise(
        this.store.claimNextJob({
          queueName,
          ...(options.allowManagedRuns === false ? { excludePayloadKinds: [RUN_JOB_KIND] } : {}),
        }),
      );
      if (result.kind !== "claimed") return undefined;
      try {
        return { claim: result.claim, envelope: parseEnvelope(result.claim.payload) };
      } catch (error) {
        // A damaged or legacy envelope has already consumed one admitted
        // attempt. Settle it before looking for the next candidate so it
        // cannot expire, requeue forever, and starve the queue.
        await Effect.runPromise(
          this.store.failJob({
            jobId: result.claim.job.id,
            leaseToken: result.claim.leaseToken,
            error: {
              type: "meka.invalid_job_envelope",
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
      }
    }
  }

  async executeInternalJob(
    job: ClaimedAutomationJob,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkflowExecution | ConfiguredCommandResult> {
    switch (job.envelope.kind) {
      case WORKFLOW_JOB_KIND:
        return await this.executeWorkflowJob(job, options.signal);
      case COMMAND_JOB_KIND:
        return await this.executeCommandJob(job, options.signal);
      default:
        throw new Error(`No Meka executor is registered for job kind: ${job.envelope.kind}`);
    }
  }

  async drainHookSpool(limit = 100): Promise<{ ingested: number; duplicates: number }> {
    if (this.#hookConsumer) {
      try {
        this.#hookConsumer = await renewHookIngressConsumer(
          this.#hookConsumer,
          this.hookStateHome ? { stateHome: this.hookStateHome } : {},
        );
      } catch {
        this.#hookConsumer = await registerHookIngressConsumer({
          workspaceRoot: this.cwd,
          ...(this.hookStateHome ? { stateHome: this.hookStateHome } : {}),
        });
      }
    }
    let ingested = 0;
    let duplicates = 0;
    const entries = await Effect.runPromise(this.store.listSpoolEntries(limit));
    for (const entry of entries) {
      if (entry.kind !== "agent.hook") continue;
      const detail = await Effect.runPromise(this.store.readSpoolEntry(entry.id));
      if (!detail) continue;
      const payload = detail.payload as AgentHookEventInput;
      try {
        if (await this.ingestHookInput(payload)) ingested += 1;
        else duplicates += 1;
      } catch (error) {
        if (!(error instanceof AutomationValidationError)) throw error;
      }
      await Effect.runPromise(this.store.acknowledgeSpoolEntry(entry.id));
    }
    let drainError: unknown;
    try {
      await drainHookIngress(
        {
          workspaceRoot: this.cwd,
          limit,
          ...(this.#hookConsumer
            ? {
                consumerId: this.#hookConsumer.consumerId,
                consumerToken: this.#hookConsumer.token,
              }
            : {}),
          ...(this.hookStateHome ? { stateHome: this.hookStateHome } : {}),
        },
        async (claim) => {
          const result = await this.ingestHookInput(claim.input);
          if (result) ingested += 1;
          else duplicates += 1;
        },
      );
    } catch (error) {
      drainError = error;
    }
    const now = Date.now();
    if (ingested > 0 || duplicates > 0 || now - this.#lastHookPruneAt >= 60_000) {
      await Effect.runPromise(this.store.prunePersistedHookEvents({ now }));
      this.#lastHookPruneAt = now;
    }
    if (drainError !== undefined) throw drainError;
    return { ingested, duplicates };
  }

  private async ingestHookInput(payload: AgentHookEventInput): Promise<boolean> {
    const hook = await Effect.runPromise(this.store.ingestAgentHookEvent(payload));
    const routed = await this.ingestEvent({
      type: `agent.${payload.provider ?? payload.source}.${payload.eventType}`,
      source: `agent:${payload.provider ?? payload.source}`,
      deliveryId: payload.sourceEventId,
      verified: true,
      observedAt: payload.occurredAt,
      metadata: {
        ...(payload.provider ? { provider: payload.provider } : {}),
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      },
      payload: payload.payload ?? {},
    });
    return hook.inserted || routed.inserted;
  }

  async createSource(input: SourceRegistrationInput): Promise<SourceRegistration> {
    return await Effect.runPromise(this.store.createSourceRegistration(input));
  }

  async pollRssSource(sourceId: string): Promise<unknown> {
    const source = await this.requireSource(sourceId, "rss");
    const config = asRecord(source.config, "RSS source config");
    const result = await Effect.runPromise(
      pollRssSource({
        id: source.id,
        url: requiredString(config.url, "RSS source url"),
        ...(typeof config.eventType === "string" ? { eventType: config.eventType } : {}),
        ...(typeof config.timeoutMs === "number" ? { timeoutMs: config.timeoutMs } : {}),
        cursor: asRecordOrNull(source.cursor),
      }),
    );
    const ingested = [];
    for (const event of result.events) {
      ingested.push(
        await this.ingestEvent(
          {
            type: event.type,
            source: event.source,
            deliveryId: event.deliveryId,
            verified: event.verified,
            observedAt: event.observedAt,
            metadata: event.metadata,
            payload: event.payload,
          },
          source.workflowId,
        ),
      );
    }
    await Effect.runPromise(
      this.store.updateSourceRegistration({ id: source.id, cursor: result.cursor }),
    );
    return { sourceId, notModified: result.notModified, events: ingested };
  }

  async ingestGitHubSource(
    sourceId: string,
    input: { eventName: string; deliveryId: string; signature: string; body: Buffer },
  ): Promise<unknown> {
    const source = await this.requireSource(sourceId, "github");
    const config = asRecord(source.config, "GitHub source config");
    const allowed = Array.isArray(config.eventNames)
      ? config.eventNames.filter((value): value is string => typeof value === "string")
      : [];
    if (allowed.length > 0 && !allowed.includes(input.eventName)) {
      throw new Error(`GitHub event is not allowed for source ${sourceId}: ${input.eventName}`);
    }
    const secretEnv = requiredString(config.secretEnv, "GitHub source secretEnv");
    const secret = process.env[secretEnv];
    if (!secret)
      throw new Error(`GitHub webhook secret environment variable is not set: ${secretEnv}`);
    const event = await Effect.runPromise(decodeGitHubWebhook({ sourceId, secret, ...input }));
    return await this.ingestEvent(
      {
        type: event.type,
        source: event.source,
        deliveryId: event.deliveryId,
        verified: event.verified,
        observedAt: event.observedAt,
        metadata: event.metadata,
        payload: event.payload,
      },
      source.workflowId,
    );
  }

  async runCommandSource(sourceId: string): Promise<unknown> {
    const source = await this.requireSource(sourceId, "command");
    const config = asRecord(source.config, "command source config");
    const argv = stringArray(config.argv, "command source argv");
    const event = await Effect.runPromise(
      runCommandSource({
        id: sourceId,
        argv,
        cwd: this.cwd,
        ...(typeof config.eventType === "string" ? { eventType: config.eventType } : {}),
        ...(typeof config.timeoutMs === "number" ? { timeoutMs: config.timeoutMs } : {}),
      }),
    );
    return await this.ingestEvent(
      {
        type: event.type,
        source: event.source,
        deliveryId: event.deliveryId,
        verified: event.verified,
        observedAt: event.observedAt,
        metadata: event.metadata,
        payload: event.payload,
      },
      source.workflowId,
    );
  }

  private async executeWorkflowJob(
    job: ClaimedAutomationJob,
    signal?: AbortSignal,
  ): Promise<WorkflowExecution> {
    const payload = asRecord(job.envelope.payload, "workflow job payload");
    const workflowId = requiredString(payload.workflowId, "workflowId");
    const eventId = requiredString(payload.eventId, "eventId");
    const revisionHash = requiredString(payload.revisionHash, "revisionHash");
    const workflow = await Effect.runPromise(this.store.getWorkflowRegistration(workflowId));
    const event = await Effect.runPromise(this.store.getWorkflowEvent(eventId));
    if (!workflow || !event) throw new Error("Workflow registration or event no longer exists");
    if (workflow.revisionHash !== revisionHash) {
      throw new Error(`Workflow ${workflowId} changed after this job was enqueued`);
    }
    const actualHash = await hashWorkflowRevision(workflow.moduleRealpath);
    if (actualHash !== revisionHash) {
      throw new Error(
        `Workflow module graph changed without registration: ${workflow.moduleRealpath}`,
      );
    }
    // Trusted TypeScript can create arbitrary external side effects. Persist
    // that boundary before importing or invoking it so a daemon crash cannot
    // silently redispatch the same workflow attempt.
    await Effect.runPromise(
      this.store.markExternalDispatch({
        jobId: job.claim.job.id,
        leaseToken: job.claim.leaseToken,
        provider: "workflow",
      }),
    );
    const execution = await executeWorkflowModule({
      filePath: workflow.moduleRealpath,
      cwd: this.cwd,
      identity: {
        id: workflow.id,
        on: workflow.triggerTypes,
        revision: revisionHash.slice(0, 12),
        hash: revisionHash,
      },
      event: workflowEventEnvelope(event),
      signal,
      services: {
        enqueueJob: async (request) => await this.enqueueJob(request),
        enqueueRun: async (request) => await this.enqueueRun(request),
        readJob: async (jobId) => {
          const detail = await Effect.runPromise(this.store.getJobDetail(jobId));
          return detail ? toWorkflowJob(detail) : null;
        },
        cancelJob: async (jobId, reason) => await this.cancelWorkflowJob(jobId, reason),
      },
    });
    if (execution.result._tag === "failed") {
      await Effect.runPromise(
        this.store.failJob({
          jobId: job.claim.job.id,
          leaseToken: job.claim.leaseToken,
          error: execution.result.error,
        }),
      );
    } else {
      await Effect.runPromise(
        this.store.succeedJob({
          jobId: job.claim.job.id,
          leaseToken: job.claim.leaseToken,
          result: execution.result,
        }),
      );
    }
    return execution;
  }

  private async executeCommandJob(
    job: ClaimedAutomationJob,
    signal?: AbortSignal,
  ): Promise<ConfiguredCommandResult> {
    // Validate again before crossing the external-dispatch boundary. This also
    // protects execution of records written by older or damaged runtimes.
    const payload = await decodeCommandPayload(job.envelope.payload);
    await Effect.runPromise(
      // A configured command can have arbitrary external side effects. Mark
      // the dispatch boundary before spawn so crash recovery becomes
      // `uncertain` instead of executing the command a second time blindly.
      this.store.markExternalDispatch({
        jobId: job.claim.job.id,
        leaseToken: job.claim.leaseToken,
        provider: "command",
      }),
    );
    const result = await Effect.runPromise(
      runConfiguredCommand({
        argv: payload.argv,
        cwd: this.cwd,
        signal,
        ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
      }),
    );
    if (result.code === 0 && !result.timedOut) {
      await Effect.runPromise(
        this.store.succeedJob({
          jobId: job.claim.job.id,
          leaseToken: job.claim.leaseToken,
          result,
        }),
      );
    } else {
      await Effect.runPromise(
        this.store.failJob({
          jobId: job.claim.job.id,
          leaseToken: job.claim.leaseToken,
          error: result,
        }),
      );
    }
    return result;
  }

  private async requireSource(id: string, kind: string): Promise<SourceRegistration> {
    const source = await Effect.runPromise(this.store.getSourceRegistration(id));
    if (!source) throw new Error(`Source registration not found: ${id}`);
    if (!source.enabled) throw new Error(`Source registration is disabled: ${id}`);
    if (source.kind !== kind) throw new Error(`Source ${id} is ${source.kind}, not ${kind}`);
    return source;
  }
}

export function isManagedRunJob(job: ClaimedAutomationJob): boolean {
  return job.envelope.kind === RUN_JOB_KIND;
}

export function managedRunPayload(job: ClaimedAutomationJob): ManagedRunPayload {
  if (!isManagedRunJob(job)) throw new Error("Claim is not a managed Meka run");
  const payload = asRecord(job.envelope.payload, "managed run payload");
  const provider = payload.provider;
  if (provider !== "codex" && provider !== "claude") {
    throw new Error("Managed run provider must be codex or claude");
  }
  return {
    runId: requiredString(payload.runId, "runId"),
    provider,
    prompt: requiredString(payload.prompt, "prompt"),
    ...(typeof payload.model === "string" ? { model: payload.model } : {}),
    ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
    ...(asRecordOrNull(payload.metadata)
      ? { metadata: asRecordOrNull(payload.metadata) as Record<string, unknown> }
      : {}),
  };
}

function envelope(kind: string, payload: unknown): JobEnvelope {
  return { version: 1, kind, payload };
}

function parseEnvelope(value: unknown): JobEnvelope {
  const record = asRecord(value, "durable job envelope");
  if (record.version !== 1) throw new Error("Unsupported durable job envelope version");
  return {
    version: 1,
    kind: requiredString(record.kind, "durable job kind"),
    payload: record.payload,
  };
}

function toWorkflowJob(detail: DurableJobDetail): WorkflowJob {
  const value = parseEnvelope(detail.payload);
  return {
    id: detail.id,
    queue: detail.queueName,
    kind: value.kind,
    state: detail.status,
    payload: value.payload as WorkflowJob["payload"],
    ...(detail.idempotencyKey ? { idempotencyKey: detail.idempotencyKey } : {}),
    priority: detail.priority,
    notBefore: detail.notBefore,
    attempt: detail.attemptCount,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    ...(detail.error !== null ? { lastError: detail.error as WorkflowJob["lastError"] } : {}),
  };
}

function workflowEventEnvelope(event: WorkflowEventDetail): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    source: event.source,
    observedAt: event.observedAt,
    verified: event.verified,
    ...(event.deliveryId ? { deliveryId: event.deliveryId } : {}),
    ...(event.metadata !== null ? { metadata: event.metadata } : {}),
    payload: event.payload,
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  const result = asRecordOrNull(value);
  if (!result) throw new Error(`${label} must be an object`);
  return result;
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function stringArray(value: unknown, label: string): [string, ...string[]] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value as [string, ...string[]];
}

async function decodeCommandPayload(value: unknown): Promise<DurableCommandPayload> {
  return await Effect.runPromise(Schema.decodeUnknown(DurableCommandPayloadSchema)(value));
}
