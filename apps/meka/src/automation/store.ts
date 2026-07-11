import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { applyAutomationMigrations } from "./migrations.ts";
import { MIN_QUEUE_LEASE_MS } from "./constants.ts";
import {
  acknowledgeSpoolEntry,
  listSpoolEntries,
  readSpoolEntry,
  writeAtomicSpoolEntry,
} from "./spool.ts";
import {
  asAutomationError,
  AutomationConflictError,
  AutomationLeaseError,
  AutomationValidationError,
} from "./errors.ts";
import { ensureAutomationStateLocation } from "./state-root.ts";
import type {
  AgentEvent,
  AgentEventDetail,
  AgentHookEventInput,
  AutomationStateLocation,
  AutomationStateOptions,
  AutomationStoreInfo,
  AutomationTimestamp,
  CancelJobInput,
  ClaimNextJobInput,
  ClaimNextJobResult,
  ClaimedJob,
  CountExternalAgentSessionsOptions,
  CountJobsByStatusOptions,
  DurableJob,
  DurableJobInput,
  DurableJobAttempt,
  DurableJobDetail,
  DurableJobStatus,
  DurableJobStatusCounts,
  EnqueueJobResult,
  ExternalAgentSessionLease,
  IngestAndRouteWorkflowEventResult,
  IngestAgentEventResult,
  IngestWorkflowEventResult,
  JobCompletionInput,
  JobFailureInput,
  JobLeaseInput,
  LeaseRecovery,
  ListAgentEventsOptions,
  ListExternalAgentSessionsOptions,
  ListJobsOptions,
  ListSourceRegistrationsOptions,
  ListWorkflowRegistrationsOptions,
  ListWorkflowEventsOptions,
  MarkExternalDispatchInput,
  MarkJobUncertainInput,
  MarkProviderAcceptedInput,
  QueuePolicy,
  QueueUsage,
  PrunePersistedHookEventsOptions,
  PrunePersistedHookEventsResult,
  ReconcileUncertainJobInput,
  RenewJobLeaseInput,
  RetryJobInput,
  SourceRegistration,
  SourceRegistrationInput,
  SpoolEntry,
  SpoolEntryDetail,
  SpoolEntryInput,
  UpdateSourceRegistrationInput,
  UpdateWorkflowRegistrationInput,
  WorkflowRegistration,
  WorkflowRegistrationInput,
  WorkflowEvent,
  WorkflowEventDetail,
  WorkflowEventInput,
} from "./types.ts";

const DEFAULT_QUEUE_POLICY = {
  concurrency: 1,
  startWindowMs: 60_000,
  maxStartsPerWindow: 60,
  leaseMs: 60_000,
} as const;
const DEFAULT_QUEUE_NAME = "default";
const DEFAULT_EXTERNAL_SESSION_LEASE_MS = 5 * 60_000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_LIST_LIMIT = 10_000;
const DEFAULT_HOOK_EVENT_MAX_ENTRIES = 10_000;
const DEFAULT_HOOK_EVENT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;

