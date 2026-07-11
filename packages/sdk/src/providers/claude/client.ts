import { randomUUID } from "node:crypto";
import {
  getSessionMessages,
  listSessions,
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeEventEmitter } from "./events.ts";

export const DEFAULT_CLAUDE_COMMAND = "claude";

const DEFAULT_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies readonly SettingSource[];

export type ClaudeCodeQuery = AsyncIterable<SDKMessage> & {
  interrupt(): Promise<void>;
  close(): void;
};

export type ClaudeCodeClientOptions = {
  /**
   * The Claude executable to run. Defaults to `claude` on PATH, so the
   * user's normally installed and authenticated Claude Code is used.
   */
  command?: string;
  cwd?: string;
  /**
   * Deliberately unset by default. Supplying no environment override preserves
   * HOME, CLAUDE_CONFIG_DIR, credentials, plugins, MCP connectors, and other
   * normal local Claude Code state.
   */
  environment?: NodeJS.ProcessEnv;
  settingSources?: readonly SettingSource[];
  createQuery?: (input: {
    prompt: AsyncIterable<SDKUserMessage>;
    options: Options;
  }) => ClaudeCodeQuery;
};

export type ClaudeCodeSessionStartOptions = {
  cwd?: string;
  resume?: string;
  forkSession?: boolean;
  model?: string;
  permissionMode?: PermissionMode;
  /**
   * Required by Claude Code when using `permissionMode: "bypassPermissions"`.
   * Only enable this inside an externally sandboxed, unattended environment.
   */
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];
  maxTurns?: number;
  effort?: Options["effort"];
};

export type ClaudeCodeSessionOptions = ClaudeCodeSessionStartOptions & {
  sessionId: string;
  command: string;
  settingSources: readonly SettingSource[];
  environment?: NodeJS.ProcessEnv;
  createQuery: ClaudeCodeClientOptions["createQuery"];
};

export type ClaudeCodeApprovalDecision = {
  behavior: "allow" | "deny";
  message?: string;
  interrupt?: boolean;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: PermissionUpdate[];
};

export type ClaudeCodeDelta = {
  kind: "text" | "thinking";
  delta: string;
  event: unknown;
};

export type ClaudeCodeEvent =
  | { type: "session.started"; sessionId: string; message: SDKMessage }
  | { type: "message"; sessionId: string; message: SDKMessage }
  | { type: "message.delta"; sessionId: string; delta: ClaudeCodeDelta }
  | {
      type: "approval.requested";
      sessionId: string;
      requestId: string;
      toolName: string;
      input: Record<string, unknown>;
      suggestions?: PermissionUpdate[];
    }
  | {
      type: "approval.resolved";
      sessionId: string;
      requestId: string;
      decision: ClaudeCodeApprovalDecision;
    }
  | { type: "session.error"; sessionId: string; error: Error }
  | { type: "session.closed"; sessionId: string };

type PendingApproval = {
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  abortListener: () => void;
  signal: AbortSignal;
};

export class ClaudeCodeClient extends ClaudeCodeEventEmitter {
  readonly command: string;
  readonly cwd: string | undefined;
  readonly environment: NodeJS.ProcessEnv | undefined;
  readonly settingSources: readonly SettingSource[];
  #sessions = new Map<string, ClaudeCodeSession>();
  #createQuery: NonNullable<ClaudeCodeClientOptions["createQuery"]>;

  constructor(options: ClaudeCodeClientOptions = {}) {
    super();
    this.command = options.command ?? process.env.CLAUDE_CODE_EXECUTABLE ?? DEFAULT_CLAUDE_COMMAND;
    this.cwd = options.cwd;
    this.environment = options.environment;
    this.settingSources = options.settingSources ?? DEFAULT_SETTING_SOURCES;
    this.#createQuery = options.createQuery ?? ((input) => query(input) as ClaudeCodeQuery);
  }

  async listSessions(options?: Parameters<typeof listSessions>[0]) {
    return await listSessions(options);
  }

  async getSessionMessages(sessionId: string, options?: Parameters<typeof getSessionMessages>[1]) {
    return await getSessionMessages(sessionId, options);
  }

  startSession(options: ClaudeCodeSessionStartOptions = {}): ClaudeCodeSession {
    const sessionId = options.resume && !options.forkSession ? options.resume : randomUUID();
    const cwd = options.cwd ?? this.cwd;
    const session = new ClaudeCodeSession({
      ...options,
      sessionId,
      command: this.command,
      settingSources: this.settingSources,
      ...(cwd === undefined ? {} : { cwd }),
      ...(this.environment ? { environment: this.environment } : {}),
      createQuery: this.#createQuery,
    });
    this.#sessions.set(sessionId, session);
    session.on("event", (event: ClaudeCodeEvent) => this.emit("event", event));
    session.once("closed", () => {
      if (this.#sessions.get(sessionId) === session) {
        this.#sessions.delete(sessionId);
      }
    });
    return session;
  }

  getActiveSession(sessionId: string): ClaudeCodeSession | undefined {
    return this.#sessions.get(sessionId);
  }

  requireActiveSession(sessionId: string): ClaudeCodeSession {
    const session = this.getActiveSession(sessionId);
    if (!session) {
      throw new Error(`Claude session is not active: ${sessionId}`);
    }
    return session;
  }

