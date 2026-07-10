import { Schema } from "effect";
import { JsonObjectSchema, JsonValueSchema, type JsonObject, type JsonValue } from "./json.ts";

const NonEmptyStringSchema = Schema.String.pipe(Schema.minLength(1));

export type WorkflowEvent<Payload> = {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly observedAt: string;
  readonly verified: boolean;
  readonly deliveryId?: string;
  readonly trace?: {
    readonly id: string;
    readonly parentEventId?: string;
    readonly depth: number;
  };
  readonly metadata?: JsonObject;
  readonly payload: Payload;
};

/** Constructs the normalized event envelope schema for a workflow payload. */
export const makeWorkflowEventSchema = <Payload extends Schema.Schema.AnyNoContext>(
  payload: Payload,
): Schema.Schema<WorkflowEvent<Schema.Schema.Type<Payload>>, unknown, never> =>
  Schema.Struct({
    id: NonEmptyStringSchema,
    type: NonEmptyStringSchema,
    source: NonEmptyStringSchema,
    observedAt: NonEmptyStringSchema,
    verified: Schema.Boolean,
    deliveryId: Schema.optional(NonEmptyStringSchema),
    trace: Schema.optional(
      Schema.Struct({
        id: NonEmptyStringSchema,
        parentEventId: Schema.optional(NonEmptyStringSchema),
        depth: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
      }),
    ),
    metadata: Schema.optional(JsonObjectSchema),
    payload,
  }) as unknown as Schema.Schema<WorkflowEvent<Schema.Schema.Type<Payload>>, unknown, never>;

export const WorkflowEvent = Object.freeze({ schema: makeWorkflowEventSchema });

export const WorkflowDecisionSchema = Schema.Union(
  Schema.TaggedStruct("completed", {
    output: Schema.optional(JsonValueSchema),
  }),
  Schema.TaggedStruct("skipped", {
    reason: NonEmptyStringSchema,
  }),
  Schema.TaggedStruct("enqueued", {
    jobIds: Schema.NonEmptyArray(NonEmptyStringSchema),
  }),
);

export type WorkflowDecision = Schema.Schema.Type<typeof WorkflowDecisionSchema>;

export const WorkflowDecision = Object.freeze({
  completed(output?: JsonValue): WorkflowDecision {
    return output === undefined ? { _tag: "completed" } : { _tag: "completed", output };
  },
  skipped(reason: string): WorkflowDecision {
    return { _tag: "skipped", reason };
  },
  enqueued(jobIds: readonly [string, ...Array<string>]): WorkflowDecision {
    return { _tag: "enqueued", jobIds: [...jobIds] };
  },
});

export const DurableJobStateSchema = Schema.Literal(
  "pending",
  "leased",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "uncertain",
);

export type DurableJobState = Schema.Schema.Type<typeof DurableJobStateSchema>;

export const DurableJobRequestSchema = Schema.Struct({
  queue: NonEmptyStringSchema,
  kind: NonEmptyStringSchema,
  payload: JsonValueSchema,
  idempotencyKey: Schema.optional(NonEmptyStringSchema),
  priority: Schema.optional(Schema.Number.pipe(Schema.int())),
  notBefore: Schema.optional(NonEmptyStringSchema),
});

export type DurableJobRequest = Schema.Schema.Type<typeof DurableJobRequestSchema>;

/** Longest command action Meka will admit (24 hours). */
export const MAX_DURABLE_COMMAND_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

/** Payload persisted for the built-in durable `command` job kind. */
export const DurableCommandPayloadSchema = Schema.Struct({
  argv: Schema.NonEmptyArray(NonEmptyStringSchema),
  timeoutMs: Schema.optional(
    Schema.Number.pipe(
      Schema.int(),
      Schema.positive(),
      Schema.lessThanOrEqualTo(MAX_DURABLE_COMMAND_TIMEOUT_MS),
    ),
  ),
});

export type DurableCommandPayload = Schema.Schema.Type<typeof DurableCommandPayloadSchema>;

export type DurableCommandRequest = Omit<DurableJobRequest, "kind" | "payload"> & {
  readonly kind: "command";
  readonly payload: DurableCommandPayload;
};

export type DurableCommandOptions = {
  readonly queue: string;
  readonly argv: readonly [string, ...Array<string>];
  readonly timeoutMs?: number;
  readonly idempotencyKey?: string;
  readonly priority?: number;
  readonly notBefore?: string;
};