type DbJobRow = {
  id: string;
  queue_name: string;
  status: DurableJobStatus;
  idempotency_key: string | null;
  idempotency_hash: string | null;
  payload_json: string;
  priority: number;
  not_before: number;
  attempt_count: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  external_dispatch_started_at: number | null;
  provider: string | null;
  provider_accepted_at: number | null;
  provider_reference: string | null;
  result_json: string | null;
  error_json: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

type DbAttemptRow = {
  id: number;
  job_id: string;
  attempt_number: number;
  status: DurableJobAttempt["status"];
  lease_token: string;
  leased_at: number;
  lease_expires_at: number;
  started_at: number | null;
  external_dispatch_started_at: number | null;
  provider: string | null;
  provider_accepted_at: number | null;
  provider_reference: string | null;
  finished_at: number | null;
  error_json: string | null;
};

type DbQueuePolicy = {
  queue_name: string;
  concurrency: number;
  start_window_ms: number;
  max_starts_per_window: number;
  lease_ms: number;
};

type DbAgentEventRow = {
  id: string;
  source: string;
  source_event_id: string;
  provider: string | null;
  session_id: string | null;
  event_type: string;
  occurred_at: number;
  received_at: number;
  payload_json: string;
  payload_hash: string;
};

type DbExternalSessionRow = {
  provider: string;
  session_id: string;
  state: ExternalAgentSessionLease["state"];
  lease_token: string;
  leased_until: number | null;
  first_event_id: string;
  last_event_id: string;
  created_at: number;
  updated_at: number;
  released_at: number | null;
  last_occurred_at: number | null;
};

type DbWorkflowRow = {
  id: string;
  module_realpath: string;
  revision_hash: string;
  trigger_types_json: string;
  enabled: number;
  queue_name: string;
  created_at: number;
  updated_at: number;
};

type DbSourceRow = {
  id: string;
  kind: string;
  enabled: number;
  workflow_id: string;
  config_json: string;
  cursor_json: string | null;
  dedupe_state_json: string | null;
  created_at: number;
  updated_at: number;
};

type DbWorkflowEventRow = {
  id: string;
  event_type: string;
  source: string;
  delivery_id: string | null;
  dedupe_key: string;
  verified: number;
  occurred_at: number;
  received_at: number;
  payload_json: string;
  payload_hash: string;
  metadata_json: string | null;
  metadata_hash: string | null;
};

type NormalizedAgentEvent = {
  id: string;
  source: string;
  sourceEventId: string;
  provider: string | null;
  sessionId: string | null;
  eventType: string;
  occurredAt: number;
  receivedAt: number;
  payloadJson: string;
  payloadHash: string;
  sessionLeaseMs: number;
};

/**
 * A synchronous SQLite core surfaced as typed Effects. It intentionally has no
 * network transport or provider calls; later server/CLI code can run these
 * effects at its boundary while keeping persistence and state transitions local.
 */
export class AutomationStore {
  readonly location: AutomationStateLocation;
  readonly schemaVersion: number;
  #database: DatabaseSync;
  #closed = false;

  private constructor(
    location: AutomationStateLocation,
    database: DatabaseSync,
    schemaVersion: number,
  ) {
    this.location = location;
    this.#database = database;
    this.schemaVersion = schemaVersion;
  }

  static unsafeOpen(options: AutomationStateOptions = {}): AutomationStore {
    const location = ensureAutomationStateLocation(options);
    assertPrivateDatabasePath(location.databasePath);
    const database = new DatabaseSync(location.databasePath);
    try {
      chmodSync(location.databasePath, 0o600);
      const schemaVersion = applyAutomationMigrations(database);
      return new AutomationStore(location, database, schemaVersion);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  info(): Effect.Effect<AutomationStoreInfo, ReturnType<typeof asAutomationError>> {
    return this.#effect("read automation store info", () => ({
      location: this.location,
      schemaVersion: this.schemaVersion,
    }));
  }

  close(): Effect.Effect<void, ReturnType<typeof asAutomationError>> {
    return Effect.try({
      try: () => {
        if (this.#closed) {
          return;
        }
        this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        this.#database.close();
        this.#closed = true;
      },
      catch: (cause) => asAutomationError("close automation store", cause),
    });
  }

  configureQueue(
    policy: QueuePolicy,
  ): Effect.Effect<QueuePolicy, ReturnType<typeof asAutomationError>> {
    return this.#effect("configure queue", () => {
      const normalized = normalizeQueuePolicy(policy);
      const now = Date.now();
      this.#database
        .prepare(
          `INSERT INTO automation_queue_policies(
             queue_name, concurrency, start_window_ms, max_starts_per_window, lease_ms, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(queue_name) DO UPDATE SET
             concurrency = excluded.concurrency,
             start_window_ms = excluded.start_window_ms,
             max_starts_per_window = excluded.max_starts_per_window,
             lease_ms = excluded.lease_ms,
             updated_at = excluded.updated_at`,
        )
        .run(
          normalized.queueName,
          normalized.concurrency,
          normalized.startWindowMs,
          normalized.maxStartsPerWindow,
          normalized.leaseMs,
          now,
        );
      return normalized;
    });
  }

  getQueuePolicy(
    queueName: string,
  ): Effect.Effect<QueuePolicy, ReturnType<typeof asAutomationError>> {
    return this.#effect("read queue policy", () =>
      this.#queuePolicy(assertName(queueName, "queue name"), true),
    );
  }

  /** Returns current values or the built-in defaults for a queue being configured. */
  getQueuePolicyTemplate(
    queueName: string,
  ): Effect.Effect<QueuePolicy, ReturnType<typeof asAutomationError>> {
    return this.#effect("read queue policy template", () =>
      this.#queuePolicy(assertName(queueName, "queue name")),
    );
  }

  /** Lists every configured queue plus Meka's built-in `default` queue. */
  listQueuePolicies(): Effect.Effect<QueuePolicy[], ReturnType<typeof asAutomationError>> {
    return this.#effect("list queue policies", () => this.#listQueuePoliciesUnsafe());
  }

  /** Reports the admission counters an operator needs to understand each queue. */
  listQueueUsage(
    nowInput?: AutomationTimestamp,
  ): Effect.Effect<QueueUsage[], ReturnType<typeof asAutomationError>> {
    return this.#effect("list queue usage", () => {
      const now = timestamp(nowInput, "now");
      const policies = this.#listQueuePoliciesUnsafe();
      return policies.map((policy) => {
        const pending = count(
          this.#database
            .prepare(
              "SELECT COUNT(*) AS count FROM automation_jobs WHERE queue_name = ? AND status = 'pending'",
            )
            .get(policy.queueName),
        );
        const active = count(
          this.#database
            .prepare(
              `SELECT COUNT(*) AS count FROM automation_jobs
               WHERE queue_name = ? AND status IN ('leased', 'running')
                 AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
            )
            .get(policy.queueName, now),
        );
        const windowStart = now - policy.startWindowMs;
        const starts = this.#database
          .prepare(
            `SELECT attempts.leased_at
             FROM automation_job_attempts AS attempts
             JOIN automation_jobs AS jobs ON jobs.id = attempts.job_id
             WHERE jobs.queue_name = ? AND attempts.leased_at > ?
             ORDER BY attempts.leased_at ASC, attempts.id ASC`,
          )
          .all(policy.queueName, windowStart) as Array<{ leased_at: number }>;
        const startsUsed = starts.length;
        const exhausted = startsUsed >= policy.maxStartsPerWindow;
        const releaseIndex = Math.max(0, startsUsed - policy.maxStartsPerWindow);
        const releasingStart = starts[releaseIndex]?.leased_at;
        return {
          ...policy,
          pending,
          active,
          concurrencyRemaining: Math.max(0, policy.concurrency - active),
          startsUsed,
          startsRemaining: Math.max(0, policy.maxStartsPerWindow - startsUsed),
          nextStartAt:
            exhausted && releasingStart !== undefined
              ? iso(releasingStart + policy.startWindowMs)
              : null,
        };
      });
    });
  }

  enqueueJob(
    input: DurableJobInput,
  ): Effect.Effect<EnqueueJobResult, ReturnType<typeof asAutomationError>> {
    return this.#effect("enqueue durable job", () =>
      this.#transaction(() => this.#enqueueJob(input)),
    );
  }

  claimNextJob(
    input: ClaimNextJobInput,
  ): Effect.Effect<ClaimNextJobResult, ReturnType<typeof asAutomationError>> {
    return this.#effect("claim durable job", () =>
      this.#transaction(() => this.#claimNextJob(input)),
    );
  }

  renewJobLease(
    input: RenewJobLeaseInput,
  ): Effect.Effect<DurableJob, ReturnType<typeof asAutomationError>> {
    return this.#effect("renew durable job lease", () =>
      this.#transaction(() => {
        const now = timestamp(input.now, "now");
        const job = this.#activeLease(input, now, ["leased", "running"]);
        const leaseMs = input.leaseMs ?? this.#queuePolicy(job.queue_name, true).leaseMs;
        assertQueueLeaseMs(leaseMs);
        const expiresAt = now + leaseMs;
        this.#database
          .prepare(
            "UPDATE automation_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?",
          )
          .run(expiresAt, now, job.id, input.leaseToken);
        this.#database
          .prepare(
            "UPDATE automation_job_attempts SET lease_expires_at = ? WHERE job_id = ? AND lease_token = ?",
          )
          .run(expiresAt, job.id, input.leaseToken);
        return toJob(this.#requireJob(job.id));
      }),
    );
  }

  startJob(input: JobLeaseInput): Effect.Effect<DurableJob, ReturnType<typeof asAutomationError>> {
    return this.#effect("start durable job", () =>
      this.#transaction(() => {
        const now = timestamp(input.now, "now");
        const job = this.#activeLease(input, now, ["leased"]);
        this.#database
          .prepare("UPDATE automation_jobs SET status = 'running', updated_at = ? WHERE id = ?")
          .run(now, job.id);
        this.#database
          .prepare(
            "UPDATE automation_job_attempts SET status = 'running', started_at = ? WHERE job_id = ? AND lease_token = ?",
          )
          .run(now, job.id, input.leaseToken);
        return toJob(this.#requireJob(job.id));
      }),
    );
  }

  /**
   * Must be called immediately before the provider-side request that can create
   * work. Lease recovery converts jobs in this state to `uncertain`, never back
   * to pending, because a process crash can make provider acceptance unknowable.
   */
  markExternalDispatch(
    input: MarkExternalDispatchInput,
  ): Effect.Effect<DurableJob, ReturnType<typeof asAutomationError>> {
    return this.#effect("mark external dispatch", () =>
      this.#transaction(() => {
        const now = timestamp(input.now, "now");
        const job = this.#activeLease(input, now, ["leased", "running"]);
        const provider = input.provider ? assertName(input.provider, "provider") : job.provider;
        this.#database
          .prepare(
            `UPDATE automation_jobs
             SET status = 'running', external_dispatch_started_at = ?, provider = ?, updated_at = ?
             WHERE id = ? AND lease_token = ?`,
          )
          .run(now, provider, now, job.id, input.leaseToken);
        this.#database
          .prepare(
            `UPDATE automation_job_attempts
             SET status = 'running', started_at = COALESCE(started_at, ?), external_dispatch_started_at = ?, provider = ?
             WHERE job_id = ? AND lease_token = ?`,
          )
          .run(now, now, provider, job.id, input.leaseToken);
        return toJob(this.#requireJob(job.id));
      }),
    );
  }

  markProviderAccepted(
    input: MarkProviderAcceptedInput,
  ): Effect.Effect<DurableJob, ReturnType<typeof asAutomationError>> {
    return this.#effect("mark provider acceptance", () =>
      this.#transaction(() => {
        const now = timestamp(input.now, "now");
        const job = this.#activeLease(input, now, ["leased", "running"]);
        const provider = input.provider ? assertName(input.provider, "provider") : job.provider;
        const reference = input.providerReference
          ? assertText(input.providerReference, "providerReference", 512)
          : null;
        this.#database
          .prepare(
            `UPDATE automation_jobs
             SET status = 'running',
                 external_dispatch_started_at = COALESCE(external_dispatch_started_at, ?),
                 provider = ?, provider_accepted_at = ?, provider_reference = ?, updated_at = ?
             WHERE id = ? AND lease_token = ?`,
          )
          .run(now, provider, now, reference, now, job.id, input.leaseToken);
        this.#database
          .prepare(
            `UPDATE automation_job_attempts
             SET status = 'running', started_at = COALESCE(started_at, ?),
                 external_dispatch_started_at = COALESCE(external_dispatch_started_at, ?),
                 provider = ?, provider_accepted_at = ?, provider_reference = ?
             WHERE job_id = ? AND lease_token = ?`,
          )
          .run(now, now, provider, now, reference, job.id, input.leaseToken);
        return toJob(this.#requireJob(job.id));
      }),
    );
  }

  succeedJob(
    input: JobCompletionInput,
  ): Effect.Effect<DurableJob, ReturnType<typeof asAutomationError>> {
    return this.#effect("succeed durable job", () =>
      this.#transaction(() => {
        const now = timestamp(input.now, "now");
        const job = this.#activeLease(input, now, ["leased", "running"]);
        const resultJson =
          input.result === undefined ? null : encodeJson(input.result, "job result");
        this.#finishJob(job, input.leaseToken, "succeeded", now, resultJson, null);
        return toJob(this.#requireJob(job.id));
      }),
    );
  }

  failJob(input: JobFailureInput): Effect.Effect<DurableJob, ReturnType<typeof asAutomationError>> {
    return this.#effect("fail durable job", () =>
      this.#transaction(() => {
        const now = timestamp(input.now, "now");
        const job = this.#activeLease(input, now, ["leased", "running"]);
        this.#finishJob(
          job,
          input.leaseToken,
          "failed",
          now,
          null,
          encodeJson(input.error, "job error"),
        );
        return toJob(this.#requireJob(job.id));
      }),
    );
  }

  markJobUncertain(
    input: MarkJobUncertainInput,
  ): Effect.Effect<DurableJob, ReturnType<typeof asAutomationError>> {
    return this.#effect("mark durable job uncertain", () =>
      this.#transaction(() => {
        const now = timestamp(input.now, "now");
        const job = this.#activeLease(input, now, ["leased", "running"]);
        const reason =
          input.reason === undefined ? null : encodeJson(input.reason, "uncertain reason");
        this.#finishJob(job, input.leaseToken, "uncertain", now, null, reason);
        return toJob(this.#requireJob(job.id));
      }),
    );
  }

  cancelJob(
    input: CancelJobInput,
  ): Effect.Effect<DurableJob, ReturnType<typeof asAutomationError>> {
    return this.#effect("cancel durable job", () =>
      this.#transaction(() => {
        const now = timestamp(input.now, "now");
        const job = this.#requireJob(assertText(input.jobId, "jobId", 256));
        if (job.status === "canceled") {
          return toJob(job);
        }
        if (job.status === "succeeded" || job.status === "failed" || job.status === "uncertain") {
          throw new AutomationConflictError(`Job is already terminal: ${job.id}`);
        }
        const reason =
          input.reason === undefined ? null : encodeJson(input.reason, "cancel reason");
        if (job.status === "pending") {
          this.#database
            .prepare(
              `UPDATE automation_jobs
               SET status = 'canceled', error_json = ?, updated_at = ?, completed_at = ?
               WHERE id = ?`,
            )
            .run(reason, now, now, job.id);
        } else {
          if (!input.leaseToken) {
            throw new AutomationLeaseError("leaseToken is required to cancel an active job");
          }
          this.#activeLease({ jobId: job.id, leaseToken: input.leaseToken }, now, [
            "leased",
            "running",
          ]);
          this.#finishJob(job, input.leaseToken, "canceled", now, null, reason);
        }
        return toJob(this.#requireJob(job.id));
      }),
    );
  }

  /** Explicit operator action only; recovery never retries a dispatched job. */
  retryJob(input: RetryJobInput): Effect.Effect<DurableJob, ReturnType<typeof asAutomationError>> {
    return this.#effect("retry durable job", () =>
      this.#transaction(() => {
        const now = timestamp(input.now, "now");
        const job = this.#requireJob(assertText(input.jobId, "jobId", 256));
        if (job.status !== "failed" && job.status !== "canceled" && job.status !== "uncertain") {
          throw new AutomationConflictError(`Only terminal jobs can be retried: ${job.id}`);
        }
        const notBefore = timestamp(input.notBefore ?? now, "notBefore");
        this.#database
          .prepare(
            `UPDATE automation_jobs
             SET status = 'pending', not_before = ?, lease_token = NULL, lease_expires_at = NULL,
                 external_dispatch_started_at = NULL, provider = NULL, provider_accepted_at = NULL,
                 provider_reference = NULL, result_json = NULL, error_json = NULL,
                 updated_at = ?, completed_at = NULL
             WHERE id = ?`,
          )
          .run(notBefore, now, job.id);
        return toJob(this.#requireJob(job.id));
      }),
    );
  }

  /**
   * Settles an uncertain provider attempt from operator evidence without
   * dispatching it again. The same terminal outcome is applied to the job and
   * to the uncertain attempt so the attempt history remains internally
   * consistent.
   */
  reconcileUncertainJob(
    input: ReconcileUncertainJobInput,
  ): Effect.Effect<DurableJob, ReturnType<typeof asAutomationError>> {
    return this.#effect("reconcile uncertain durable job", () =>
      this.#transaction(() => {
        const now = timestamp(input.now, "now");
        const job = this.#requireJob(assertText(input.jobId, "jobId", 256));
        const status = assertUncertainJobResolution(input.status);
        if (job.status !== "uncertain") {
          throw new AutomationConflictError(`Only uncertain jobs can be reconciled: ${job.id}`);
        }
        const attempt = this.#database
          .prepare(
            `SELECT * FROM automation_job_attempts
             WHERE job_id = ? AND status = 'uncertain'
             ORDER BY attempt_number DESC LIMIT 1`,
          )
          .get(job.id) as DbAttemptRow | undefined;
        if (!attempt || attempt.attempt_number !== job.attempt_count) {
          throw new AutomationConflictError(
            `Uncertain attempt history is missing or inconsistent for job: ${job.id}`,
          );
        }
        const resultJson =
          status === "succeeded" && "result" in input && input.result !== undefined
            ? encodeJson(input.result, "reconciled job result")
            : null;
        const errorJson =
          status !== "succeeded" && "error" in input && input.error !== undefined
            ? encodeJson(input.error, "reconciled job error")
            : null;
        const jobUpdate = this.#database
          .prepare(
            `UPDATE automation_jobs
             SET status = ?, result_json = ?, error_json = ?, updated_at = ?, completed_at = ?
             WHERE id = ? AND status = 'uncertain'`,
          )
          .run(status, resultJson, errorJson, now, now, job.id);
        const attemptUpdate = this.#database
          .prepare(
            `UPDATE automation_job_attempts
             SET status = ?, finished_at = ?, error_json = ?
             WHERE id = ? AND status = 'uncertain'`,
          )
          .run(status, now, errorJson, attempt.id);
        if (Number(jobUpdate.changes) !== 1 || Number(attemptUpdate.changes) !== 1) {
          throw new AutomationConflictError(
            `Uncertain job changed during reconciliation: ${job.id}`,
          );
        }
        return toJob(this.#requireJob(job.id));
      }),
    );
  }

  recoverExpiredLeases(
    now?: AutomationTimestamp,
  ): Effect.Effect<LeaseRecovery, ReturnType<typeof asAutomationError>> {
    return this.#effect("recover expired leases", () =>
      this.#transaction(() => this.#recoverExpiredLeases(timestamp(now, "now"))),
    );
  }

  getJob(
    jobId: string,
  ): Effect.Effect<DurableJob | undefined, ReturnType<typeof asAutomationError>> {
    return this.#effect("read durable job", () => {
      const row = this.#jobById(assertText(jobId, "jobId", 256));
      return row ? toJob(row) : undefined;
    });
  }

  getJobDetail(
    jobId: string,
  ): Effect.Effect<DurableJobDetail | undefined, ReturnType<typeof asAutomationError>> {
    return this.#effect("read durable job detail", () => {
      const row = this.#jobById(assertText(jobId, "jobId", 256));
      return row ? toJobDetail(row) : undefined;
    });
  }

  listJobs(
    options: ListJobsOptions = {},
  ): Effect.Effect<DurableJob[], ReturnType<typeof asAutomationError>> {
    return this.#effect("list durable jobs", () => {
      const clauses: string[] = [];
      const params: Array<string | number | null> = [];
      if (options.queueName) {
        clauses.push("queue_name = ?");
        params.push(assertName(options.queueName, "queue name"));
      }
      if (options.statuses && options.statuses.length > 0) {
        for (const status of options.statuses) {
          assertJobStatus(status);
        }
        clauses.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
        params.push(...options.statuses);
      }
      const limit = listLimit(options.limit);
      params.push(limit);
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.#database
        .prepare(`SELECT * FROM automation_jobs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...params) as DbJobRow[];
      return rows.map(toJob);
    });
  }

  /** Returns every queue with pending work; this query is intentionally uncapped. */
  listPendingQueueNames(): Effect.Effect<string[], ReturnType<typeof asAutomationError>> {
    return this.#effect("list pending queue names", () => {
      const rows = this.#database
        .prepare(
          `SELECT DISTINCT queue_name
           FROM automation_jobs
           WHERE status = 'pending'
           ORDER BY queue_name ASC`,
        )
        .all() as Array<{ queue_name: string }>;
      return rows.map((row) => row.queue_name);
    });
  }

  /** Counts jobs in SQL so status summaries are not truncated by list limits. */
  countJobsByStatus(
    options: CountJobsByStatusOptions = {},
  ): Effect.Effect<DurableJobStatusCounts, ReturnType<typeof asAutomationError>> {
    return this.#effect("count durable jobs by status", () => {
      const queueName = options.queueName ? assertName(options.queueName, "queue name") : undefined;
      const rows = this.#database
        .prepare(
          `SELECT status, COUNT(*) AS count
           FROM automation_jobs
           ${queueName ? "WHERE queue_name = ?" : ""}
           GROUP BY status`,
        )
        .all(...(queueName ? [queueName] : [])) as Array<{
        status: string;
        count: number;
      }>;
      const counts: DurableJobStatusCounts = {
        pending: 0,
        leased: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        canceled: 0,
        uncertain: 0,
      };
      for (const row of rows) {
        assertJobStatus(row.status);
        if (!Number.isSafeInteger(row.count) || row.count < 0) {
          throw new AutomationConflictError("SQLite status count query returned an invalid row");
        }
        counts[row.status] = row.count;
      }
      return counts;
    });
  }

  getJobAttempts(
    jobId: string,
  ): Effect.Effect<DurableJobAttempt[], ReturnType<typeof asAutomationError>> {
    return this.#effect("list durable job attempts", () => {
      const rows = this.#database
        .prepare(
          "SELECT * FROM automation_job_attempts WHERE job_id = ? ORDER BY attempt_number ASC",
        )
        .all(assertText(jobId, "jobId", 256)) as DbAttemptRow[];
      return rows.map(toAttempt);
    });
  }

  ingestWorkflowEvent(
    input: WorkflowEventInput,
  ): Effect.Effect<IngestWorkflowEventResult, ReturnType<typeof asAutomationError>> {
    return this.#effect("ingest workflow event", () =>
      this.#transaction(() => this.#ingestWorkflowEvent(input)),
    );
  }

  /** Atomically persists an event and every workflow route selected for it. */
  ingestWorkflowEventAndEnqueueRoutes(
    input: WorkflowEventInput,
    targetWorkflowId?: string,
  ): Effect.Effect<IngestAndRouteWorkflowEventResult, ReturnType<typeof asAutomationError>> {
    return this.#effect("ingest and route workflow event", () =>
      this.#transaction(() => {
        const ingested = this.#ingestWorkflowEvent(input);
        const event = this.#requireWorkflowEventDetail(ingested.event.id);
        const jobIds = this.#enqueueWorkflowEventRoutes(event, targetWorkflowId);
        return { inserted: ingested.inserted, event, jobIds };
      }),
    );
  }

  /** Replays routing for an already-persisted event using deterministic job identities. */
  enqueueWorkflowEventRoutes(
    event: WorkflowEventDetail,
    targetWorkflowId?: string,
  ): Effect.Effect<string[], ReturnType<typeof asAutomationError>> {
    return this.#effect("route persisted workflow event", () =>
      this.#transaction(() => this.#enqueueWorkflowEventRoutes(event, targetWorkflowId)),
    );
  }

  getWorkflowEvent(
    eventId: string,
  ): Effect.Effect<WorkflowEventDetail | undefined, ReturnType<typeof asAutomationError>> {
    return this.#effect("read workflow event", () => {
      const row = this.#database
        .prepare("SELECT * FROM automation_workflow_events WHERE id = ?")
        .get(assertText(eventId, "eventId", 256)) as DbWorkflowEventRow | undefined;
      return row ? toWorkflowEventDetail(row) : undefined;
    });
  }

  listWorkflowEvents(
    options: ListWorkflowEventsOptions = {},
  ): Effect.Effect<WorkflowEvent[], ReturnType<typeof asAutomationError>> {
    return this.#effect("list workflow events", () => {
      const clauses: string[] = [];
      const params: Array<string | number | null> = [];
      if (options.source) {
        clauses.push("source = ?");
        params.push(assertName(options.source, "event source"));
      }
      if (options.type) {
        clauses.push("event_type = ?");
        params.push(assertName(options.type, "event type"));
      }
      if (options.verified !== undefined) {
        clauses.push("verified = ?");
        params.push(options.verified ? 1 : 0);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.#database
        .prepare(
          `SELECT * FROM automation_workflow_events ${where}
           ORDER BY received_at DESC, id DESC LIMIT ?`,
        )
        .all(...params, listLimit(options.limit)) as DbWorkflowEventRow[];
      return rows.map(toWorkflowEvent);
    });
  }

  ingestAgentHookEvent(
    input: AgentHookEventInput,
  ): Effect.Effect<IngestAgentEventResult, ReturnType<typeof asAutomationError>> {
    return this.#effect("ingest agent hook event", () =>
      this.#transaction(() => this.#ingestAgentHookEvent(input)),
    );
  }

  getAgentEvent(
    eventId: string,
  ): Effect.Effect<AgentEventDetail | undefined, ReturnType<typeof asAutomationError>> {
    return this.#effect("read agent hook event", () => {
      const row = this.#database
        .prepare("SELECT * FROM automation_agent_events WHERE id = ?")
        .get(assertText(eventId, "eventId", 256)) as DbAgentEventRow | undefined;
      return row ? toAgentEventDetail(row) : undefined;
    });
  }

  listAgentEvents(
    options: ListAgentEventsOptions = {},
  ): Effect.Effect<AgentEvent[], ReturnType<typeof asAutomationError>> {
    return this.#effect("list agent hook events", () => {
      const clauses: string[] = [];
      const params: Array<string | number | null> = [];
      if (options.provider) {
        clauses.push("provider = ?");
        params.push(assertName(options.provider, "provider"));
      }
      if (options.sessionId) {
        clauses.push("session_id = ?");
        params.push(assertText(options.sessionId, "sessionId", 512));
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.#database
        .prepare(
          `SELECT * FROM automation_agent_events ${where}
           ORDER BY received_at DESC, id DESC LIMIT ?`,
        )
        .all(...params, listLimit(options.limit)) as DbAgentEventRow[];
      return rows.map(toAgentEvent);
    });
  }

  getExternalAgentSession(
    provider: string,
    sessionId: string,
  ): Effect.Effect<ExternalAgentSessionLease | undefined, ReturnType<typeof asAutomationError>> {
    return this.#effect("read external agent session", () => {
      const row = this.#database
        .prepare("SELECT * FROM automation_external_sessions WHERE provider = ? AND session_id = ?")
        .get(assertName(provider, "provider"), assertText(sessionId, "sessionId", 512)) as
        | DbExternalSessionRow
        | undefined;
      return row ? toExternalSession(row) : undefined;
    });
  }

  listExternalAgentSessions(
    options: ListExternalAgentSessionsOptions = {},
  ): Effect.Effect<ExternalAgentSessionLease[], ReturnType<typeof asAutomationError>> {
    return this.#effect("list external agent sessions", () => {
      const clauses: string[] = [];
      const params: Array<string | number | null> = [];
      if (options.states && options.states.length > 0) {
        for (const state of options.states) {
          if (state !== "active" && state !== "released" && state !== "expired") {
            throw new AutomationValidationError(`Unknown external session state: ${String(state)}`);
          }
        }
        clauses.push(`state IN (${options.states.map(() => "?").join(", ")})`);
        params.push(...options.states);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.#database
        .prepare(
          `SELECT * FROM automation_external_sessions ${where}
           ORDER BY updated_at DESC, provider ASC, session_id ASC LIMIT ?`,
        )
        .all(...params, listLimit(options.limit)) as DbExternalSessionRow[];
      return rows.map(toExternalSession);
    });
  }

  /** Counts sessions in SQL so status is never truncated by list limits. */
  countExternalAgentSessions(
    options: CountExternalAgentSessionsOptions = {},
  ): Effect.Effect<number, ReturnType<typeof asAutomationError>> {
    return this.#effect("count external agent sessions", () => {
      const states = normalizeExternalSessionStates(options.states);
      const where = states.length > 0 ? `WHERE state IN (${states.map(() => "?").join(", ")})` : "";
      const row = this.#database
        .prepare(`SELECT COUNT(*) AS count FROM automation_external_sessions ${where}`)
        .get(...states);
      const result = count(row);
      if (!Number.isSafeInteger(result) || result < 0) {
        throw new AutomationConflictError("SQLite session count query returned an invalid row");
      }
      return result;
    });
  }

  /**
   * Bounds persisted hook observations. Routed workflow events referenced by
   * active durable workflow jobs are retained even when they exceed a bound.
   */
  prunePersistedHookEvents(
    options: PrunePersistedHookEventsOptions = {},
  ): Effect.Effect<PrunePersistedHookEventsResult, ReturnType<typeof asAutomationError>> {
    return this.#effect("prune persisted hook events", () =>
      this.#transaction(() => {
        const maxEntries = assertNonNegativeInteger(
          options.maxEntries ?? DEFAULT_HOOK_EVENT_MAX_ENTRIES,
          "maxEntries",
        );
        const maxAgeMs = assertNonNegativeInteger(
          options.maxAgeMs ?? DEFAULT_HOOK_EVENT_MAX_AGE_MS,
          "maxAgeMs",
        );
        const now = timestamp(options.now, "now");
        const cutoff = now - maxAgeMs;
        let removedAgentEvents = Number(
          this.#database
            .prepare("DELETE FROM automation_agent_events WHERE received_at < ?")
            .run(cutoff).changes,
        );
        let removedWorkflowEvents = Number(
          this.#database
            .prepare(
              `DELETE FROM automation_workflow_events AS event
               WHERE event.source LIKE 'agent:%'
                 AND event.received_at < ?
                 AND NOT EXISTS (
                   SELECT 1 FROM automation_jobs AS job
                   WHERE job.status IN ('pending', 'leased', 'running', 'uncertain')
                     AND json_extract(job.payload_json, '$.kind') = 'meka.workflow'
                     AND json_extract(job.payload_json, '$.payload.eventId') = event.id
                 )`,
            )
            .run(cutoff).changes,
        );
        removedAgentEvents += Number(
          this.#database
            .prepare(
              `DELETE FROM automation_agent_events
               WHERE id IN (
                 SELECT id FROM automation_agent_events
                 ORDER BY received_at DESC, id DESC LIMIT -1 OFFSET ?
               )`,
            )
            .run(maxEntries).changes,
        );
        removedWorkflowEvents += Number(
          this.#database
            .prepare(
              `DELETE FROM automation_workflow_events AS event
               WHERE event.id IN (
                 SELECT ranked.id FROM (
                   SELECT id, ROW_NUMBER() OVER (ORDER BY received_at DESC, id DESC) AS position
                   FROM automation_workflow_events
                   WHERE source LIKE 'agent:%'
                 ) AS ranked
                 WHERE ranked.position > ?
               )
                 AND NOT EXISTS (
                   SELECT 1 FROM automation_jobs AS job
                   WHERE job.status IN ('pending', 'leased', 'running', 'uncertain')
                     AND json_extract(job.payload_json, '$.kind') = 'meka.workflow'
                     AND json_extract(job.payload_json, '$.payload.eventId') = event.id
                 )`,
            )
            .run(maxEntries).changes,
        );
        const remainingAgentEvents = count(
          this.#database.prepare("SELECT COUNT(*) AS count FROM automation_agent_events").get(),
        );
        const remainingWorkflowEvents = count(
          this.#database
            .prepare(
              "SELECT COUNT(*) AS count FROM automation_workflow_events WHERE source LIKE 'agent:%'",
            )
            .get(),
        );
        return {
          removedAgentEvents,
          removedWorkflowEvents,
          remainingAgentEvents,
          remainingWorkflowEvents,
        };
      }),
    );
  }

  recoverExpiredExternalAgentSessions(
    now?: AutomationTimestamp,
  ): Effect.Effect<ExternalAgentSessionLease[], ReturnType<typeof asAutomationError>> {
    return this.#effect("recover expired external agent sessions", () =>
      this.#transaction(() => {
        const at = timestamp(now, "now");
        const rows = this.#database
          .prepare(
            `SELECT * FROM automation_external_sessions
             WHERE state = 'active' AND leased_until IS NOT NULL AND leased_until <= ?`,
          )
          .all(at) as DbExternalSessionRow[];
        if (rows.length === 0) {
          return [];
        }
        this.#database
          .prepare(
            `UPDATE automation_external_sessions
             SET state = 'expired', leased_until = NULL, updated_at = ?
             WHERE state = 'active' AND leased_until IS NOT NULL AND leased_until <= ?`,
          )
          .run(at, at);
        return rows.map((row) =>
          toExternalSession({ ...row, state: "expired", leased_until: null, updated_at: at }),
        );
      }),
    );
  }

  writeSpoolEntry(
    input: SpoolEntryInput,
  ): Effect.Effect<SpoolEntry, ReturnType<typeof asAutomationError>> {
    return this.#effect("write atomic spool entry", () =>
      writeAtomicSpoolEntry(this.location.spoolPath, input),
    );
  }

  readSpoolEntry(
    id: string,
  ): Effect.Effect<SpoolEntryDetail | undefined, ReturnType<typeof asAutomationError>> {
    return this.#effect("read spool entry", () => readSpoolEntry(this.location.spoolPath, id));
  }

  listSpoolEntries(
    limit?: number,
  ): Effect.Effect<SpoolEntry[], ReturnType<typeof asAutomationError>> {
    return this.#effect("list spool entries", () =>
      listSpoolEntries(this.location.spoolPath, limit),
    );
  }

  acknowledgeSpoolEntry(id: string): Effect.Effect<boolean, ReturnType<typeof asAutomationError>> {
    return this.#effect("acknowledge spool entry", () =>
      acknowledgeSpoolEntry(this.location.spoolPath, id),
    );
  }

  createWorkflowRegistration(
    input: WorkflowRegistrationInput,
  ): Effect.Effect<WorkflowRegistration, ReturnType<typeof asAutomationError>> {
    return this.#effect("create workflow registration", () =>
      this.#transaction(() => {
        const row = normalizeWorkflowRegistration(input);
        const now = timestamp(input.now, "now");
        this.#queuePolicy(row.queueName, true);
        const existing = this.#database
          .prepare("SELECT id FROM automation_workflows WHERE id = ?")
          .get(row.id) as { id: string } | undefined;
        if (existing) {
          throw new AutomationConflictError(`Workflow registration already exists: ${row.id}`);
        }
        this.#database
          .prepare(
            `INSERT INTO automation_workflows(
               id, module_realpath, revision_hash, trigger_types_json, enabled, queue_name, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.id,
            row.moduleRealpath,
            row.revisionHash,
            encodeJson(row.triggerTypes, "workflow trigger types"),
            row.enabled ? 1 : 0,
            row.queueName,
            now,
            now,
          );
        return toWorkflowRegistration(this.#requireWorkflow(row.id));
      }),
    );
  }

  getWorkflowRegistration(
    id: string,
  ): Effect.Effect<WorkflowRegistration | undefined, ReturnType<typeof asAutomationError>> {
    return this.#effect("read workflow registration", () => {
      const row = this.#workflowById(assertName(id, "workflow id"));
      return row ? toWorkflowRegistration(row) : undefined;
    });
  }

  listWorkflowRegistrations(
    options: ListWorkflowRegistrationsOptions = {},
  ): Effect.Effect<WorkflowRegistration[], ReturnType<typeof asAutomationError>> {
    return this.#effect("list workflow registrations", () => {
      const clauses: string[] = [];
      const params: Array<string | number | null> = [];
      if (options.enabled !== undefined) {
        clauses.push("enabled = ?");
        params.push(options.enabled ? 1 : 0);
      }
      if (options.triggerType) {
        // JSON membership is checked after the indexed enabled filter; this is
        // deliberately portable across the Node SQLite builds Meka supports.
        clauses.push("trigger_types_json LIKE ?");
        params.push(
          `%${JSON.stringify(assertName(options.triggerType, "trigger type")).slice(1, -1)}%`,
        );
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.#database
        .prepare(`SELECT * FROM automation_workflows ${where} ORDER BY id ASC LIMIT ?`)
        .all(...params, listLimit(options.limit)) as DbWorkflowRow[];
      return rows
        .map(toWorkflowRegistration)
        .filter(
          (workflow) => !options.triggerType || workflow.triggerTypes.includes(options.triggerType),
        );
    });
  }

  /** Returns every enabled workflow that exactly matches an event type for routing. */
  listEnabledWorkflowRegistrationsForTrigger(
    triggerType: string,
  ): Effect.Effect<WorkflowRegistration[], ReturnType<typeof asAutomationError>> {
    return this.#effect("list routable workflow registrations", () =>
      this.#listEnabledWorkflowRegistrationsForTrigger(triggerType),
    );
  }

  updateWorkflowRegistration(
    input: UpdateWorkflowRegistrationInput,
  ): Effect.Effect<WorkflowRegistration, ReturnType<typeof asAutomationError>> {
    return this.#effect("update workflow registration", () =>
      this.#transaction(() => {
        const id = assertName(input.id, "workflow id");
        const current = this.#requireWorkflow(id);
        const now = timestamp(input.now, "now");
        const moduleRealpath = input.modulePath
          ? resolveModuleRealpath(input.modulePath)
          : current.module_realpath;
        const revisionHash = input.revisionHash
          ? assertText(input.revisionHash, "revisionHash", 512)
          : current.revision_hash;
        const triggerTypes = input.triggerTypes
          ? normalizeTriggerTypes(input.triggerTypes)
          : parseTriggerTypes(current.trigger_types_json);
        const queueName = input.queueName
          ? assertName(input.queueName, "queue name")
          : current.queue_name;
        this.#queuePolicy(queueName, true);
        const enabled = input.enabled ?? current.enabled === 1;
        this.#database
          .prepare(
            `UPDATE automation_workflows
             SET module_realpath = ?, revision_hash = ?, trigger_types_json = ?, enabled = ?, queue_name = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            moduleRealpath,
            revisionHash,
            encodeJson(triggerTypes, "workflow trigger types"),
            enabled ? 1 : 0,
            queueName,
            now,
            id,
          );
        return toWorkflowRegistration(this.#requireWorkflow(id));
      }),
    );
  }

  deleteWorkflowRegistration(
    id: string,
  ): Effect.Effect<boolean, ReturnType<typeof asAutomationError>> {
    return this.#effect("delete workflow registration", () =>
      this.#transaction(() => {
        const result = this.#database
          .prepare("DELETE FROM automation_workflows WHERE id = ?")
          .run(assertName(id, "workflow id"));
        return Number(result.changes) > 0;
      }),
    );
  }

  createSourceRegistration(
    input: SourceRegistrationInput,
  ): Effect.Effect<SourceRegistration, ReturnType<typeof asAutomationError>> {
    return this.#effect("create source registration", () =>
      this.#transaction(() => {
        const row = normalizeSourceRegistration(input);
        const now = timestamp(input.now, "now");
        this.#requireWorkflow(row.workflowId);
        const existing = this.#database
          .prepare("SELECT id FROM automation_sources WHERE id = ?")
          .get(row.id) as { id: string } | undefined;
        if (existing) {
          throw new AutomationConflictError(`Source registration already exists: ${row.id}`);
        }
        this.#database
          .prepare(
            `INSERT INTO automation_sources(
               id, kind, enabled, workflow_id, config_json, cursor_json, dedupe_state_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.id,
            row.kind,
            row.enabled ? 1 : 0,
            row.workflowId,
            encodeJson(row.config, "source config"),
            row.cursor === undefined ? null : encodeJson(row.cursor, "source cursor"),
            row.dedupeState === undefined
              ? null
              : encodeJson(row.dedupeState, "source dedupe state"),
            now,
            now,
          );
        return toSourceRegistration(this.#requireSource(row.id));
      }),
    );
  }

  getSourceRegistration(
    id: string,
  ): Effect.Effect<SourceRegistration | undefined, ReturnType<typeof asAutomationError>> {
    return this.#effect("read source registration", () => {
      const row = this.#sourceById(assertName(id, "source id"));
      return row ? toSourceRegistration(row) : undefined;
    });
  }

  listSourceRegistrations(
    options: ListSourceRegistrationsOptions = {},
  ): Effect.Effect<SourceRegistration[], ReturnType<typeof asAutomationError>> {
    return this.#effect("list source registrations", () => {
      const clauses: string[] = [];
      const params: Array<string | number | null> = [];
      if (options.enabled !== undefined) {
        clauses.push("enabled = ?");
        params.push(options.enabled ? 1 : 0);
      }
      if (options.kind) {
        clauses.push("kind = ?");
        params.push(assertName(options.kind, "source kind"));
      }
      if (options.workflowId) {
        clauses.push("workflow_id = ?");
        params.push(assertName(options.workflowId, "workflow id"));
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.#database
        .prepare(`SELECT * FROM automation_sources ${where} ORDER BY id ASC LIMIT ?`)
        .all(...params, listLimit(options.limit)) as DbSourceRow[];
      return rows.map(toSourceRegistration);
    });
  }

  updateSourceRegistration(
    input: UpdateSourceRegistrationInput,
  ): Effect.Effect<SourceRegistration, ReturnType<typeof asAutomationError>> {
    return this.#effect("update source registration", () =>
      this.#transaction(() => {
        const id = assertName(input.id, "source id");
        const current = this.#requireSource(id);
        const now = timestamp(input.now, "now");
        const kind = input.kind ? assertName(input.kind, "source kind") : current.kind;
        const workflowId = input.workflowId
          ? assertName(input.workflowId, "workflow id")
          : current.workflow_id;
        this.#requireWorkflow(workflowId);
        const config =
          input.config === undefined
            ? current.config_json
            : encodeJson(input.config, "source config");
        const cursor =
          input.cursor === undefined
            ? current.cursor_json
            : encodeJson(input.cursor, "source cursor");
        const dedupe =
          input.dedupeState === undefined
            ? current.dedupe_state_json
            : encodeJson(input.dedupeState, "source dedupe state");
        const enabled = input.enabled ?? current.enabled === 1;
        this.#database
          .prepare(
            `UPDATE automation_sources
             SET kind = ?, enabled = ?, workflow_id = ?, config_json = ?, cursor_json = ?, dedupe_state_json = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(kind, enabled ? 1 : 0, workflowId, config, cursor, dedupe, now, id);
        return toSourceRegistration(this.#requireSource(id));
      }),
    );
  }

  deleteSourceRegistration(
    id: string,
  ): Effect.Effect<boolean, ReturnType<typeof asAutomationError>> {
    return this.#effect("delete source registration", () =>
      this.#transaction(() => {
        const result = this.#database
          .prepare("DELETE FROM automation_sources WHERE id = ?")
          .run(assertName(id, "source id"));
        return Number(result.changes) > 0;
      }),
    );
  }

  #effect<T>(
    operation: string,
    action: () => T,
  ): Effect.Effect<T, ReturnType<typeof asAutomationError>> {
    return Effect.try({
      try: () => {
        this.#assertOpen();
        return action();
      },
      catch: (cause) => asAutomationError(operation, cause),
    });
  }

  #transaction<T>(action: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #enqueueJob(input: DurableJobInput): EnqueueJobResult {
    const now = timestamp(input.now, "now");
    const id = input.id ? assertName(input.id, "job id") : `job-${randomUUID()}`;
    const queueName = assertName(input.queueName, "queue name");
    this.#queuePolicy(queueName, true);
    const priority = input.priority ?? 0;
    if (!Number.isSafeInteger(priority)) {
      throw new AutomationValidationError("priority must be a safe integer");
    }
    const notBefore = timestamp(input.notBefore ?? now, "notBefore");
    const payloadJson = encodeJson(input.payload, "job payload");
    const idempotencyKey = input.idempotencyKey
      ? assertText(input.idempotencyKey, "idempotencyKey", 512)
      : null;
    const idempotencyHash = idempotencyKey
      ? hash(
          encodeJson(
            {
              payload: JSON.parse(payloadJson),
              priority,
              // An omitted schedule means "eligible when first inserted". Its
              // generated timestamp must not make an otherwise identical
              // idempotent replay look like different content.
              notBefore: input.notBefore === undefined ? null : notBefore,
            },
            "idempotency fingerprint",
          ),
        )
      : null;

    if (idempotencyKey) {
      const existing = this.#database
        .prepare("SELECT * FROM automation_jobs WHERE queue_name = ? AND idempotency_key = ?")
        .get(queueName, idempotencyKey) as DbJobRow | undefined;
      if (existing) {
        if (existing.idempotency_hash !== idempotencyHash) {
          throw new AutomationConflictError(
            `Idempotency key was already used with different job content: ${queueName}/${idempotencyKey}`,
          );
        }
        return { created: false, job: toJob(existing) };
      }
    }
    const sameId = this.#jobById(id);
    if (sameId) {
      if (
        idempotencyKey !== null &&
        sameId.idempotency_key === idempotencyKey &&
        sameId.idempotency_hash === idempotencyHash
      ) {
        return { created: false, job: toJob(sameId) };
      }
      throw new AutomationConflictError(`Durable job already exists: ${id}`);
    }
    this.#database
      .prepare(
        `INSERT INTO automation_jobs(
           id, queue_name, status, idempotency_key, idempotency_hash, payload_json, priority, not_before,
           attempt_count, created_at, updated_at
         ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        queueName,
        idempotencyKey,
        idempotencyHash,
        payloadJson,
        priority,
        notBefore,
        now,
        now,
      );
    return { created: true, job: toJob(this.#requireJob(id)) };
  }

  #enqueueWorkflowEventRoutes(event: WorkflowEventDetail, targetWorkflowId?: string): string[] {
    const workflows = targetWorkflowId
      ? [this.#workflowById(assertName(targetWorkflowId, "workflow id"))]
          .filter((row): row is DbWorkflowRow => Boolean(row))
          .map(toWorkflowRegistration)
      : this.#listEnabledWorkflowRegistrationsForTrigger(event.type);
    const jobIds: string[] = [];
    for (const workflow of workflows) {
      if (!workflow.enabled) continue;
      if (!targetWorkflowId && !workflow.triggerTypes.includes(event.type)) continue;
      const routingIdentity = `workflow:${workflow.id}:${workflow.revisionHash}:${event.id}`;
      const result = this.#enqueueJob({
        // The stable id keeps a route globally unique even if an unchanged
        // workflow registration moves to a different queue before replay.
        id: `job-workflow-${hash(routingIdentity)}`,
        queueName: workflow.queueName,
        idempotencyKey: routingIdentity,
        payload: {
          version: 1,
          kind: "meka.workflow",
          payload: {
            workflowId: workflow.id,
            revisionHash: workflow.revisionHash,
            eventId: event.id,
          },
        },
      });
      jobIds.push(result.job.id);
    }
    return jobIds;
  }

  #listEnabledWorkflowRegistrationsForTrigger(triggerType: string): WorkflowRegistration[] {
    const normalizedTriggerType = assertName(triggerType, "trigger type");
    // Event fan-out must not inherit the bounded operator-list default. JSON
    // membership is still verified in application code for portability across
    // the Node SQLite builds Meka supports.
    const rows = this.#database
      .prepare(
        `SELECT * FROM automation_workflows
         WHERE enabled = 1 AND trigger_types_json LIKE ?
         ORDER BY id ASC`,
      )
      .all(`%${JSON.stringify(normalizedTriggerType).slice(1, -1)}%`) as DbWorkflowRow[];
    return rows
      .map(toWorkflowRegistration)
      .filter((workflow) => workflow.triggerTypes.includes(normalizedTriggerType));
  }

  #claimNextJob(input: ClaimNextJobInput): ClaimNextJobResult {
    const queueName = assertName(input.queueName, "queue name");
    const excludedKinds = [...new Set(input.excludePayloadKinds ?? [])].map((kind) =>
      assertName(kind, "excluded payload kind"),
    );
    if (excludedKinds.length > 32) {
      throw new AutomationValidationError("At most 32 payload kinds can be excluded from a claim");
    }
    const now = timestamp(input.now, "now");
    this.#recoverExpiredLeases(now);
    const policy = this.#queuePolicy(queueName, true);
    const active = count(
      this.#database
        .prepare(
          `SELECT COUNT(*) AS count FROM automation_jobs
           WHERE queue_name = ? AND status IN ('leased', 'running')
             AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
        )
        .get(queueName, now),
    );
    if (active >= policy.concurrency) {
      return { kind: "concurrency-exhausted", active, limit: policy.concurrency };
    }
    const starts = count(
      this.#database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM automation_job_attempts AS attempts
           JOIN automation_jobs AS jobs ON jobs.id = attempts.job_id
           WHERE jobs.queue_name = ? AND attempts.leased_at > ?`,
        )
        .get(queueName, now - policy.startWindowMs),
    );
    if (starts >= policy.maxStartsPerWindow) {
      return {
        kind: "start-budget-exhausted",
        starts,
        limit: policy.maxStartsPerWindow,
        windowMs: policy.startWindowMs,
      };
    }
    const kindFilter =
      excludedKinds.length === 0
        ? ""
        : `AND COALESCE(json_extract(payload_json, '$.kind'), '') NOT IN (${excludedKinds
            .map(() => "?")
            .join(", ")})`;
    const candidate = this.#database
      .prepare(
        `SELECT * FROM automation_jobs
         WHERE queue_name = ? AND status = 'pending' AND not_before <= ? ${kindFilter}
         ORDER BY priority DESC, created_at ASC, id ASC LIMIT 1`,
      )
      .get(queueName, now, ...excludedKinds) as DbJobRow | undefined;
    if (!candidate) {
      return { kind: "empty" };
    }
    const leaseToken = randomUUID();
    const leaseExpiresAt = now + policy.leaseMs;
    const attemptNumber = candidate.attempt_count + 1;
    this.#database
      .prepare(
        `UPDATE automation_jobs
         SET status = 'leased', attempt_count = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(attemptNumber, leaseToken, leaseExpiresAt, now, candidate.id);
    this.#database
      .prepare(
        `INSERT INTO automation_job_attempts(
           job_id, attempt_number, status, lease_token, leased_at, lease_expires_at
         ) VALUES (?, ?, 'leased', ?, ?, ?)`,
      )
      .run(candidate.id, attemptNumber, leaseToken, now, leaseExpiresAt);
    const job = this.#requireJob(candidate.id);
    const attempt = this.#database
      .prepare("SELECT * FROM automation_job_attempts WHERE job_id = ? AND lease_token = ?")
      .get(candidate.id, leaseToken) as DbAttemptRow | undefined;
    if (!attempt) {
      throw new AutomationConflictError(`Lease attempt was not written for job: ${candidate.id}`);
    }
    const claim: ClaimedJob = {
      job: toJob(job),
      payload: decodeJson(job.payload_json, "job payload"),
      leaseToken,
      leaseExpiresAt: iso(leaseExpiresAt),
      attempt: toAttempt(attempt),
    };
    return { kind: "claimed", claim };
  }

  #recoverExpiredLeases(now: number): LeaseRecovery {
    const expired = this.#database
      .prepare(
        `SELECT * FROM automation_jobs
         WHERE status IN ('leased', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      )
      .all(now) as DbJobRow[];
    const requeuedJobIds: string[] = [];
    const uncertainJobIds: string[] = [];
    for (const job of expired) {
      if (!job.lease_token) {
        continue;
      }
      const dispatched =
        job.external_dispatch_started_at !== null || job.provider_accepted_at !== null;
      if (dispatched) {
        const errorJson = encodeJson(
          {
            type: "meka.lease_expired_after_external_dispatch",
            message:
              "External provider acceptance may have occurred; operator resolution is required.",
          },
          "lease recovery error",
        );
        this.#database
          .prepare(
            `UPDATE automation_jobs
             SET status = 'uncertain', lease_token = NULL, lease_expires_at = NULL,
                 error_json = ?, updated_at = ?, completed_at = ?
             WHERE id = ? AND lease_token = ?`,
          )
          .run(errorJson, now, now, job.id, job.lease_token);
        this.#database
          .prepare(
            `UPDATE automation_job_attempts
             SET status = 'uncertain', finished_at = ?, error_json = ?
             WHERE job_id = ? AND lease_token = ? AND status IN ('leased', 'running')`,
          )
          .run(now, errorJson, job.id, job.lease_token);
        uncertainJobIds.push(job.id);
      } else {
        const errorJson = encodeJson(
          { type: "meka.lease_expired_before_external_dispatch" },
          "lease recovery error",
        );
        this.#database
          .prepare(
            `UPDATE automation_jobs
             SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE id = ? AND lease_token = ?`,
          )
          .run(now, job.id, job.lease_token);
        this.#database
          .prepare(
            `UPDATE automation_job_attempts
             SET status = 'expired', finished_at = ?, error_json = ?
             WHERE job_id = ? AND lease_token = ? AND status IN ('leased', 'running')`,
          )
          .run(now, errorJson, job.id, job.lease_token);
        requeuedJobIds.push(job.id);
      }
    }
    return { requeuedJobIds, uncertainJobIds };
  }

  #finishJob(
    job: DbJobRow,
    leaseToken: string,
    status: Extract<DurableJobStatus, "succeeded" | "failed" | "canceled" | "uncertain">,
    now: number,
    resultJson: string | null,
    errorJson: string | null,
  ): void {
    this.#database
      .prepare(
        `UPDATE automation_jobs
         SET status = ?, lease_token = NULL, lease_expires_at = NULL, result_json = ?, error_json = ?,
             updated_at = ?, completed_at = ?
         WHERE id = ? AND lease_token = ?`,
      )
      .run(status, resultJson, errorJson, now, now, job.id, leaseToken);
    this.#database
      .prepare(
        `UPDATE automation_job_attempts
         SET status = ?, finished_at = ?, error_json = ?
         WHERE job_id = ? AND lease_token = ? AND status IN ('leased', 'running')`,
      )
      .run(status, now, errorJson, job.id, leaseToken);
  }

  #activeLease(
    input: JobLeaseInput,
    now: number,
    allowed: readonly ("leased" | "running")[],
  ): DbJobRow {
    const job = this.#requireJob(assertText(input.jobId, "jobId", 256));
    const token = assertText(input.leaseToken, "leaseToken", 512);
    if (!allowed.includes(job.status as "leased" | "running")) {
      throw new AutomationLeaseError(`Job does not have an active lease: ${job.id}`);
    }
    if (job.lease_token !== token || job.lease_expires_at === null || job.lease_expires_at <= now) {
      throw new AutomationLeaseError(`Lease is invalid or expired for job: ${job.id}`);
    }
    return job;
  }

  #queuePolicy(queueName: string, requireConfigured = false): QueuePolicy {
    const row = this.#database
      .prepare("SELECT * FROM automation_queue_policies WHERE queue_name = ?")
      .get(queueName) as DbQueuePolicy | undefined;
    if (row) {
      return {
        queueName: row.queue_name,
        concurrency: row.concurrency,
        startWindowMs: row.start_window_ms,
        maxStartsPerWindow: row.max_starts_per_window,
        leaseMs: row.lease_ms,
      };
    }
    if (!requireConfigured || queueName === DEFAULT_QUEUE_NAME) {
      return { queueName, ...DEFAULT_QUEUE_POLICY };
    }
    throw new AutomationConflictError(
      `Queue is not configured: ${queueName}. Run \`meka queue configure ${queueName}\` first`,
    );
  }

  #listQueuePoliciesUnsafe(): QueuePolicy[] {
    const rows = this.#database
      .prepare("SELECT * FROM automation_queue_policies ORDER BY queue_name ASC")
      .all() as DbQueuePolicy[];
    const policies = rows.map((row) => ({
      queueName: row.queue_name,
      concurrency: row.concurrency,
      startWindowMs: row.start_window_ms,
      maxStartsPerWindow: row.max_starts_per_window,
      leaseMs: row.lease_ms,
    }));
    if (!policies.some((policy) => policy.queueName === DEFAULT_QUEUE_NAME)) {
      policies.push({ queueName: DEFAULT_QUEUE_NAME, ...DEFAULT_QUEUE_POLICY });
      policies.sort((left, right) => left.queueName.localeCompare(right.queueName));
    }
    return policies;
  }

  #jobById(id: string): DbJobRow | undefined {
    return this.#database.prepare("SELECT * FROM automation_jobs WHERE id = ?").get(id) as
      | DbJobRow
      | undefined;
  }

  #requireJob(id: string): DbJobRow {
    const row = this.#jobById(id);
    if (!row) {
      throw new AutomationConflictError(`Durable job not found: ${id}`);
    }
    return row;
  }

  #ingestWorkflowEvent(input: WorkflowEventInput): IngestWorkflowEventResult {
    const type = assertName(input.type, "event type");
    const source = assertName(input.source, "event source");
    const receivedAt = timestamp(input.receivedAt, "receivedAt");
    const observedAt = timestamp(input.observedAt ?? input.occurredAt ?? receivedAt, "observedAt");
    const payloadJson = encodeJson(input.payload, "workflow event payload");
    const metadataJson =
      input.metadata === undefined ? null : encodeJson(input.metadata, "workflow event metadata");
    const deliveryId = input.deliveryId ? assertText(input.deliveryId, "deliveryId", 512) : null;
    const dedupeKey =
      deliveryId ??
      hash(
        encodeJson(
          {
            type,
            source,
            observedAt,
            payload: JSON.parse(payloadJson),
            metadata: metadataJson ? JSON.parse(metadataJson) : null,
          },
          "workflow event fingerprint",
        ),
      );
    const id = `wfe_${hash(`${source}\u0000${dedupeKey}`)}`;
    const result = this.#database
      .prepare(
        `INSERT INTO automation_workflow_events(
           id, event_type, source, delivery_id, dedupe_key, verified, occurred_at, received_at,
           payload_json, payload_hash, metadata_json, metadata_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, dedupe_key) DO NOTHING`,
      )
      .run(
        id,
        type,
        source,
        deliveryId,
        dedupeKey,
        input.verified === true ? 1 : 0,
        observedAt,
        receivedAt,
        payloadJson,
        hash(payloadJson),
        metadataJson,
        metadataJson ? hash(metadataJson) : null,
      );
    const row = this.#database
      .prepare("SELECT * FROM automation_workflow_events WHERE source = ? AND dedupe_key = ?")
      .get(source, dedupeKey) as DbWorkflowEventRow | undefined;
    if (!row) {
      throw new AutomationConflictError(`Workflow event was not persisted: ${source}/${dedupeKey}`);
    }
    return { inserted: Number(result.changes) === 1, event: toWorkflowEvent(row) };
  }

  #ingestAgentHookEvent(input: AgentHookEventInput): IngestAgentEventResult {
    const event = normalizeAgentHookEvent(input);
    const result = this.#database
      .prepare(
        `INSERT INTO automation_agent_events(
           id, source, source_event_id, provider, session_id, event_type, occurred_at, received_at, payload_json, payload_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, source_event_id) DO NOTHING`,
      )
      .run(
        event.id,
        event.source,
        event.sourceEventId,
        event.provider,
        event.sessionId,
        event.eventType,
        event.occurredAt,
        event.receivedAt,
        event.payloadJson,
        event.payloadHash,
      );
    const row = this.#database
      .prepare("SELECT * FROM automation_agent_events WHERE source = ? AND source_event_id = ?")
      .get(event.source, event.sourceEventId) as DbAgentEventRow | undefined;
    if (!row) {
      throw new AutomationConflictError(
        `Agent event was not persisted: ${event.source}/${event.sourceEventId}`,
      );
    }
    const inserted = Number(result.changes) === 1;
    const sessionLease = inserted
      ? this.#deriveExternalSessionLease(row, event.sessionLeaseMs)
      : null;
    return { inserted, event: toAgentEvent(row), sessionLease };
  }

  #deriveExternalSessionLease(
    event: DbAgentEventRow,
    leaseMs: number,
  ): ExternalAgentSessionLease | null {
    if (!event.session_id) {
      return null;
    }
    const action = externalSessionAction(event.event_type);
    if (!action) {
      return null;
    }
    const provider = event.provider ?? event.source;
    const existing = this.#database
      .prepare("SELECT * FROM automation_external_sessions WHERE provider = ? AND session_id = ?")
      .get(provider, event.session_id) as DbExternalSessionRow | undefined;
    if (existing && !this.#shouldApplyExternalSessionEvent(existing, event, action)) {
      return toExternalSession(existing);
    }
    if (action === "renew") {
      const leasedUntil = event.received_at + leaseMs;
      const token = `agent-event:${event.id}`;
      this.#database
        .prepare(
          `INSERT INTO automation_external_sessions(
             provider, session_id, state, lease_token, leased_until, first_event_id, last_event_id,
             created_at, updated_at, released_at, last_occurred_at
           ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT(provider, session_id) DO UPDATE SET
             state = 'active', lease_token = excluded.lease_token, leased_until = excluded.leased_until,
             last_event_id = excluded.last_event_id, updated_at = excluded.updated_at,
             released_at = NULL, last_occurred_at = excluded.last_occurred_at`,
        )
        .run(
          provider,
          event.session_id,
          token,
          leasedUntil,
          event.id,
          event.id,
          event.received_at,
          event.received_at,
          event.occurred_at,
        );
    } else {
      this.#database
        .prepare(
          `INSERT INTO automation_external_sessions(
             provider, session_id, state, lease_token, leased_until, first_event_id, last_event_id,
             created_at, updated_at, released_at, last_occurred_at
           ) VALUES (?, ?, 'released', ?, NULL, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, session_id) DO UPDATE SET
             state = 'released', leased_until = NULL, last_event_id = excluded.last_event_id,
             updated_at = excluded.updated_at, released_at = excluded.released_at,
             last_occurred_at = excluded.last_occurred_at`,
        )
        .run(
          provider,
          event.session_id,
          `agent-event:${event.id}`,
          event.id,
          event.id,
          event.received_at,
          event.received_at,
          event.received_at,
          event.occurred_at,
        );
    }
    const row = this.#database
      .prepare("SELECT * FROM automation_external_sessions WHERE provider = ? AND session_id = ?")
      .get(provider, event.session_id) as DbExternalSessionRow | undefined;
    return row ? toExternalSession(row) : null;
  }

  #shouldApplyExternalSessionEvent(
    current: DbExternalSessionRow,
    incoming: DbAgentEventRow,
    incomingAction: "renew" | "release",
  ): boolean {
    const previous = this.#database
      .prepare("SELECT * FROM automation_agent_events WHERE id = ?")
      .get(current.last_event_id) as DbAgentEventRow | undefined;
    if (!previous) {
      const previousOccurredAt = current.last_occurred_at ?? current.updated_at;
      if (incoming.occurred_at < previousOccurredAt || incoming.received_at < current.updated_at) {
        return false;
      }
      if (incoming.occurred_at > previousOccurredAt || incoming.received_at > current.updated_at) {
        return true;
      }
      return incomingAction === "release" && current.state !== "released";
    }

    // Session state is monotonic across both timestamps. A delayed occurrence
    // must not reopen a session merely because it arrived later, and a forged
    // or skewed received time must not rewind a newer observation.
    if (
      incoming.occurred_at < previous.occurred_at ||
      incoming.received_at < previous.received_at
    ) {
      return false;
    }
    if (
      incoming.occurred_at > previous.occurred_at ||
      incoming.received_at > previous.received_at
    ) {
      return true;
    }

    // Equal-time events are resolved deterministically: release wins, while a
    // same-time activity event can never reactivate a released session.
    const previousAction = externalSessionAction(previous.event_type);
    return incomingAction === "release" && previousAction !== "release";
  }

  #workflowById(id: string): DbWorkflowRow | undefined {
    return this.#database.prepare("SELECT * FROM automation_workflows WHERE id = ?").get(id) as
      | DbWorkflowRow
      | undefined;
  }

  #requireWorkflowEventDetail(id: string): WorkflowEventDetail {
    const row = this.#database
      .prepare("SELECT * FROM automation_workflow_events WHERE id = ?")
      .get(id) as DbWorkflowEventRow | undefined;
    if (!row) {
      throw new AutomationConflictError(`Workflow event not found: ${id}`);
    }
    return toWorkflowEventDetail(row);
  }

  #requireWorkflow(id: string): DbWorkflowRow {
    const row = this.#workflowById(id);
    if (!row) {
      throw new AutomationConflictError(`Workflow registration not found: ${id}`);
    }
    return row;
  }

  #sourceById(id: string): DbSourceRow | undefined {
    return this.#database.prepare("SELECT * FROM automation_sources WHERE id = ?").get(id) as
      | DbSourceRow
      | undefined;
  }

  #requireSource(id: string): DbSourceRow {
    const row = this.#sourceById(id);
    if (!row) {
      throw new AutomationConflictError(`Source registration not found: ${id}`);
    }
    return row;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AutomationConflictError("Automation store is closed");
    }
  }
}

