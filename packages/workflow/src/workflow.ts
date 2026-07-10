import { Cause, Effect, Exit, Option, Schema } from "effect";
import { formatUnknown, toJsonValue } from "./json.ts";
import {
  WorkflowDecisionSchema,
  makeWorkflowEventSchema,
  type WorkflowDecision,
  type WorkflowEvent,
  type WorkflowExecutionError,
  type WorkflowExecutionResult,
  type WorkflowIdentity,
} from "./model.ts";

export const MekaWorkflowTypeId: unique symbol = Symbol.for(
  "@meka/workflow/MekaWorkflow",
) as typeof MekaWorkflowTypeId;

export interface MekaWorkflowDefinition<
  Id extends string,
  Input extends Schema.Schema.AnyNoContext,
  Error,
  Requirements,
> {
  readonly [MekaWorkflowTypeId]: true;
  readonly id: Id;
  readonly on?: string | ReadonlyArray<string>;
  readonly input: Input;
  readonly handler: (
    event: WorkflowEvent<Schema.Schema.Type<Input>>,
  ) => Effect.Effect<WorkflowDecision, Error, Requirements>;
}

export type AnyMekaWorkflow = MekaWorkflowDefinition<
  string,
  Schema.Schema.AnyNoContext,
  unknown,
  unknown
>;

export type MekaWorkflowOptions<
  Id extends string,
  Input extends Schema.Schema.AnyNoContext,
  Error,
  Requirements,
> = {
  readonly id: Id;
  readonly on?: string | ReadonlyArray<string>;
  readonly input: Input;
  readonly handler: (
    event: WorkflowEvent<Schema.Schema.Type<Input>>,
  ) => Effect.Effect<WorkflowDecision, Error, Requirements>;
};

export function defineWorkflow<
  const Id extends string,
  Input extends Schema.Schema.AnyNoContext,
  Error = never,
  Requirements = never,
>(
  options: MekaWorkflowOptions<Id, Input, Error, Requirements>,
): MekaWorkflowDefinition<Id, Input, Error, Requirements> {
  assertStaticIdentifier("workflow id", options.id);
  if ("revision" in options || "hash" in options) {
    throw new TypeError("workflow revision and hash are assigned by the Meka registrar");
  }

  const triggers = workflowTriggerMetadata(options.on);
  for (const trigger of triggers) {
    assertStaticIdentifier("workflow trigger", trigger);
  }

  const definition = {
    [MekaWorkflowTypeId]: true as const,
    id: options.id,
    input: options.input,
    handler: options.handler,
  } as MekaWorkflowDefinition<Id, Input, Error, Requirements>;

  if (options.on === undefined) {
    return Object.freeze(definition);
  }
  return Object.freeze({
    ...definition,
    on: typeof options.on === "string" ? options.on : Object.freeze(triggers),
  });
}

/** Identifies a module default export produced by `defineWorkflow`. */
export function isMekaWorkflow(value: unknown): value is AnyMekaWorkflow {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<PropertyKey, unknown>;
  return (
    candidate[MekaWorkflowTypeId] === true &&
    typeof candidate.id === "string" &&
    Schema.isSchema(candidate.input) &&
    typeof candidate.handler === "function" &&
    (candidate.on === undefined ||
      typeof candidate.on === "string" ||
      (Array.isArray(candidate.on) && candidate.on.every((item) => typeof item === "string")))
  );
}

/** Returns normalized routing triggers; an empty list means manual-only. */
export function getWorkflowTriggers(workflow: Pick<AnyMekaWorkflow, "on">): ReadonlyArray<string> {
  return workflowTriggerMetadata(workflow.on);
}

export type RegisteredMekaWorkflow<Workflow extends AnyMekaWorkflow = AnyMekaWorkflow> = {
  readonly workflow: Workflow;
  readonly revision: string;
  readonly hash: string;
};

export function registerWorkflow<Workflow extends AnyMekaWorkflow>(
  workflow: Workflow,
  identity: { readonly revision: string; readonly hash: string },
): RegisteredMekaWorkflow<Workflow> {
  assertStaticIdentifier("workflow revision", identity.revision);
  assertStaticIdentifier("workflow hash", identity.hash);
  return Object.freeze({
    workflow,
    revision: identity.revision,
    hash: identity.hash,
  });
}

