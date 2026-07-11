export const DURABLE_JOB_STATUSES = [
  "pending",
  "leased",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "uncertain",
] as const;

export type DurableJobStatus = (typeof DURABLE_JOB_STATUSES)[number];

export const JOB_ATTEMPT_STATUSES = [
  "leased",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "expired",
  "uncertain",
] as const;

export type JobAttemptStatus = (typeof JOB_ATTEMPT_STATUSES)[number];

export type AutomationTimestamp = Date | string | number;

export type AutomationStateOptions = {
  /**
   * Exact persistent state directory. This is useful for a sandbox supervisor
   * which already owns an isolated state volume.
   */
  stateRoot?: string;
  /** Workspace used to derive the deterministic default state root. */
  cwd?: string;
  /** Overrides XDG_STATE_HOME for deterministic tests or sandboxes. */
  stateHome?: string;
};

export type AutomationStateLocation = {
  root: string;
  databasePath: string;
  spoolPath: string;
  workspaceKey: string;
};

export type QueuePolicy = {
  queueName: string;
  /** Maximum simultaneous non-expired leases or running jobs. */
  concurrency: number;
  /** Rolling time window used to limit starts. */
  startWindowMs: number;
  /** Maximum attempts leased in a rolling start window. */
  maxStartsPerWindow: number;
  /** Lease lifetime for a newly claimed job (minimum 5 seconds). */
  leaseMs: number;
};

export type QueueUsage = QueuePolicy & {
  pending: number;
  active: number;
  concurrencyRemaining: number;
  startsUsed: number;
  startsRemaining: number;
  nextStartAt: string | null;
};

export type DurableJobInput = {
  id?: string;
  queueName: string;
  payload: unknown;
  idempotencyKey?: string;
  priority?: number;
  notBefore?: AutomationTimestamp;
  now?: AutomationTimestamp;
};