/** Opens a local durable store. Call `close()` when using it outside an Effect scope. */
export function openAutomationStore(
  options: AutomationStateOptions = {},
): Effect.Effect<AutomationStore, ReturnType<typeof asAutomationError>> {
  return Effect.try({
    try: () => AutomationStore.unsafeOpen(options),
    catch: (cause) => asAutomationError("open automation store", cause),
  });
}

/** Scoped resource constructor for long-lived server wiring. */
export const scopedAutomationStore = (options: AutomationStateOptions = {}) =>
  Effect.acquireRelease(openAutomationStore(options), (store) => Effect.orDie(store.close()));

function assertPrivateDatabasePath(databasePath: string): void {
  if (!existsSync(databasePath)) {
    return;
  }
  const metadata = lstatSync(databasePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new AutomationValidationError(
      `Automation database path must be a regular non-symlink file: ${databasePath}`,
    );
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new AutomationValidationError(
      `Automation database is not owned by the current user: ${databasePath}`,
    );
  }
}

function normalizeQueuePolicy(policy: QueuePolicy): QueuePolicy {
  return {
    queueName: assertName(policy.queueName, "queue name"),
    concurrency: assertPositiveInteger(policy.concurrency, "concurrency"),
    startWindowMs: assertPositiveInteger(policy.startWindowMs, "startWindowMs"),
    maxStartsPerWindow: assertPositiveInteger(policy.maxStartsPerWindow, "maxStartsPerWindow"),
    leaseMs: assertQueueLeaseMs(policy.leaseMs),
  };
}

