import { spawn } from "node:child_process";
import { CodexAppServerClient } from "./providers/codex/app-server/client.ts";
import type { v2 } from "./providers/codex/app-server/generated/index.ts";
import {
  ClaudeCodeClient,
  DEFAULT_CLAUDE_COMMAND,
  type ClaudeCodeSession,
  type ClaudeCodeSessionStartOptions,
} from "./providers/claude/client.ts";

export type MekaProvider = "codex" | "claude";
export type MekaRunState = "running" | "completed" | "failed" | "interrupted" | "closed";

export type MekaEvent = {
  provider: MekaProvider;
  event: unknown;
};

export type MekaRunInput = {
  provider: MekaProvider;
  prompt: string;
  cwd?: string;
  model?: string;
  onEvent?: (event: MekaEvent) => void;
};

export type MekaRunOutcome = {
  state: Exclude<MekaRunState, "running">;
  error?: string;
};

export type MekaRun = {
  provider: MekaProvider;
  providerSessionId: string;
  providerRunId: string | null;
  readonly state: MekaRunState;
  readonly done: Promise<MekaRunOutcome>;
  onEvent(listener: (event: MekaEvent) => void): () => void;
  interrupt(): Promise<void>;
  close(): Promise<void>;
};

export type InstallPluginInput =
  | {
      provider: "codex";
      plugin: string;
      marketplacePath?: string;
      remoteMarketplaceName?: string;
    }
  | {
      provider: "claude";
      plugin: string;
      scope?: "user" | "project" | "local";
      cwd?: string;
    };