  close(): void {
    for (const session of this.#sessions.values()) {
      session.close();
    }
    this.#sessions.clear();
  }
}

export class ClaudeCodeSession extends ClaudeCodeEventEmitter {
  readonly id: string;
  readonly query: ClaudeCodeQuery;
  #messages = new AsyncMessageQueue();
  #pendingApprovals = new Map<string, PendingApproval>();
  #closed = false;

  constructor(options: ClaudeCodeSessionOptions) {
    super();
    this.id = options.sessionId;
    const queryOptions: Options = {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(options.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
      ...(options.additionalDirectories
        ? { additionalDirectories: options.additionalDirectories }
        : {}),
      ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      pathToClaudeCodeExecutable: options.command,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: [...options.settingSources],
      includePartialMessages: true,
      canUseTool: this.#requestApproval,
      ...(options.resume ? { resume: options.resume } : { sessionId: this.id }),
      ...(options.forkSession ? { forkSession: true } : {}),
      ...(options.environment ? { env: options.environment } : {}),
    };
    const createQuery = options.createQuery ?? ((input) => query(input) as ClaudeCodeQuery);
    this.query = createQuery({ prompt: this.#messages, options: queryOptions });
    void this.#consumeMessages();
  }

  sendText(text: string): void {
    this.send({
      type: "user",
      session_id: this.id,
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
  }

  send(message: SDKUserMessage): void {
    if (this.#closed) {
      throw new Error(`Claude session is closed: ${this.id}`);
    }
    this.#messages.push({ ...message, session_id: this.id });
  }

  async interrupt(): Promise<void> {
    if (!this.#closed) {
      await this.query.interrupt();
    }
  }

  resolveApproval(requestId: string, decision: ClaudeCodeApprovalDecision): void {
    const pending = this.#pendingApprovals.get(requestId);
    if (!pending) {
      throw new Error(`Claude approval is not pending: ${requestId}`);
    }
    this.#pendingApprovals.delete(requestId);
    pending.signal.removeEventListener("abort", pending.abortListener);
    pending.resolve(
      decision.behavior === "allow"
        ? {
            behavior: "allow",
            updatedInput: decision.updatedInput ?? pending.input,
            ...(decision.updatedPermissions
              ? { updatedPermissions: decision.updatedPermissions }
              : {}),
          }
        : {
            behavior: "deny",
            message: decision.message ?? "User declined this action.",
            ...(decision.interrupt ? { interrupt: true } : {}),
          },
    );
    this.#publish({ type: "approval.resolved", sessionId: this.id, requestId, decision });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#messages.close();
    for (const [requestId] of this.#pendingApprovals) {
      this.resolveApproval(requestId, {
        behavior: "deny",
        message: "Claude session closed before the action was approved.",
        interrupt: true,
      });
    }
    this.query.close();
    this.#publish({ type: "session.closed", sessionId: this.id });
    this.emit("closed");
  }

  #requestApproval: CanUseTool = async (toolName, input, context) => {
    const requestId = context.toolUseID || randomUUID();
    return await new Promise<PermissionResult>((resolve) => {
      const abortListener = () => {
        if (!this.#pendingApprovals.delete(requestId)) {
          return;
        }
        resolve({
          behavior: "deny",
          message: "Claude stopped waiting for approval.",
          interrupt: true,
        });
      };
      context.signal.addEventListener("abort", abortListener, { once: true });
      this.#pendingApprovals.set(requestId, {
        input,
        resolve,
        abortListener,
        signal: context.signal,
      });
      this.#publish({
        type: "approval.requested",
        sessionId: this.id,
        requestId,
        toolName,
        input,
        ...(context.suggestions ? { suggestions: context.suggestions } : {}),
      });
    });
  };

  async #consumeMessages(): Promise<void> {
    try {
      for await (const message of this.query) {
        this.#publish({ type: "message", sessionId: this.id, message });
        if (message.type === "system" && message.subtype === "init") {
          this.#publish({ type: "session.started", sessionId: this.id, message });
        }
        const delta = messageDelta(message);
        if (delta) {
          this.#publish({ type: "message.delta", sessionId: this.id, delta });
        }
      }
    } catch (cause) {
      if (!this.#closed) {
        this.#publish({
          type: "session.error",
          sessionId: this.id,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      }
    } finally {
      if (!this.#closed) {
        this.close();
      }
    }
  }

  #publish(event: ClaudeCodeEvent): void {
    this.emit("event", event);
  }
}

class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
  #messages: SDKUserMessage[] = [];
  #waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  #closed = false;

  push(message: SDKUserMessage): void {
    if (this.#closed) {
      throw new Error("Claude input stream is closed");
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value: message });
      return;
    }
    this.#messages.push(message);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return { next: () => this.#next() };
  }

  #next(): Promise<IteratorResult<SDKUserMessage>> {
    const message = this.#messages.shift();
    if (message) {
      return Promise.resolve({ done: false, value: message });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

function messageDelta(message: SDKMessage): ClaudeCodeDelta | undefined {
  if (message.type !== "stream_event") {
    return undefined;
  }
  const event = message.event;
  if (event.type !== "content_block_delta") {
    return undefined;
  }
  if (event.delta.type === "text_delta") {
    return { kind: "text", delta: event.delta.text, event };
  }
  if (event.delta.type === "thinking_delta") {
    return { kind: "thinking", delta: event.delta.thinking, event };
  }
  return undefined;
}