function assertQueueLeaseMs(value: number): number {
  const leaseMs = assertPositiveInteger(value, "leaseMs");
  if (leaseMs < MIN_QUEUE_LEASE_MS) {
    throw new AutomationValidationError(`leaseMs must be at least ${MIN_QUEUE_LEASE_MS}`);
  }
  return leaseMs;
}

function normalizeAgentHookEvent(input: AgentHookEventInput): NormalizedAgentEvent {
  const source = assertName(input.source, "agent event source");
  const provider = input.provider ? assertName(input.provider, "provider") : null;
  const eventType = assertText(input.eventType, "agent event type", 256);
  const payload = input.payload ?? {};
  const payloadJson = encodeJson(payload, "agent event payload");
  const sessionId = input.sessionId
    ? assertText(input.sessionId, "sessionId", 512)
    : sessionIdFromPayload(payload);
  const receivedAt = timestamp(input.receivedAt, "receivedAt");
  const occurredAt = timestamp(input.occurredAt ?? receivedAt, "occurredAt");
  const sourceEventId = input.sourceEventId
    ? assertText(input.sourceEventId, "sourceEventId", 512)
    : hash(
        encodeJson(
          {
            source,
            provider,
            sessionId,
            eventType,
            occurredAt,
            payload: JSON.parse(payloadJson),
          },
          "agent event fingerprint",
        ),
      );
  return {
    id: `ae_${hash(`${source}\u0000${sourceEventId}`)}`,
    source,
    sourceEventId,
    provider,
    sessionId,
    eventType,
    occurredAt,
    receivedAt,
    payloadJson,
    payloadHash: hash(payloadJson),
    sessionLeaseMs: normalizeSessionLeaseMs(input.sessionLeaseMs),
  };
}