export type CommandResult = {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type PluginInstallResult =
  | { provider: "codex"; result: v2.PluginInstallResponse }
  | ({ provider: "claude" } & CommandResult);

export type CodexMekaClient = Pick<
  CodexAppServerClient,
  | "connect"
  | "close"
  | "startThread"
  | "startTurn"
  | "interruptTurn"
  | "installPlugin"
  | "respond"
  | "respondError"
  | "on"
  | "off"
>;

export type ClaudeMekaClient = Pick<ClaudeCodeClient, "startSession" | "close">;
export type ClaudeMekaSession = Pick<
  ClaudeCodeSession,
  "id" | "sendText" | "interrupt" | "close" | "on" | "off"
>;

export type MekaOptions = {
  createCodexClient?: () => CodexMekaClient;
  createClaudeClient?: () => ClaudeMekaClient;
  runCommand?: (
    command: string,
    args: string[],
    options: { cwd?: string; signal?: AbortSignal },
  ) => Promise<CommandResult>;
};

/**
 * Thin access to locally configured coding harnesses. Full permissions are an
 * invariant: Codex runs with `never` + `danger-full-access`; Claude runs with
 * `bypassPermissions` + `allowDangerouslySkipPermissions`.
 */
export class Meka {
  #options: MekaOptions;
  #runs = new Set<ActiveRun>();
  #closed = false;
  #pluginAbortControllers = new Set<AbortController>();
  #pluginClients = new Set<CodexMekaClient>();
  #pluginQueues: Record<MekaProvider, Promise<unknown>> = {
    codex: Promise.resolve(),
    claude: Promise.resolve(),
  };

  constructor(options: MekaOptions = {}) {
    this.#options = options;
  }

  async startRun(input: MekaRunInput): Promise<MekaRun> {
    this.#assertOpen();
    return input.provider === "codex" ? await this.#startCodex(input) : this.#startClaude(input);
  }

  async installPlugin(input: InstallPluginInput): Promise<PluginInstallResult> {
    this.#assertOpen();
    const prior = this.#pluginQueues[input.provider];
    const task = prior.then(async () => {
      this.#assertOpen();
      return await this.#installPlugin(input);
    });
    this.#pluginQueues[input.provider] = task.catch(() => undefined);
    return await task;
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#pluginAbortControllers) {
      controller.abort();
    }
    for (const client of this.#pluginClients) {
      try {
        client.close();
      } catch {
        // Continue closing the remaining provider work.
      }
    }
    await Promise.allSettled([
      ...[...this.#runs].map(async (run) => await run.close()),
      this.#pluginQueues.codex,
      this.#pluginQueues.claude,
    ]);
  }

  async #installPlugin(input: InstallPluginInput): Promise<PluginInstallResult> {
    if (input.provider === "claude") {
      const controller = new AbortController();
      this.#pluginAbortControllers.add(controller);
      try {
        const result = await (this.#options.runCommand ?? runCommand)(
          process.env.CLAUDE_CODE_EXECUTABLE ?? DEFAULT_CLAUDE_COMMAND,
          ["plugin", "install", input.plugin, "--scope", input.scope ?? "user"],
          { ...(input.cwd ? { cwd: input.cwd } : {}), signal: controller.signal },
        );
        return { provider: "claude", ...result };
      } finally {
        this.#pluginAbortControllers.delete(controller);
      }
    }

    const client = this.#createCodexClient();
    this.#pluginClients.add(client);
    try {
      await client.connect();
      const result = await client.installPlugin({
        pluginName: input.plugin,
        ...(input.marketplacePath ? { marketplacePath: input.marketplacePath } : {}),
        ...(input.remoteMarketplaceName
          ? { remoteMarketplaceName: input.remoteMarketplaceName }
          : {}),
      });
      return { provider: "codex", result };
    } finally {
      this.#pluginClients.delete(client);
      client.close();
    }
  }

  async #startCodex(input: MekaRunInput): Promise<MekaRun> {
    const client = this.#createCodexClient();
    const run = this.#track(new ActiveRun("codex", input.onEvent));
    let pendingTerminal: unknown;
    const onNotification = (event: unknown) => {
      run.publish({ provider: "codex", event });
      if (run.providerRunId) {
        finishCodexRun(run, event);
      } else if (isCodexTurnCompleted(event)) {
        pendingTerminal = event;
      }
    };
    const onRequest = (event: unknown) => {
      run.publish({ provider: "codex", event });
      try {
        respondToCodexRequest(client, event);
      } catch (error) {
        run.publish({ provider: "codex", event: { type: "transport.error", error } });
        run.finish({ state: "failed", error: errorMessage(error) });
      }
    };
    const onStderr = (line: unknown) =>
      run.publish({
        provider: "codex",
        event: { type: "transport.stderr", line },
      });
    const onError = (error: unknown) => {
      run.publish({ provider: "codex", event: { type: "transport.error", error } });
      run.finish({ state: "failed", error: errorMessage(error) });
    };
    const onClose = (code: unknown, signal: unknown) => {
      run.publish({ provider: "codex", event: { type: "transport.closed", code, signal } });
      if (run.state === "running") {
        run.finish({ state: "closed" });
      }
    };
    const cleanup = () => {
      client.off("notification", onNotification);
      client.off("request", onRequest);
      client.off("stderr", onStderr);
      client.off("error", onError);
      client.off("close", onClose);
      client.close();
    };
    client.on("notification", onNotification);
    client.on("request", onRequest);
    client.on("stderr", onStderr);
    client.on("error", onError);
    client.on("close", onClose);
    run.setActions({ interrupt: async () => {}, cleanup });

    try {
      await client.connect();
      const thread = await client.startThread({
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.model ? { model: input.model } : {}),
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      const turn = await client.startTurn({
        threadId: thread.thread.id,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.model ? { model: input.model } : {}),
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
      });
      run.setIdentity(thread.thread.id, turn.turn.id);
      run.setActions({
        interrupt: async () => {
          await client.interruptTurn({ threadId: thread.thread.id, turnId: turn.turn.id });
        },
        cleanup,
      });
      if (pendingTerminal) {
        finishCodexRun(run, pendingTerminal);
      }
      return run;
    } catch (error) {
      run.setActions({ interrupt: async () => {}, cleanup });
      run.finish({ state: "failed", error: errorMessage(error) });
      throw error;
    }
  }

  #startClaude(input: MekaRunInput): MekaRun {
    const client = this.#createClaudeClient();
    const sessionOptions: ClaudeCodeSessionStartOptions = {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.model ? { model: input.model } : {}),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    };
    let session: ClaudeMekaSession;
    try {
      session = client.startSession(sessionOptions) as ClaudeMekaSession;
    } catch (error) {
      client.close();
      throw error;
    }
    const run = this.#track(new ActiveRun("claude", input.onEvent));
    run.setIdentity(session.id, null);
    const onEvent = (event: unknown) => {
      run.publish({ provider: "claude", event });
      const outcome = claudeOutcome(event);
      if (outcome) {
        run.finish(outcome);
      }
    };
    session.on("event", onEvent);
    run.setActions({
      interrupt: () => session.interrupt(),
      cleanup: () => {
        session.off("event", onEvent);
        session.close();
        client.close();
      },
    });
    try {
      session.sendText(input.prompt);
    } catch (error) {
      run.finish({ state: "failed", error: errorMessage(error) });
      throw error;
    }
    return run;
  }

  #track(run: ActiveRun): ActiveRun {
    this.#runs.add(run);
    run.onCleaned(() => this.#runs.delete(run));
    return run;
  }

  #createCodexClient(): CodexMekaClient {
    return (
      this.#options.createCodexClient?.() ??
      new CodexAppServerClient({
        clientName: "meka",
        clientTitle: "Meka",
        clientVersion: "0.1.0",
      })
    );
  }

  #createClaudeClient(): ClaudeMekaClient {
    return this.#options.createClaudeClient?.() ?? new ClaudeCodeClient();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("Meka is closed");
    }
  }
}