export type DurableJob = {
  id: string;
  queueName: string;
  status: DurableJobStatus;
  idempotencyKey: string | null;
  priority: number;
  notBefore: string;
  attemptCount: number;
  leaseExpiresAt: string | null;
  externalDispatchStartedAt: string | null;
  provider: string | null;
  providerAcceptedAt: string | null;
  providerReference: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type DurableJobDetail = DurableJob & {
  payload: unknown;
  result: unknown | null;
  error: unknown | null;
};

export type DurableJobAttempt = {
  id: number;
  jobId: string;
  attemptNumber: number;
  status: JobAttemptStatus;
  leaseToken: string;
  leasedAt: string;
  leaseExpiresAt: string;
  startedAt: string | null;
  externalDispatchStartedAt: string | null;
  provider: string | null;
  providerAcceptedAt: string | null;
  providerReference: string | null;
  finishedAt: string | null;
  error: unknown | null;
};

export type EnqueueJobResult = {
  created: boolean;
  job: DurableJob;
};

export type ClaimedJob = {
  job: DurableJob;
  payload: unknown;
  leaseToken: string;
  leaseExpiresAt: string;
  attempt: DurableJobAttempt;
};

export type ClaimNextJobInput = {
  queueName: string;
  /** Payload-envelope kinds a worker cannot currently admit. */
  excludePayloadKinds?: readonly string[];
  now?: AutomationTimestamp;
};

export type ClaimNextJobResult =
  | { kind: "claimed"; claim: ClaimedJob }
  | { kind: "empty" }
  | { kind: "concurrency-exhausted"; active: number; limit: number }
  | { kind: "start-budget-exhausted"; starts: number; limit: number; windowMs: number };

export type JobLeaseInput = {
  jobId: string;
  leaseToken: string;
  now?: AutomationTimestamp;
};

export type RenewJobLeaseInput = JobLeaseInput & {
  leaseMs?: number;
};

export type JobCompletionInput = JobLeaseInput & {
  result?: unknown;
};

export type JobFailureInput = JobLeaseInput & {
  error: unknown;
};

export type MarkExternalDispatchInput = JobLeaseInput & {
  provider?: string;
};

export type MarkProviderAcceptedInput = MarkExternalDispatchInput & {
  providerReference?: string;
};

export type CancelJobInput = {
  jobId: string;
  leaseToken?: string;
  reason?: unknown;
  now?: AutomationTimestamp;
};

export type RetryJobInput = {
  jobId: string;
  notBefore?: AutomationTimestamp;
  now?: AutomationTimestamp;
};

export type UncertainJobResolution = Extract<DurableJobStatus, "succeeded" | "failed" | "canceled">;

/**
 * An operator-confirmed outcome for work whose provider acceptance was
 * previously uncertain. This settles the existing attempt; it does not create
 * a new attempt or dispatch provider work again.
 */
export type ReconcileUncertainJobInput =
  | {
      jobId: string;
      status: "succeeded";
      result?: unknown;
      now?: AutomationTimestamp;
    }
  | {
      jobId: string;
      status: "failed" | "canceled";
      error?: unknown;
      now?: AutomationTimestamp;
    };

export type MarkJobUncertainInput = JobLeaseInput & {
  reason?: unknown;
};

export type ListJobsOptions = {
  queueName?: string;
  statuses?: readonly DurableJobStatus[];
  limit?: number;
};

export type CountJobsByStatusOptions = {
  queueName?: string;
};

export type DurableJobStatusCounts = Record<DurableJobStatus, number>;

export type ListAgentEventsOptions = {
  provider?: string;
  sessionId?: string;
  limit?: number;
};

export type ListExternalAgentSessionsOptions = {
  states?: readonly ExternalAgentSessionState[];
  limit?: number;
};

export type CountExternalAgentSessionsOptions = {
  states?: readonly ExternalAgentSessionState[];
};

export type PrunePersistedHookEventsOptions = {
  /** Per-table cap. Routed workflow events needed by active jobs are retained. */
  maxEntries?: number;
  maxAgeMs?: number;
  now?: AutomationTimestamp;
};

export type PrunePersistedHookEventsResult = {
  removedAgentEvents: number;
  removedWorkflowEvents: number;
  remainingAgentEvents: number;
  remainingWorkflowEvents: number;
};

export type LeaseRecovery = {
  requeuedJobIds: string[];
  uncertainJobIds: string[];
};

export type AgentHookEventInput = {
  source: string;
  /** The provider native id. When absent, a canonical event fingerprint is used. */
  sourceEventId?: string;
  provider?: string;
  sessionId?: string;
  /** Usually a provider hook name such as SessionStart or SessionEnd. */
  eventType: string;
  occurredAt?: AutomationTimestamp;
  receivedAt?: AutomationTimestamp;
  payload?: unknown;
  /** TTL for leases derived from SessionStart or a heartbeat event. */
  sessionLeaseMs?: number;
};

/** Provider-neutral ingress record for RSS, GitHub, commands, and hooks. */
export type WorkflowEventInput = {
  type: string;
  source: string;
  payload: unknown;
  verified?: boolean;
  deliveryId?: string;
  metadata?: unknown;
  /** Preferred name for the time the source observed the event. */
  observedAt?: AutomationTimestamp;
  /** Compatibility alias for sources that already call this occurrence time. */
  occurredAt?: AutomationTimestamp;
  receivedAt?: AutomationTimestamp;
};

export type WorkflowEvent = {
  id: string;
  type: string;
  source: string;
  deliveryId: string | null;
  verified: boolean;
  observedAt: string;
  receivedAt: string;
  payloadHash: string;
  metadataHash: string | null;
};

export type WorkflowEventDetail = WorkflowEvent & {
  payload: unknown;
  metadata: unknown | null;
};

export type IngestWorkflowEventResult = {
  inserted: boolean;
  event: WorkflowEvent;
};

export type IngestAndRouteWorkflowEventResult = {
  inserted: boolean;
  event: WorkflowEventDetail;
  jobIds: string[];
};

export type ListWorkflowEventsOptions = {
  source?: string;
  type?: string;
  verified?: boolean;
  limit?: number;
};

export type AgentEvent = {
  id: string;
  source: string;
  sourceEventId: string;
  provider: string | null;
  sessionId: string | null;
  eventType: string;
  occurredAt: string;
  receivedAt: string;
  payloadHash: string;
};

export type AgentEventDetail = AgentEvent & {
  payload: unknown;
};

export type ExternalAgentSessionState = "active" | "released" | "expired";

export type ExternalAgentSessionLease = {
  provider: string;
  sessionId: string;
  state: ExternalAgentSessionState;
  leaseToken: string;
  leasedUntil: string | null;
  firstEventId: string;
  lastEventId: string;
  createdAt: string;
  updatedAt: string;
  releasedAt: string | null;
};

export type IngestAgentEventResult = {
  inserted: boolean;
  event: AgentEvent;
  sessionLease: ExternalAgentSessionLease | null;
};

export type SpoolEntryInput = {
  id?: string;
  kind: string;
  payload: unknown;
  createdAt?: AutomationTimestamp;
};

export type SpoolEntry = {
  id: string;
  kind: string;
  createdAt: string;
  path: string;
  bytes: number;
};

export type SpoolEntryDetail = SpoolEntry & {
  payload: unknown;
};

export type AutomationStoreInfo = {
  location: AutomationStateLocation;
  schemaVersion: number;
};

export type WorkflowRegistrationInput = {
  id: string;
  /** Existing module path; Meka resolves and persists its realpath. */
  modulePath: string;
  revisionHash: string;
  triggerTypes: readonly string[];
  queueName: string;
  enabled?: boolean;
  now?: AutomationTimestamp;
};

export type WorkflowRegistration = {
  id: string;
  moduleRealpath: string;
  revisionHash: string;
  triggerTypes: string[];
  queueName: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type UpdateWorkflowRegistrationInput = {
  id: string;
  revisionHash?: string;
  triggerTypes?: readonly string[];
  queueName?: string;
  enabled?: boolean;
  /** Re-resolves and stores a new module realpath when supplied. */
  modulePath?: string;
  now?: AutomationTimestamp;
};

export type SourceRegistrationInput = {
  id: string;
  kind: string;
  workflowId: string;
  config?: unknown;
  enabled?: boolean;
  cursor?: unknown;
  dedupeState?: unknown;
  now?: AutomationTimestamp;
};

export type SourceRegistration = {
  id: string;
  kind: string;
  workflowId: string;
  enabled: boolean;
  config: unknown;
  cursor: unknown | null;
  dedupeState: unknown | null;
  createdAt: string;
  updatedAt: string;
};

export type UpdateSourceRegistrationInput = {
  id: string;
  kind?: string;
  workflowId?: string;
  enabled?: boolean;
  config?: unknown;
  cursor?: unknown;
  dedupeState?: unknown;
  now?: AutomationTimestamp;
};

export type ListWorkflowRegistrationsOptions = {
  enabled?: boolean;
  triggerType?: string;
  limit?: number;
};

export type ListSourceRegistrationsOptions = {
  enabled?: boolean;
  kind?: string;
  workflowId?: string;
  limit?: number;
};
