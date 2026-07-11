import { randomUUID } from "node:crypto";
import { chmod, realpath, stat } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import { Effect } from "effect";
import {
  Meka,
  type InstallPluginInput,
  type MekaEngine,
  type MekaEvent,
  type MekaProvider,
  type MekaRun,
  type MekaRunOutcome,
} from "@meka/sdk";
import {
  AutomationRuntime,
  isManagedRunJob,
  managedRunPayload,
  type ClaimedAutomationJob,
} from "./automation-runtime.ts";
import { MIN_QUEUE_LEASE_MS } from "./automation/constants.ts";
import { acquireWorkspaceDaemonLock, type WorkspaceDaemonLock } from "./daemon-lock.ts";
import {
  MEKA_PROTOCOL_VERSION,
  MekaRpcError,
  NdjsonDecoder,
  encodeMessage,
  failure,
  notification,
  optionalString,
  provider,
  record,
  requiredString,
  success,
  type JsonRpcId,
  type JsonRpcRequest,
  type MekaReadyInfo,
  type MekaRunEvent,
  type MekaRunSummary,
  type MekaStatusResult,
  type MekaSubscribeResult,
} from "./protocol.ts";
import {
  createRuntimeLocation,
  removeRuntimeLocation,
  writeRuntimeMetadata,
  type MekaRuntimeLocation,
} from "./runtime-path.ts";

const MAX_CLIENTS = 64;
const MAX_INFLIGHT_REQUESTS = 32;
const MAX_ACTIVE_RUNS = 32;
const MAX_RUN_RECORDS = 4_096;
const MAX_EVENTS_PER_RUN = 1_000;
const MAX_EVENT_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_CLIENT_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const INITIALIZE_TIMEOUT_MS = 5_000;

export type MekaServerOptions = {
  engine?: MekaEngine;
  cwd?: string;
  runtimeRoot?: string;
  stateRoot?: string;
  stateHome?: string;
  instanceId?: string;
  /** Disable global Codex/Claude hook claiming for disposable probes. */
  observeExternalAgents?: boolean;
};

type StoredEvent = {
  value: MekaRunEvent;
  bytes: number;
};

type RunRecord = {
  id: string;
  jobId: string;
  queue: string;
  provider: MekaProvider;
  state: MekaRunSummary["state"];
  providerSessionId: string | null;
  providerRunId: string | null;
  startedAt: string;
  outcome?: MekaRunOutcome;
  run?: MekaRun;
  startup?: Promise<MekaRun>;
  completion?: Promise<void>;
  leaseToken?: string;
  stopLeaseHeartbeat?: () => void;
  nextSequence: number;
  events: StoredEvent[];
  eventBytes: number;
};

type Subscription = {
  replaying: boolean;
  pending: MekaRunEvent[];
};

type Client = {
  socket: Socket;
  decoder: NdjsonDecoder;
  initialized: boolean;
  inflight: number;
  closed: boolean;
  initializeTimer: NodeJS.Timeout;
  subscriptions: Map<string, Subscription>;
};

/**
 * A private, process-local JSON-RPC edge around the Meka SDK.
 *
 * The daemon fixes the starting working directory. The external sandbox, not
 * the cwd, is the filesystem boundary; every provider run uses full permissions.
 */