export type MekaEngine = Pick<Meka, "startRun" | "installPlugin" | "close">;

class ActiveRun implements MekaRun {
  readonly provider: MekaProvider;
  providerSessionId = "";
  providerRunId: string | null = null;
  readonly done: Promise<MekaRunOutcome>;
  #state: MekaRunState = "running";
  #listeners = new Set<(event: MekaEvent) => void>();
  #interrupt: () => Promise<void> = async () => {};
  #cleanup: (() => void | Promise<void>) | undefined;
  #cleanupPromise: Promise<void> | undefined;
  #cleanedListeners = new Set<() => void>();
  #completion = Promise.withResolvers<MekaRunOutcome>();

  constructor(provider: MekaProvider, listener?: (event: MekaEvent) => void) {
    this.provider = provider;
    this.done = this.#completion.promise;
    if (listener) {
      this.#listeners.add(listener);
    }
  }

  get state(): MekaRunState {
    return this.#state;
  }

  onEvent(listener: (event: MekaEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  interrupt(): Promise<void> {
    return this.#interrupt();
  }

  async close(): Promise<void> {
    if (this.#state === "running") {
      this.finish({ state: "closed" });
    }
    await this.#cleanUp();
  }

  publish(event: MekaEvent): void {
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener(event);
      } catch {
        // A consumer callback must not break the provider transport.
      }
    }
  }

  setIdentity(sessionId: string, runId: string | null): void {
    this.providerSessionId = sessionId;
    this.providerRunId = runId;
  }

  setActions(options: {
    interrupt: () => Promise<void>;
    cleanup: () => void | Promise<void>;
  }): void {
    this.#interrupt = options.interrupt;
    this.#cleanup = options.cleanup;
    if (this.#state !== "running") {
      void this.#cleanUp().catch(() => {});
    }
  }

  finish(outcome: MekaRunOutcome): void {
    if (this.#state !== "running") {
      return;
    }
    this.#state = outcome.state;
    this.#completion.resolve(outcome);
    void this.#cleanUp().catch(() => {});
  }

  onCleaned(listener: () => void): void {
    this.#cleanedListeners.add(listener);
  }

  #cleanUp(): Promise<void> {
    if (this.#cleanupPromise) {
      return this.#cleanupPromise;
    }
    if (!this.#cleanup) {
      return Promise.resolve();
    }
    this.#cleanupPromise = Promise.resolve()
      .then(async () => await this.#cleanup?.())
      .finally(() => {
        for (const listener of this.#cleanedListeners) {
          listener();
        }
        this.#cleanedListeners.clear();
      });
    return this.#cleanupPromise;
  }
}