export function decodeWorkflowEvent<
  Id extends string,
  Input extends Schema.Schema.AnyNoContext,
  Error,
  Requirements,
>(workflow: MekaWorkflowDefinition<Id, Input, Error, Requirements>, input: unknown) {
  return Schema.decodeUnknown(makeWorkflowEventSchema(workflow.input))(input).pipe(
    Effect.mapError(
      (error): WorkflowExecutionError => ({
        kind: "WorkflowInputError",
        message: formatUnknown(error),
        details: toJsonValue(error),
      }),
    ),
  );
}

/**
 * Validates a normalized event, executes one handler, validates its decision,
 * and captures every typed failure or defect as a JSON-safe terminal result.
 */
export function executeWorkflow<
  const Id extends string,
  Input extends Schema.Schema.AnyNoContext,
  Error,
  Requirements,
>(
  registered: RegisteredMekaWorkflow<MekaWorkflowDefinition<Id, Input, Error, Requirements>>,
  input: unknown,
): Effect.Effect<WorkflowExecutionResult, never, Requirements> {
  const workflowIdentity: WorkflowIdentity = {
    id: registered.workflow.id,
    revision: registered.revision,
    hash: registered.hash,
  };

  const execution = decodeWorkflowEvent(registered.workflow, input).pipe(
    Effect.flatMap((event) =>
      Effect.suspend(() => registered.workflow.handler(event)).pipe(
        Effect.mapError(
          (error): WorkflowExecutionError => ({
            kind: "WorkflowHandlerError",
            message: formatUnknown(error),
            details: toJsonValue(error),
          }),
        ),
        Effect.flatMap((decision) =>
          Schema.decodeUnknown(WorkflowDecisionSchema)(decision).pipe(
            Effect.mapError(
              (error): WorkflowExecutionError => ({
                kind: "WorkflowDecisionError",
                message: formatUnknown(error),
                details: toJsonValue(error),
              }),
            ),
          ),
        ),
        Effect.map(
          (decision): WorkflowExecutionResult => ({
            _tag: "completed",
            workflow: workflowIdentity,
            eventId: event.id,
            decision,
          }),
        ),
      ),
    ),
  );

  return Effect.exit(execution).pipe(
    Effect.map((exit) =>
      Exit.match(exit, {
        onSuccess: (result) => result,
        onFailure: (cause): WorkflowExecutionResult => ({
          _tag: "failed",
          workflow: workflowIdentity,
          eventId: readEventId(input),
          error: errorFromCause(cause),
        }),
      }),
    ),
  );
}

/** Serializes an execution result for a one-shot child-process IPC response. */
export function serializeWorkflowExecutionResult(result: WorkflowExecutionResult): string {
  return JSON.stringify(result);
}

export const MekaWorkflow = Object.freeze({
  make: defineWorkflow,
  is: isMekaWorkflow,
  triggers: getWorkflowTriggers,
  register: registerWorkflow,
  decodeEvent: decodeWorkflowEvent,
  execute: executeWorkflow,
  serializeResult: serializeWorkflowExecutionResult,
});

function errorFromCause(cause: Cause.Cause<WorkflowExecutionError>): WorkflowExecutionError {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) {
    return failure.value;
  }
  return {
    kind: "WorkflowDefect",
    message: "Workflow terminated with an unhandled defect or interruption",
    details: { cause: Cause.pretty(cause) },
  };
}

function readEventId(input: unknown): string | null {
  if (typeof input !== "object" || input === null || !("id" in input)) {
    return null;
  }
  return typeof input.id === "string" && input.id.length > 0 ? input.id : null;
}

function assertStaticIdentifier(label: string, value: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty string without surrounding whitespace`);
  }
}

function workflowTriggerMetadata(
  on: string | ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (on === undefined) {
    return [];
  }
  const triggers = [...new Set(typeof on === "string" ? [on] : on)];
  if (triggers.length === 0) {
    throw new TypeError("workflow `on` must not be an empty array when provided");
  }
  return triggers;
}