function normalizeWorkflowRegistration(
  input: WorkflowRegistrationInput,
): Omit<WorkflowRegistration, "createdAt" | "updatedAt"> {
  return {
    id: assertName(input.id, "workflow id"),
    moduleRealpath: resolveModuleRealpath(input.modulePath),
    revisionHash: assertText(input.revisionHash, "revisionHash", 512),
    triggerTypes: normalizeTriggerTypes(input.triggerTypes),
    queueName: assertName(input.queueName, "queue name"),
    enabled: input.enabled ?? true,
  };
}

function normalizeSourceRegistration(
  input: SourceRegistrationInput,
): Pick<
  SourceRegistration,
  "id" | "kind" | "workflowId" | "enabled" | "config" | "cursor" | "dedupeState"
> {
  return {
    id: assertName(input.id, "source id"),
    kind: assertName(input.kind, "source kind"),
    workflowId: assertName(input.workflowId, "workflow id"),
    enabled: input.enabled ?? true,
    config: input.config ?? {},
    cursor: input.cursor,
    dedupeState: input.dedupeState,
  };
}

function resolveModuleRealpath(modulePath: string): string {
  const candidate = assertText(modulePath, "modulePath", 4096);
  try {
    const resolved = realpathSync(candidate);
    if (!lstatSync(resolved).isFile()) {
      throw new AutomationValidationError(`Workflow module must be a file: ${candidate}`);
    }
    return resolved;
  } catch (cause) {
    if (cause instanceof AutomationValidationError) {
      throw cause;
    }
    throw new AutomationValidationError(
      `Workflow module must resolve to a local realpath: ${candidate} (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
}

function normalizeTriggerTypes(triggerTypes: readonly string[]): string[] {
  if (!Array.isArray(triggerTypes) || triggerTypes.length > 128) {
    throw new AutomationValidationError("Workflow triggerTypes must contain at most 128 entries");
  }
  return [...new Set(triggerTypes.map((value) => assertName(value, "trigger type")))].sort();
}

function parseTriggerTypes(value: string): string[] {
  const parsed = decodeJson(value, "workflow trigger types");
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new AutomationValidationError("Stored workflow trigger types are invalid");
  }
  return normalizeTriggerTypes(parsed);
}

function externalSessionAction(eventType: string): "renew" | "release" | undefined {
  const normalized = eventType.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized.endsWith("sessionend")) {
    return "release";
  }
  // Any hook carrying a session id proves recent activity. This keeps long
  // external sessions alive through prompt/tool/turn hooks even when a host
  // has no periodic heartbeat or session-end event.
  return "renew";
}

function sessionIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const candidate = record.session_id ?? record.sessionId;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? assertText(candidate, "payload session id", 512)
    : null;
}

function normalizeSessionLeaseMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_EXTERNAL_SESSION_LEASE_MS;
  }
  const leaseMs = assertPositiveInteger(value, "sessionLeaseMs");
  if (leaseMs > 24 * 60 * 60_000) {
    throw new AutomationValidationError("sessionLeaseMs must not exceed 24 hours");
  }
  return leaseMs;
}

function toJob(row: DbJobRow): DurableJob {
  return {
    id: row.id,
    queueName: row.queue_name,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    priority: row.priority,
    notBefore: iso(row.not_before),
    attemptCount: row.attempt_count,
    leaseExpiresAt: nullableIso(row.lease_expires_at),
    externalDispatchStartedAt: nullableIso(row.external_dispatch_started_at),
    provider: row.provider,
    providerAcceptedAt: nullableIso(row.provider_accepted_at),
    providerReference: row.provider_reference,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: nullableIso(row.completed_at),
  };
}

function toJobDetail(row: DbJobRow): DurableJobDetail {
  return {
    ...toJob(row),
    payload: decodeJson(row.payload_json, "job payload"),
    result: row.result_json === null ? null : decodeJson(row.result_json, "job result"),
    error: row.error_json === null ? null : decodeJson(row.error_json, "job error"),
  };
}

function toAttempt(row: DbAttemptRow): DurableJobAttempt {
  return {
    id: row.id,
    jobId: row.job_id,
    attemptNumber: row.attempt_number,
    status: row.status,
    leaseToken: row.lease_token,
    leasedAt: iso(row.leased_at),
    leaseExpiresAt: iso(row.lease_expires_at),
    startedAt: nullableIso(row.started_at),
    externalDispatchStartedAt: nullableIso(row.external_dispatch_started_at),
    provider: row.provider,
    providerAcceptedAt: nullableIso(row.provider_accepted_at),
    providerReference: row.provider_reference,
    finishedAt: nullableIso(row.finished_at),
    error: row.error_json === null ? null : decodeJson(row.error_json, "attempt error"),
  };
}

function toWorkflowEvent(row: DbWorkflowEventRow): WorkflowEvent {
  return {
    id: row.id,
    type: row.event_type,
    source: row.source,
    deliveryId: row.delivery_id,
    verified: row.verified === 1,
    observedAt: iso(row.occurred_at),
    receivedAt: iso(row.received_at),
    payloadHash: row.payload_hash,
    metadataHash: row.metadata_hash,
  };
}

function toWorkflowEventDetail(row: DbWorkflowEventRow): WorkflowEventDetail {
  return {
    ...toWorkflowEvent(row),
    payload: decodeJson(row.payload_json, "workflow event payload"),
    metadata:
      row.metadata_json === null ? null : decodeJson(row.metadata_json, "workflow event metadata"),
  };
}

function toAgentEvent(row: DbAgentEventRow): AgentEvent {
  return {
    id: row.id,
    source: row.source,
    sourceEventId: row.source_event_id,
    provider: row.provider,
    sessionId: row.session_id,
    eventType: row.event_type,
    occurredAt: iso(row.occurred_at),
    receivedAt: iso(row.received_at),
    payloadHash: row.payload_hash,
  };
}

function toAgentEventDetail(row: DbAgentEventRow): AgentEventDetail {
  return { ...toAgentEvent(row), payload: decodeJson(row.payload_json, "agent event payload") };
}

function toExternalSession(row: DbExternalSessionRow): ExternalAgentSessionLease {
  return {
    provider: row.provider,
    sessionId: row.session_id,
    state: row.state,
    leaseToken: row.lease_token,
    leasedUntil: nullableIso(row.leased_until),
    firstEventId: row.first_event_id,
    lastEventId: row.last_event_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    releasedAt: nullableIso(row.released_at),
  };
}

function toWorkflowRegistration(row: DbWorkflowRow): WorkflowRegistration {
  return {
    id: row.id,
    moduleRealpath: row.module_realpath,
    revisionHash: row.revision_hash,
    triggerTypes: parseTriggerTypes(row.trigger_types_json),
    queueName: row.queue_name,
    enabled: row.enabled === 1,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toSourceRegistration(row: DbSourceRow): SourceRegistration {
  return {
    id: row.id,
    kind: row.kind,
    workflowId: row.workflow_id,
    enabled: row.enabled === 1,
    config: decodeJson(row.config_json, "source config"),
    cursor: row.cursor_json === null ? null : decodeJson(row.cursor_json, "source cursor"),
    dedupeState:
      row.dedupe_state_json === null
        ? null
        : decodeJson(row.dedupe_state_json, "source dedupe state"),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function timestamp(value: AutomationTimestamp | undefined, label: string): number {
  if (value === undefined) {
    return Date.now();
  }
  const date = value instanceof Date ? value : new Date(value);
  const milliseconds = date.getTime();
  if (!Number.isSafeInteger(milliseconds)) {
    throw new AutomationValidationError(`${label} must be a valid timestamp`);
  }
  return milliseconds;
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function nullableIso(milliseconds: number | null): string | null {
  return milliseconds === null ? null : iso(milliseconds);
}

function assertName(value: string, label: string): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw new AutomationValidationError(
      `${label} must start with a letter or number and contain only letters, numbers, '.', '_', ':', '/', or '-'`,
    );
  }
  return value;
}

function assertText(value: string, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new AutomationValidationError(
      `${label} must be a non-empty string of at most ${maximum} characters`,
    );
  }
  return value;
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AutomationValidationError(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AutomationValidationError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeExternalSessionStates(
  states: readonly ExternalAgentSessionLease["state"][] | undefined,
): ExternalAgentSessionLease["state"][] {
  if (!states) return [];
  const normalized: ExternalAgentSessionLease["state"][] = [];
  for (const state of states) {
    if (state !== "active" && state !== "released" && state !== "expired") {
      throw new AutomationValidationError(`Unknown external session state: ${String(state)}`);
    }
    if (!normalized.includes(state)) normalized.push(state);
  }
  return normalized;
}

function assertJobStatus(status: string): asserts status is DurableJobStatus {
  if (
    status !== "pending" &&
    status !== "leased" &&
    status !== "running" &&
    status !== "succeeded" &&
    status !== "failed" &&
    status !== "canceled" &&
    status !== "uncertain"
  ) {
    throw new AutomationValidationError(`Unknown durable job status: ${status}`);
  }
}

function assertUncertainJobResolution(
  status: string,
): Extract<DurableJobStatus, "succeeded" | "failed" | "canceled"> {
  if (status !== "succeeded" && status !== "failed" && status !== "canceled") {
    throw new AutomationValidationError(`Unknown uncertain job resolution: ${status}`);
  }
  return status;
}

function listLimit(value: number | undefined): number {
  if (value === undefined) {
    return 100;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new AutomationValidationError(
      `List limit must be an integer from 1 to ${MAX_LIST_LIMIT}`,
    );
  }
  return value;
}

function count(row: unknown): number {
  if (!row || typeof row !== "object" || !("count" in row) || typeof row.count !== "number") {
    throw new AutomationConflictError("SQLite count query returned an invalid row");
  }
  return row.count;
}

function encodeJson(value: unknown, label: string): string {
  const normalized = normalizeJson(value, new WeakSet<object>());
  const encoded = JSON.stringify(normalized);
  if (encoded === undefined) {
    throw new AutomationValidationError(`${label} is not JSON serializable`);
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_JSON_BYTES) {
    throw new AutomationValidationError(`${label} exceeds ${MAX_JSON_BYTES} bytes`);
  }
  return encoded;
}

function decodeJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new AutomationValidationError(`Stored ${label} is not valid JSON`);
  }
}

function normalizeJson(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AutomationValidationError("JSON values cannot contain non-finite numbers");
    }
    return value;
  }
  if (typeof value === "bigint") {
    return { $bigint: value.toString() };
  }
  if (value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new AutomationValidationError("JSON values cannot contain an invalid Date");
    }
    return value.toISOString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString("base64") };
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new AutomationValidationError("JSON values cannot be circular");
    }
    seen.add(value);
    const normalized = value.map((entry) => normalizeJson(entry, seen));
    seen.delete(value);
    return normalized;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      throw new AutomationValidationError("JSON values cannot be circular");
    }
    seen.add(value);
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry !== undefined) {
        normalized[key] = normalizeJson(entry, seen);
      }
    }
    seen.delete(value);
    return normalized;
  }
  throw new AutomationValidationError("JSON values cannot contain functions or symbols");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