function finishCodexRun(run: ActiveRun, event: unknown): void {
  const input = recordOrUndefined(event);
  if (input?.method !== "turn/completed") {
    return;
  }
  const params = recordOrUndefined(input.params);
  const turn = recordOrUndefined(params?.turn);
  if (!turn || turn.id !== run.providerRunId) {
    return;
  }
  if (turn.status === "completed") {
    run.finish({ state: "completed" });
  } else if (turn.status === "interrupted") {
    run.finish({ state: "interrupted" });
  } else if (turn.status === "failed") {
    run.finish({ state: "failed", error: turnError(turn.error) });
  }
}

function respondToCodexRequest(client: CodexMekaClient, event: unknown): void {
  const request = recordOrUndefined(event);
  const id = request?.id;
  const method = request?.method;
  if ((typeof id !== "string" && typeof id !== "number") || typeof method !== "string") {
    throw new Error("Codex sent a malformed server request");
  }
  switch (method) {
    case "item/commandExecution/requestApproval":
      client.respond(id, { decision: "accept" });
      return;
    case "item/fileChange/requestApproval":
      client.respond(id, { decision: "accept" });
      return;
    case "applyPatchApproval":
    case "execCommandApproval":
      client.respond(id, { decision: "approved" });
      return;
    case "item/permissions/requestApproval": {
      const params = recordOrUndefined(request?.params);
      const requested = recordOrUndefined(params?.permissions);
      client.respond(id, {
        permissions: {
          ...(requested?.network ? { network: requested.network } : {}),
          ...(requested?.fileSystem ? { fileSystem: requested.fileSystem } : {}),
        },
        scope: "session",
      });
      return;
    }
    case "item/tool/requestUserInput":
      client.respond(id, { answers: {} });
      return;
    case "mcpServer/elicitation/request":
      client.respond(id, { action: "cancel", content: null, _meta: null });
      return;
    case "currentTime/read":
      client.respond(id, { currentTimeAt: Math.floor(Date.now() / 1_000) });
      return;
    default:
      client.respondError(id, -32601, `Unsupported unattended Codex request: ${method}`);
  }
}

function isCodexTurnCompleted(event: unknown): boolean {
  return recordOrUndefined(event)?.method === "turn/completed";
}

function claudeOutcome(event: unknown): MekaRunOutcome | undefined {
  const input = recordOrUndefined(event);
  if (input?.type === "session.error") {
    return { state: "failed", error: errorMessage(input.error) };
  }
  if (input?.type === "session.closed") {
    return { state: "closed" };
  }
  if (input?.type !== "message") {
    return undefined;
  }
  const message = recordOrUndefined(input.message);
  if (message?.type !== "result") {
    return undefined;
  }
  return message.subtype === "success"
    ? { state: "completed" }
    : { state: "failed", error: `Claude run ended with ${String(message.subtype ?? "an error")}` };
}

function turnError(value: unknown): string {
  const input = recordOrUndefined(value);
  return typeof input?.message === "string" ? input.message : "Codex turn failed";
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const COMMAND_TIMEOUT_MS = 5 * 60_000;

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new CappedOutput(MAX_COMMAND_OUTPUT_BYTES);
    const stderr = new CappedOutput(MAX_COMMAND_OUTPUT_BYTES);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 1_000);
      killTimer.unref();
      reject(new Error(`${command} ${args.join(" ")} timed out`));
    }, COMMAND_TIMEOUT_MS);
    timeout.unref();
    const onAbort = () => {
      killTimer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 1_000);
      killTimer.unref();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      const result = {
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}: ${result.stderr || result.stdout}`,
        ),
      );
    });
  });
}

class CappedOutput {
  #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;

  constructor(readonly limit: number) {}

  push(chunk: Buffer): void {
    const remaining = this.limit - this.#size;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    this.#chunks.push(kept);
    this.#size += kept.length;
    this.truncated ||= kept.length !== chunk.length;
  }

  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}