export class MekaServer {
  cwd: string;
  readonly startedAt = new Date().toISOString();
  #engine: MekaEngine;
  #runtimeRoot: string | undefined;
  #stateRoot: string | undefined;
  #stateHome: string | undefined;
  #observeExternalAgents: boolean;
  #requestedInstanceId: string | undefined;
  #runtime: MekaRuntimeLocation | undefined;
  #server: Server | undefined;
  #clients = new Set<Client>();
  #runs = new Map<string, RunRecord>();
  #ready: MekaReadyInfo | undefined;
  #starting: Promise<MekaReadyInfo> | undefined;
  #closing: Promise<void> | undefined;
  #isClosing = false;
  #automation: AutomationRuntime | undefined;
  #drainTimer: NodeJS.Timeout | undefined;
  #draining: Promise<void> | undefined;
  #drainRequested = false;
  #activeJobTasks = new Set<Promise<void>>();
  #internalJobControllers = new Map<Promise<void>, AbortController>();
  #lastAutomationError: string | undefined;
  #daemonLock: WorkspaceDaemonLock | undefined;
  #pluginQueues: Record<MekaProvider, Promise<unknown>> = {
    codex: Promise.resolve(),
    claude: Promise.resolve(),
  };

  constructor(options: MekaServerOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.#engine = options.engine ?? new Meka();
    this.#runtimeRoot = options.runtimeRoot;
    this.#stateRoot = options.stateRoot;
    this.#stateHome = options.stateHome;
    this.#observeExternalAgents = options.observeExternalAgents ?? true;
    this.#requestedInstanceId = options.instanceId;
  }

  get ready(): MekaReadyInfo | undefined {
    return this.#ready;
  }

  start(): Promise<MekaReadyInfo> {
    if (this.#isClosing) {
      return Promise.reject(new Error("Meka server is closing"));
    }
    if (this.#ready) {
      return Promise.resolve(this.#ready);
    }
    if (this.#starting) {
      return this.#starting;
    }
    const pending = this.#start();
    const starting = pending.then(
      (ready) => {
        if (this.#starting === starting) {
          this.#starting = undefined;
        }
        return ready;
      },
      (error: unknown) => {
        if (this.#starting === starting) {
          this.#starting = undefined;
        }
        throw error;
      },
    );
    this.#starting = starting;
    return starting;
  }

  async #start(): Promise<MekaReadyInfo> {
    const cwd = await stat(this.cwd);
    if (!cwd.isDirectory()) {
      throw new Error(`Meka working directory is not a directory: ${this.cwd}`);
    }
    this.#assertStarting();
    const automation = await AutomationRuntime.open({
      cwd: this.cwd,
      ...(this.#stateRoot ? { stateRoot: this.#stateRoot } : {}),
      ...(this.#stateHome ? { stateHome: this.#stateHome } : {}),
    });
    this.cwd = automation.cwd;
    this.#automation = automation;
    let daemonLock: WorkspaceDaemonLock | undefined;
    try {
      daemonLock = await acquireWorkspaceDaemonLock(automation.store.location.root, this.cwd);
      this.#daemonLock = daemonLock;
      if (this.#observeExternalAgents) {
        await automation.activateHookIngressConsumer();
      }
      await Effect.runPromise(automation.store.recoverExpiredLeases());
      await Effect.runPromise(automation.store.recoverExpiredExternalAgentSessions());
      if (this.#observeExternalAgents) {
        await automation.drainHookSpool();
      }
      this.#assertStarting();
      const runtime = await createRuntimeLocation({
        ...(this.#runtimeRoot ? { runtimeRoot: this.#runtimeRoot } : {}),
        ...(this.#requestedInstanceId ? { instanceId: this.#requestedInstanceId } : {}),
      });
      if (this.#isClosing) {
        await removeRuntimeLocation(runtime);
        throw new Error("Meka server is closing");
      }
      const server = net.createServer((socket) => this.#accept(socket));
      this.#runtime = runtime;
      this.#server = server;
      try {
        await listen(server, runtime.socketPath);
        this.#assertStarting();
        await chmod(runtime.socketPath, 0o600);
        this.#assertStarting();
        const ready: MekaReadyInfo = {
          socketPath: runtime.socketPath,
          instanceId: runtime.instanceId,
          pid: process.pid,
          protocolVersion: MEKA_PROTOCOL_VERSION,
        };
        await writeRuntimeMetadata(runtime, {
          ...ready,
          cwd: this.cwd,
          startedAt: this.startedAt,
        });
        this.#assertStarting();
        this.#ready = ready;
        this.#drainTimer = setInterval(() => this.#kickDrain(), 500);
        this.#drainTimer.unref();
        this.#kickDrain();
        return ready;
      } catch (error) {
        await closeServer(server);
        if (this.#server === server) {
          this.#server = undefined;
        }
        if (this.#runtime === runtime) {
          this.#runtime = undefined;
        }
        await removeRuntimeLocation(runtime);
        throw error;
      }
    } catch (error) {
      if (daemonLock && this.#daemonLock === daemonLock) {
        this.#daemonLock = undefined;
        await daemonLock.release();
      }
      if (this.#automation === automation) {
        this.#automation = undefined;
        await automation.close();
      }
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closing) {
      return this.#closing;
    }
    this.#isClosing = true;
    this.#closing = this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    if (this.#drainTimer) {
      clearInterval(this.#drainTimer);
      this.#drainTimer = undefined;
    }
    const starting = this.#starting;
    const server = this.#server;
    this.#server = undefined;
    this.#ready = undefined;
    for (const client of Array.from(this.#clients)) {
      client.socket.destroy();
    }
    if (server) {
      await closeServer(server);
    }
    for (const controller of this.#internalJobControllers.values()) {
      controller.abort(new Error("Meka server is closing"));
    }
    await Promise.allSettled([
      this.#engine.close(),
      ...[...this.#runs.values()].map(async (entry) => await entry.run?.close()),
    ]);
    await Promise.allSettled([
      ...(starting ? [starting] : []),
      ...[...this.#runs.values()].flatMap((entry) => (entry.startup ? [entry.startup] : [])),
      this.#pluginQueues.codex,
      this.#pluginQueues.claude,
      ...(this.#draining ? [this.#draining] : []),
      ...this.#activeJobTasks,
      ...[...this.#runs.values()].flatMap((entry) => (entry.completion ? [entry.completion] : [])),
    ]);
    for (const entry of this.#runs.values()) {
      entry.stopLeaseHeartbeat?.();
    }
    this.#runs.clear();
    const cleanupErrors: unknown[] = [];
    const automation = this.#automation;
    this.#automation = undefined;
    if (automation) {
      try {
        await automation.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const daemonLock = this.#daemonLock;
    this.#daemonLock = undefined;
    try {
      await daemonLock?.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
    const runtime = this.#runtime;
    this.#runtime = undefined;
    if (runtime) {
      try {
        await removeRuntimeLocation(runtime);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Meka server cleanup did not complete cleanly");
    }
  }

  #assertStarting(): void {
    if (this.#isClosing) {
      throw new Error("Meka server is closing");
    }
  }

  #accept(socket: Socket): void {
    if (!this.#ready || this.#clients.size >= MAX_CLIENTS) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    const client = {} as Client;
    client.socket = socket;
    client.decoder = new NdjsonDecoder();
    client.initialized = false;
    client.inflight = 0;
    client.closed = false;
    client.subscriptions = new Map();
    client.initializeTimer = setTimeout(() => {
      this.#send(client, failure(null, -32001, "meka.initialize was not received in time"));
      socket.destroy();
    }, INITIALIZE_TIMEOUT_MS);
    client.initializeTimer.unref();
    this.#clients.add(client);

    socket.on("data", (chunk: Buffer) => {
      try {
        for (const frame of client.decoder.push(chunk)) {
          this.#receive(client, frame);
        }
      } catch (error) {
        const rpc = asRpcError(error);
        this.#send(client, failure(null, rpc.code, rpc.message, rpc.data));
        socket.destroy();
      }
    });
    const remove = () => this.#removeClient(client);
    socket.once("close", remove);
    socket.once("error", remove);
  }

  #removeClient(client: Client): void {
    if (client.closed) {
      return;
    }
    client.closed = true;
    clearTimeout(client.initializeTimer);
    client.subscriptions.clear();
    this.#clients.delete(client);
  }

  #receive(client: Client, value: unknown): void {
    let request: JsonRpcRequest;
    try {
      const input = record(value, "JSON-RPC request");
      if (
        input.jsonrpc !== "2.0" ||
        !(typeof input.id === "string" || typeof input.id === "number")
      ) {
        throw new MekaRpcError("A JSON-RPC 2.0 request id is required", -32600);
      }
      if (typeof input.method !== "string") {
        throw new MekaRpcError("JSON-RPC method must be a string", -32600);
      }
      request = input as JsonRpcRequest;
    } catch (error) {
      const rpc = asRpcError(error);
      this.#send(client, failure(null, rpc.code, rpc.message, rpc.data));
      return;
    }
    if (client.inflight >= MAX_INFLIGHT_REQUESTS) {
      this.#send(client, failure(request.id, -32002, "Too many in-flight requests"));
      return;
    }
    client.inflight += 1;
    void this.#dispatch(client, request)
      .then(
        (result) => {
          if (result !== RESPONSE_ALREADY_SENT) {
            this.#send(client, success(request.id, result));
          }
        },
        (error: unknown) => {
          const rpc = asRpcError(error);
          this.#send(client, failure(request.id, rpc.code, rpc.message, rpc.data));
        },
      )
      .finally(() => {
        client.inflight -= 1;
      });
  }

  async #dispatch(client: Client, request: JsonRpcRequest): Promise<unknown> {
    if (!client.initialized) {
      if (request.method !== "meka.initialize") {
        throw new MekaRpcError("meka.initialize must be the first request", -32001);
      }
      const params = record(request.params ?? {}, "params");
      if (params.protocolVersion !== MEKA_PROTOCOL_VERSION) {
        throw new MekaRpcError(
          `Unsupported Meka protocol version: ${String(params.protocolVersion)}`,
          -32003,
          { supported: MEKA_PROTOCOL_VERSION },
        );
      }
      client.initialized = true;
      clearTimeout(client.initializeTimer);
      return this.#initializeResult();
    }
    if (request.method === "meka.initialize") {
      throw new MekaRpcError("Client is already initialized", -32600);
    }
    if (this.#isClosing) {
      throw new MekaRpcError("Meka server is closing", -32000);
    }

    switch (request.method) {
      case "meka.status":
        return await this.#status();
      case "run.start":
        return await this.#startRun(record(request.params ?? {}, "params"));
      case "run.subscribe":
        return this.#subscribe(client, record(request.params ?? {}, "params"), request.id);
      case "run.unsubscribe":
        return this.#unsubscribe(client, record(request.params ?? {}, "params"));
      case "run.interrupt":
        return await this.#interrupt(record(request.params ?? {}, "params"));
      case "run.close":
        return await this.#closeRun(record(request.params ?? {}, "params"));
      case "plugin.install":
        return await this.#installPlugin(record(request.params ?? {}, "params"));
      default:
        throw new MekaRpcError(`Method not found: ${request.method}`, -32601);
    }
  }

  #initializeResult() {
    const ready = this.#requireReady();
    return {
      ...ready,
      capabilities: [
        "status",
        "durable-queues",
        "runs",
        "event-replay",
        "interrupt",
        "plugin-install",
        "effect-workflows",
        "source-ingress",
        "external-agent-observation",
      ],
    };
  }

  async #status(): Promise<MekaStatusResult> {
    const automation = this.#requireAutomation();
    const [info, queues, jobCounts, activeExternalSessions] = await Promise.all([
      Effect.runPromise(automation.store.info()),
      Effect.runPromise(automation.store.listQueueUsage()),
      Effect.runPromise(automation.store.countJobsByStatus()),
      Effect.runPromise(automation.store.countExternalAgentSessions({ states: ["active"] })),
    ]);
    return {
      ...this.#initializeResult(),
      startedAt: this.startedAt,
      cwd: this.cwd,
      runs: [...this.#runs.values()].map((entry) => summary(entry)),
      automation: {
        stateRoot: info.location.root,
        schemaVersion: info.schemaVersion,
        queues,
        jobs: jobCounts,
        activeExternalSessions,
        ...(this.#lastAutomationError ? { lastError: this.#lastAutomationError } : {}),
      },
    };
  }

  async #startRun(params: Record<string, unknown>): Promise<MekaRunSummary> {
    if (this.#isClosing) {
      throw new MekaRpcError("Meka server is closing", -32000);
    }
    if (!this.#makeRunRoom()) {
      throw new MekaRpcError(
        `Run record limit reached (${MAX_RUN_RECORDS}); close retained runs`,
        -32010,
      );
    }
    const selectedProvider = provider(params.provider);
    const prompt = requiredString(params.prompt, "prompt");
    const model = optionalString(params.model, "model");
    const queue = optionalString(params.queue, "queue") ?? "default";
    const automation = this.#requireAutomation();
    const id = randomUUID();
    const job = await automation.enqueueRun(
      {
        queue,
        intent: {
          _tag: "meka.run",
          provider: selectedProvider,
          prompt,
          ...(model ? { model } : {}),
        },
      },
      id,
    );
    const entry: RunRecord = {
      id,
      jobId: job.id,
      queue,
      provider: selectedProvider,
      state: "queued",
      providerSessionId: null,
      providerRunId: null,
      startedAt: new Date().toISOString(),
      nextSequence: 1,
      events: [],
      eventBytes: 0,
    };
    this.#runs.set(entry.id, entry);
    this.#kickDrain();
    return summary(entry);
  }

  #subscribe(
    client: Client,
    params: Record<string, unknown>,
    requestId: JsonRpcId,
  ): MekaSubscribeResult | typeof RESPONSE_ALREADY_SENT {
    const run = this.#requireRun(requiredString(params.runId, "runId"));
    const afterSequence = optionalSequence(params.afterSequence);
    const events = run.events.filter((entry) => entry.value.sequence > afterSequence);
    const oldestAvailable = run.events[0]?.value.sequence ?? run.nextSequence;
    const latestAvailable = run.nextSequence - 1;
    const result: MekaSubscribeResult = {
      run: summary(run),
      replay: {
        requestedAfter: afterSequence,
        oldestAvailable,
        latestAvailable,
        gap: afterSequence + 1 < oldestAvailable,
      },
    };
    const subscription: Subscription = { replaying: true, pending: [] };
    client.subscriptions.set(run.id, subscription);

    // The subscribe response must precede replay notifications, so this method
    // writes it directly and signals #receive to skip its normal response.
    this.#send(client, success(requestId, result));
    for (const entry of events) {
      this.#sendRunEvent(client, entry.value);
    }
    subscription.replaying = false;
    for (const event of subscription.pending) {
      if (event.sequence > latestAvailable) {
        this.#sendRunEvent(client, event);
      }
    }
    subscription.pending.length = 0;
    this.#send(client, notification("run.state", { run: summary(run) }));
    return RESPONSE_ALREADY_SENT;
  }

  #unsubscribe(client: Client, params: Record<string, unknown>) {
    const runId = requiredString(params.runId, "runId");
    return { unsubscribed: client.subscriptions.delete(runId) };
  }

  async #interrupt(params: Record<string, unknown>) {
    const entry = this.#requireRun(requiredString(params.runId, "runId"));
    if (entry.state === "queued") {
      await Effect.runPromise(
        this.#requireAutomation().store.cancelJob({
          jobId: entry.jobId,
          reason: "Interrupted before provider dispatch",
        }),
      );
      await this.#finishRun(entry, { state: "interrupted" }, false);
      return { interrupted: true, run: summary(entry) };
    }
    if (!entry.run || entry.state !== "running") {
      throw new MekaRpcError(`Run is not active: ${entry.id}`, -32011);
    }
    await entry.run.interrupt();
    return { interrupted: true, run: summary(entry) };
  }

  async #closeRun(params: Record<string, unknown>) {
    const entry = this.#requireRun(requiredString(params.runId, "runId"));
    if (entry.state === "queued") {
      await Effect.runPromise(
        this.#requireAutomation().store.cancelJob({
          jobId: entry.jobId,
          reason: "Closed before provider dispatch",
        }),
      );
      await this.#finishRun(entry, { state: "closed" }, false);
    }
    if (entry.state === "starting") {
      throw new MekaRpcError(`Run is still starting: ${entry.id}`, -32012);
    }
    await entry.run?.close();
    if (!entry.outcome) {
      await this.#finishRun(entry, { state: "closed" });
    }
    this.#runs.delete(entry.id);
    for (const client of this.#clients) {
      client.subscriptions.delete(entry.id);
    }
    return { closed: true, run: summary(entry) };
  }

  async #installPlugin(params: Record<string, unknown>) {
    if (this.#isClosing) {
      throw new MekaRpcError("Meka server is closing", -32000);
    }
    const selectedProvider = provider(params.provider);
    const plugin = requiredString(params.plugin, "plugin");
    let input: InstallPluginInput;
    if (selectedProvider === "codex") {
      input = {
        provider: "codex",
        plugin,
        ...(optionalString(params.marketplacePath, "marketplacePath")
          ? { marketplacePath: String(params.marketplacePath) }
          : {}),
        ...(optionalString(params.remoteMarketplaceName, "remoteMarketplaceName")
          ? { remoteMarketplaceName: String(params.remoteMarketplaceName) }
          : {}),
      };
    } else {
      const scope = params.scope ?? "user";
      if (scope !== "user" && scope !== "project" && scope !== "local") {
        throw new MekaRpcError("scope must be user, project, or local", -32602);
      }
      input = { provider: "claude", plugin, scope, cwd: this.cwd };
    }
    const prior = this.#pluginQueues[selectedProvider];
    const task = prior.then(async () => {
      if (this.#isClosing) {
        throw new MekaRpcError("Meka server is closing", -32000);
      }
      return await this.#engine.installPlugin(input);
    });
    this.#pluginQueues[selectedProvider] = task.catch(() => undefined);
    return await task;
  }

  #kickDrain(): void {
    if (this.#isClosing) return;
    if (this.#draining) {
      this.#drainRequested = true;
      return;
    }
    this.#drainRequested = false;
    const task = this.#drainAutomation()
      .catch((error: unknown) => {
        this.#lastAutomationError = errorMessage(error);
      })
      .finally(() => {
        if (this.#draining === task) this.#draining = undefined;
        if (this.#drainRequested && !this.#isClosing) this.#kickDrain();
      });
    this.#draining = task;
  }

  async #drainAutomation(): Promise<void> {
    const automation = this.#requireAutomation();
    if (this.#observeExternalAgents) {
      await automation.drainHookSpool();
    }
    // Recovery must run even when no queue currently has a pending row. A
    // crashed external worker can otherwise leave the last job in a queue
    // looking active until another job happens to arrive or the daemon restarts.
    await Effect.runPromise(automation.store.recoverExpiredLeases());
    await Effect.runPromise(automation.store.recoverExpiredExternalAgentSessions());
    const pendingQueues = await Effect.runPromise(automation.store.listPendingQueueNames());
    for (const queueName of pendingQueues) {
      while (!this.#isClosing) {
        const job = await automation.claim(queueName, {
          allowManagedRuns: this.#activeRunCount() < MAX_ACTIVE_RUNS,
        });
        if (!job) break;
        if (isManagedRunJob(job)) {
          this.#startManagedRunJob(job);
        } else {
          this.#startInternalJob(job);
        }
      }
    }
  }

  #startManagedRunJob(job: ClaimedAutomationJob): void {
    const task = this.#startClaimedRun(job)
      .catch(async (error: unknown) => {
        this.#lastAutomationError = errorMessage(error);
        try {
          await Effect.runPromise(
            this.#requireAutomation().store.failJob({
              jobId: job.claim.job.id,
              leaseToken: job.claim.leaseToken,
              error: { message: errorMessage(error) },
            }),
          );
        } catch {
          // The start path may already have settled the durable attempt.
        }
      })
      .finally(() => {
        this.#activeJobTasks.delete(task);
        this.#kickDrain();
      });
    this.#activeJobTasks.add(task);
  }

  #startInternalJob(job: ClaimedAutomationJob): void {
    const stopHeartbeat = this.#startLeaseHeartbeat(job);
    const controller = new AbortController();
    const task = this.#requireAutomation()
      .executeInternalJob(job, { signal: controller.signal })
      .then(
        () => undefined,
        async (error: unknown) => {
          try {
            const store = this.#requireAutomation().store;
            const detail = await Effect.runPromise(store.getJobDetail(job.claim.job.id));
            if (detail && detail.externalDispatchStartedAt !== null) {
              await Effect.runPromise(
                store.markJobUncertain({
                  jobId: job.claim.job.id,
                  leaseToken: job.claim.leaseToken,
                  reason: {
                    message: errorMessage(error),
                    type: controller.signal.aborted
                      ? "daemon.shutdown"
                      : "execution.exception_after_external_dispatch",
                  },
                }),
              );
            } else if (!controller.signal.aborted) {
              await Effect.runPromise(
                store.failJob({
                  jobId: job.claim.job.id,
                  leaseToken: job.claim.leaseToken,
                  error: { message: errorMessage(error) },
                }),
              );
            }
          } catch (settleError) {
            this.#lastAutomationError = errorMessage(settleError);
          }
        },
      )
      .finally(() => {
        stopHeartbeat();
        this.#activeJobTasks.delete(task);
        this.#internalJobControllers.delete(task);
        this.#kickDrain();
      });
    this.#activeJobTasks.add(task);
    this.#internalJobControllers.set(task, controller);
  }

  async #startClaimedRun(job: ClaimedAutomationJob): Promise<void> {
    const automation = this.#requireAutomation();
    let payload: ReturnType<typeof managedRunPayload>;
    try {
      payload = managedRunPayload(job);
      if (payload.cwd && (await realpath(path.resolve(payload.cwd))) !== this.cwd) {
        throw new Error(`Managed run cwd must match the daemon workspace: ${this.cwd}`);
      }
    } catch (error) {
      await Effect.runPromise(
        automation.store.failJob({
          jobId: job.claim.job.id,
          leaseToken: job.claim.leaseToken,
          error: { message: errorMessage(error) },
        }),
      );
      return;
    }

    let entry = this.#runs.get(payload.runId);
    if (!entry) {
      if (!this.#makeRunRoom(true)) {
        throw new Error(`Run record capacity is unavailable (${MAX_RUN_RECORDS})`);
      }
      entry = {
        id: payload.runId,
        jobId: job.claim.job.id,
        queue: job.claim.job.queueName,
        provider: payload.provider,
        state: "queued",
        providerSessionId: null,
        providerRunId: null,
        startedAt: job.claim.job.createdAt,
        nextSequence: 1,
        events: [],
        eventBytes: 0,
      };
      this.#runs.set(entry.id, entry);
    } else if (entry.outcome) {
      entry.stopLeaseHeartbeat?.();
      entry.state = "queued";
      entry.providerSessionId = null;
      entry.providerRunId = null;
      entry.startedAt = new Date().toISOString();
      entry.run = undefined;
      entry.startup = undefined;
      entry.completion = undefined;
      entry.leaseToken = undefined;
      entry.stopLeaseHeartbeat = undefined;
      delete entry.outcome;
    }
    entry.leaseToken = job.claim.leaseToken;
    entry.stopLeaseHeartbeat = this.#startLeaseHeartbeat(job);
    entry.state = "starting";
    this.#publishRunState(entry);

    let dispatched = false;
    try {
      await Effect.runPromise(
        automation.store.markExternalDispatch({
          jobId: entry.jobId,
          leaseToken: job.claim.leaseToken,
          provider: payload.provider,
        }),
      );
      dispatched = true;
      const startup = this.#engine.startRun({
        provider: payload.provider,
        prompt: payload.prompt,
        cwd: this.cwd,
        ...(payload.model ? { model: payload.model } : {}),
        onEvent: (event) => this.#publishRunEvent(entry as RunRecord, event),
      });
      entry.startup = startup;
      const run = await startup;
      entry.startup = undefined;
      if (this.#isClosing || this.#runs.get(entry.id) !== entry) {
        await run.close();
        throw new Error("Run was closed while starting");
      }
      entry.run = run;
      entry.state = run.state;
      entry.providerSessionId = run.providerSessionId;
      entry.providerRunId = run.providerRunId;
      await Effect.runPromise(
        automation.store.markProviderAccepted({
          jobId: entry.jobId,
          leaseToken: job.claim.leaseToken,
          provider: payload.provider,
          providerReference: run.providerRunId ?? run.providerSessionId ?? undefined,
        }),
      );
      this.#publishRunState(entry);
      const completion = run.done
        .then(
          async (outcome) => await this.#finishRun(entry as RunRecord, outcome),
          async (error: unknown) =>
            await this.#finishRun(entry as RunRecord, {
              state: "failed",
              error: errorMessage(error),
            }),
        )
        .catch((error: unknown) => {
          this.#lastAutomationError = errorMessage(error);
        });
      entry.completion = completion;
    } catch (error) {
      entry.startup = undefined;
      this.#lastAutomationError = errorMessage(error);
      if (dispatched) {
        try {
          await Effect.runPromise(
            automation.store.markJobUncertain({
              jobId: entry.jobId,
              leaseToken: job.claim.leaseToken,
              reason: { message: errorMessage(error) },
            }),
          );
        } catch (settleError) {
          this.#lastAutomationError = errorMessage(settleError);
        }
        if (entry.run) {
          const liveRun = entry.run;
          const completion = liveRun.done
            .then(
              async (outcome) => await this.#finishRun(entry, outcome, false),
              async (runError: unknown) =>
                await this.#finishRun(
                  entry,
                  { state: "failed", error: errorMessage(runError) },
                  false,
                ),
            )
            .catch((completionError: unknown) => {
              this.#lastAutomationError = errorMessage(completionError);
            });
          entry.completion = completion;
          try {
            await liveRun.close();
          } catch (closeError) {
            entry.state = liveRun.state;
            this.#lastAutomationError = `Provider acceptance persistence failed and the live run could not be closed: ${errorMessage(closeError)}`;
            this.#publishRunState(entry);
          }
        } else {
          await this.#finishRun(
            entry,
            { state: "failed", error: `Provider acceptance is uncertain: ${errorMessage(error)}` },
            false,
          );
        }
      } else {
        await Effect.runPromise(
          automation.store.failJob({
            jobId: entry.jobId,
            leaseToken: job.claim.leaseToken,
            error: { message: errorMessage(error) },
          }),
        );
        await this.#finishRun(entry, { state: "failed", error: errorMessage(error) }, false);
      }
    }
  }

  #startLeaseHeartbeat(job: ClaimedAutomationJob): () => void {
    const claimedAt = Date.parse(job.claim.attempt.leasedAt);
    const expiresAt = Date.parse(job.claim.leaseExpiresAt);
    const claimedDuration = expiresAt - claimedAt;
    const leaseMs =
      Number.isFinite(claimedDuration) && claimedDuration >= MIN_QUEUE_LEASE_MS
        ? claimedDuration
        : MIN_QUEUE_LEASE_MS;
    const intervalMs = Math.max(500, Math.min(30_000, Math.floor(leaseMs / 2)));
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const schedule = (delayMs: number) => {
      if (stopped || this.#isClosing) return;
      timer = setTimeout(() => void renew(), delayMs);
      timer.unref();
    };
    const renew = async () => {
      const automation = this.#automation;
      if (!automation || stopped || this.#isClosing) return;
      try {
        await Effect.runPromise(
          automation.store.renewJobLease({
            jobId: job.claim.job.id,
            leaseToken: job.claim.leaseToken,
            // Preserve the duration granted to this attempt. Reconfiguring a
            // queue cannot shorten an in-flight lease beneath its heartbeat
            // cadence and cause a false expiration.
            leaseMs,
          }),
        );
        schedule(intervalMs);
      } catch (error) {
        this.#lastAutomationError = errorMessage(error);
        schedule(Math.min(1_000, intervalMs));
      }
    };
    schedule(intervalMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  #publishRunEvent(run: RunRecord, event: MekaEvent): void {
    if (this.#runs.get(run.id) !== run) {
      return;
    }
    const sequence = run.nextSequence++;
    const value = safeRunEvent({
      runId: run.id,
      sequence,
      at: new Date().toISOString(),
      provider: run.provider,
      event: event.event,
    });
    const bytes = encodeMessage(
      notification("run.event", value as unknown as Record<string, unknown>),
    ).length;
    run.events.push({ value, bytes });
    run.eventBytes += bytes;
    while (run.events.length > MAX_EVENTS_PER_RUN || run.eventBytes > MAX_EVENT_HISTORY_BYTES) {
      const removed = run.events.shift();
      if (removed) {
        run.eventBytes -= removed.bytes;
      }
    }
    for (const client of this.#clients) {
      const subscription = client.subscriptions.get(run.id);
      if (!subscription) {
        continue;
      }
      if (subscription.replaying) {
        subscription.pending.push(value);
      } else {
        this.#sendRunEvent(client, value);
      }
    }
  }

  async #finishRun(run: RunRecord, outcome: MekaRunOutcome, persist = true): Promise<void> {
    if (this.#runs.get(run.id) !== run || run.outcome) {
      return;
    }
    const boundedOutcome = outcome.error
      ? { ...outcome, error: boundedText(outcome.error, MAX_ERROR_BYTES) }
      : outcome;
    run.outcome = boundedOutcome;
    run.state = boundedOutcome.state;
    if (run.run) {
      run.providerSessionId = run.run.providerSessionId;
      run.providerRunId = run.run.providerRunId;
    }
    run.stopLeaseHeartbeat?.();
    run.stopLeaseHeartbeat = undefined;
    this.#publishRunState(run);
    if (persist && run.leaseToken && this.#automation) {
      const lease = { jobId: run.jobId, leaseToken: run.leaseToken };
      if (boundedOutcome.state === "completed") {
        await Effect.runPromise(
          this.#automation.store.succeedJob({ ...lease, result: boundedOutcome }),
        );
      } else if (boundedOutcome.state === "interrupted" || boundedOutcome.state === "closed") {
        await Effect.runPromise(
          this.#automation.store.cancelJob({
            ...lease,
            reason: { state: boundedOutcome.state, error: boundedOutcome.error },
          }),
        );
      } else {
        await Effect.runPromise(
          this.#automation.store.failJob({ ...lease, error: boundedOutcome }),
        );
      }
    }
    this.#kickDrain();
  }

  #publishRunState(run: RunRecord): void {
    for (const client of this.#clients) {
      if (client.subscriptions.has(run.id)) {
        this.#send(client, notification("run.state", { run: summary(run) }));
      }
    }
  }

  #sendRunEvent(client: Client, event: MekaRunEvent): void {
    this.#send(client, notification("run.event", event as unknown as Record<string, unknown>));
  }

  #send(client: Client, message: unknown): void {
    if (client.closed || client.socket.destroyed || !client.socket.writable) {
      return;
    }
    try {
      const output = encodeMessage(message);
      if (client.socket.writableLength + output.length > MAX_CLIENT_BUFFER_BYTES) {
        client.socket.destroy(new Error("Meka client is too slow"));
        return;
      }
      client.socket.write(output);
    } catch {
      client.socket.destroy();
    }
  }

  #requireRun(runId: string): RunRecord {
    const run = this.#runs.get(runId);
    if (!run) {
      throw new MekaRpcError(`Run not found: ${runId}`, -32004);
    }
    return run;
  }

  #makeRunRoom(evictQueued = false): boolean {
    if (this.#runs.size < MAX_RUN_RECORDS) return true;
    const terminal = [...this.#runs.values()]
      .filter((run) => run.outcome !== undefined)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const candidates = evictQueued
      ? [
          ...terminal,
          ...[...this.#runs.values()]
            .filter((run) => run.state === "queued" && run.outcome === undefined)
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
        ]
      : terminal;
    for (const run of candidates) {
      this.#runs.delete(run.id);
      for (const client of this.#clients) client.subscriptions.delete(run.id);
      if (this.#runs.size < MAX_RUN_RECORDS) return true;
    }
    return false;
  }

  #activeRunCount(): number {
    return [...this.#runs.values()].filter(
      (run) => run.outcome === undefined && run.state !== "queued",
    ).length;
  }

  #requireReady(): MekaReadyInfo {
    if (!this.#ready) {
      throw new MekaRpcError("Meka server is not ready", -32000);
    }
    return this.#ready;
  }

  #requireAutomation(): AutomationRuntime {
    if (!this.#automation) {
      throw new MekaRpcError("Meka automation state is not ready", -32000);
    }
    return this.#automation;
  }
}

