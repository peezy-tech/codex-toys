export class AutomationError extends Error {
  readonly _tag: string = "AutomationError";

  constructor(
    readonly operation: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AutomationError";
  }
}

export class AutomationValidationError extends AutomationError {
  readonly _tag = "AutomationValidationError";

  constructor(message: string) {
    super("validate", message);
    this.name = "AutomationValidationError";
  }
}

export class AutomationConflictError extends AutomationError {
  readonly _tag = "AutomationConflictError";

  constructor(message: string) {
    super("conflict", message);
    this.name = "AutomationConflictError";
  }
}

export class AutomationLeaseError extends AutomationError {
  readonly _tag = "AutomationLeaseError";

  constructor(message: string) {
    super("lease", message);
    this.name = "AutomationLeaseError";
  }
}

export function asAutomationError(operation: string, cause: unknown): AutomationError {
  if (cause instanceof AutomationError) {
    return cause;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new AutomationError(operation, message, cause);
}