/** Builds and validates the only public request shape for a queued command action. */
export const DurableCommand = Object.freeze({
  kind: "command" as const,
  make(options: DurableCommandOptions): DurableCommandRequest {
    const payload = Schema.decodeUnknownSync(DurableCommandPayloadSchema)({
      argv: [...options.argv],
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return Schema.decodeUnknownSync(DurableJobRequestSchema)({
      queue: options.queue,
      kind: "command",
      payload,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      ...(options.notBefore === undefined ? {} : { notBefore: options.notBefore }),
    }) as DurableCommandRequest;
  },
});

export const DurableJobSchema = Schema.Struct({
  id: NonEmptyStringSchema,
  queue: NonEmptyStringSchema,
  kind: NonEmptyStringSchema,
  state: DurableJobStateSchema,
  payload: JsonValueSchema,
  idempotencyKey: Schema.optional(NonEmptyStringSchema),
  priority: Schema.Number.pipe(Schema.int()),
  notBefore: Schema.optional(NonEmptyStringSchema),
  attempt: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
  lastError: Schema.optional(JsonValueSchema),
});

export type DurableJob = Schema.Schema.Type<typeof DurableJobSchema>;

export const MekaProviderSchema = Schema.Literal("codex", "claude");
export type MekaProvider = Schema.Schema.Type<typeof MekaProviderSchema>;

export const MekaRunIntentSchema = Schema.TaggedStruct("meka.run", {
  provider: MekaProviderSchema,
  prompt: NonEmptyStringSchema,
  cwd: Schema.optional(NonEmptyStringSchema),
  model: Schema.optional(NonEmptyStringSchema),
  metadata: Schema.optional(JsonObjectSchema),
});

export type MekaRunIntent = Schema.Schema.Type<typeof MekaRunIntentSchema>;

/** A run intent plus the durable queue policy that must govern it. */
export const ManagedMekaRunRequestSchema = Schema.Struct({
  queue: NonEmptyStringSchema,
  intent: MekaRunIntentSchema,
  idempotencyKey: Schema.optional(NonEmptyStringSchema),
  priority: Schema.optional(Schema.Number.pipe(Schema.int())),
  notBefore: Schema.optional(NonEmptyStringSchema),
});

export type ManagedMekaRunRequest = Schema.Schema.Type<typeof ManagedMekaRunRequestSchema>;

export const WorkflowServiceErrorSchema = Schema.TaggedStruct("WorkflowServiceError", {
  operation: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
  retryable: Schema.Boolean,
  details: Schema.optional(JsonValueSchema),
});

export type WorkflowServiceError = Schema.Schema.Type<typeof WorkflowServiceErrorSchema>;

export const WorkflowServiceError = Object.freeze({
  make(input: {
    readonly operation: string;
    readonly message: string;
    readonly retryable?: boolean;
    readonly details?: JsonValue;
  }): WorkflowServiceError {
    return input.details === undefined
      ? {
          _tag: "WorkflowServiceError",
          operation: input.operation,
          message: input.message,
          retryable: input.retryable ?? false,
        }
      : {
          _tag: "WorkflowServiceError",
          operation: input.operation,
          message: input.message,
          retryable: input.retryable ?? false,
          details: input.details,
        };
  },
});

export const WorkflowIdentitySchema = Schema.Struct({
  id: NonEmptyStringSchema,
  revision: NonEmptyStringSchema,
  hash: NonEmptyStringSchema,
});

export type WorkflowIdentity = Schema.Schema.Type<typeof WorkflowIdentitySchema>;

export const WorkflowExecutionErrorSchema = Schema.Struct({
  kind: Schema.Literal(
    "WorkflowInputError",
    "WorkflowHandlerError",
    "WorkflowDecisionError",
    "WorkflowDefect",
  ),
  message: NonEmptyStringSchema,
  details: Schema.optional(JsonValueSchema),
});

export type WorkflowExecutionError = Schema.Schema.Type<typeof WorkflowExecutionErrorSchema>;

export const WorkflowExecutionResultSchema = Schema.Union(
  Schema.TaggedStruct("completed", {
    workflow: WorkflowIdentitySchema,
    eventId: NonEmptyStringSchema,
    decision: WorkflowDecisionSchema,
  }),
  Schema.TaggedStruct("failed", {
    workflow: WorkflowIdentitySchema,
    eventId: Schema.NullOr(NonEmptyStringSchema),
    error: WorkflowExecutionErrorSchema,
  }),
);

export type WorkflowExecutionResult = Schema.Schema.Type<typeof WorkflowExecutionResultSchema>;