const RESPONSE_ALREADY_SENT = Symbol("response already sent");

function summary(run: RunRecord): MekaRunSummary {
  return {
    id: run.id,
    jobId: run.jobId,
    queue: run.queue,
    provider: run.provider,
    state: run.state,
    providerSessionId: run.providerSessionId,
    providerRunId: run.providerRunId,
    startedAt: run.startedAt,
    ...(run.outcome ? { outcome: run.outcome } : {}),
  };
}

function safeRunEvent(event: MekaRunEvent): MekaRunEvent {
  let encoded: Buffer | undefined;
  let oversizedBytes: number | undefined;
  try {
    encoded = encodeMessage(notification("run.event", event as unknown as Record<string, unknown>));
  } catch (error) {
    if (!(error instanceof MekaRpcError) || !error.message.includes("exceeds maximum size")) {
      throw error;
    }
    const details =
      error.data && typeof error.data === "object"
        ? (error.data as Record<string, unknown>)
        : undefined;
    oversizedBytes = typeof details?.bytes === "number" ? details.bytes : MAX_EVENT_BYTES + 1;
  }
  if (!encoded || encoded.length > MAX_EVENT_BYTES) {
    encoded = encodeMessage(
      notification("run.event", {
        ...event,
        event: {
          type: "meka.event_omitted",
          reason: "oversized",
          bytes: encoded?.length ?? oversizedBytes,
        },
      } as unknown as Record<string, unknown>),
    );
  }
  const parsed = JSON.parse(encoded.toString("utf8")) as { params: MekaRunEvent };
  return parsed.params;
}

function optionalSequence(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new MekaRpcError("afterSequence must be a non-negative integer", -32602);
  }
  return Number(value);
}

function asRpcError(error: unknown): MekaRpcError {
  return error instanceof MekaRpcError
    ? new MekaRpcError(boundedText(error.message, MAX_ERROR_BYTES), error.code, error.data)
    : new MekaRpcError(errorMessage(error), -32000);
}

function errorMessage(error: unknown): string {
  return boundedText(error instanceof Error ? error.message : String(error), MAX_ERROR_BYTES);
}

function boundedText(value: string, maxBytes: number): string {
  const input = Buffer.from(value, "utf8");
  if (input.length <= maxBytes) {
    return value;
  }
  const suffix = Buffer.from("\n[Meka truncated this error]", "utf8");
  return Buffer.concat([input.subarray(0, maxBytes - suffix.length), suffix]).toString("utf8");
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
