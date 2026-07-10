import { randomUUID } from "node:crypto";
import { chmod, stat } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
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
const MAX_RUNS = 32;
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
  instanceId?: string;
};

type StoredEvent = {
  value: MekaRunEvent;
  bytes: number;
};

type RunRecord = {
  id: string;
  provider: MekaProvider;
  state: MekaRunSummary["state"];
  providerSessionId: string | null;
  providerRunId: string | null;
  startedAt: string;
  outcome?: MekaRunOutcome;
  run?: MekaRun;
  startup?: Promise<MekaRun>;
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
  readonly cwd: string;
  readonly startedAt = new Date().toISOString();
  #engine: MekaEngine;
  #runtimeRoot: string | undefined;
  #requestedInstanceId: string | undefined;
  #runtime: MekaRuntimeLocation | undefined;
  #server: Server | undefined;
  #clients = new Set<Client>();
  #runs = new Map<string, RunRecord>();
  #ready: MekaReadyInfo | undefined;
  #starting: Promise<MekaReadyInfo> | undefined;
  #closing: Promise<void> | undefined;
  #isClosing = false;
  #pluginQueues: Record<MekaProvider, Promise<unknown>> = {
    codex: Promise.resolve(),
    claude: Promise.resolve(),
  };

  constructor(options: MekaServerOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.#engine = options.engine ?? new Meka();
    this.#runtimeRoot = options.runtimeRoot;
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
    await Promise.allSettled([
      this.#engine.close(),
      ...[...this.#runs.values()].map(async (entry) => await entry.run?.close()),
    ]);
    await Promise.allSettled([
      ...(starting ? [starting] : []),
      ...[...this.#runs.values()].flatMap((entry) => (entry.startup ? [entry.startup] : [])),
      this.#pluginQueues.codex,
      this.#pluginQueues.claude,
    ]);
    this.#runs.clear();
    const runtime = this.#runtime;
    this.#runtime = undefined;
    if (runtime) {
      await removeRuntimeLocation(runtime);
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
        return this.#status();
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
      capabilities: ["status", "runs", "event-replay", "interrupt", "plugin-install"],
    };
  }

  #status(): MekaStatusResult {
    return {
      ...this.#initializeResult(),
      startedAt: this.startedAt,
      cwd: this.cwd,
      runs: [...this.#runs.values()].map((entry) => summary(entry)),
    };
  }

  async #startRun(params: Record<string, unknown>): Promise<MekaRunSummary> {
    if (this.#isClosing) {
      throw new MekaRpcError("Meka server is closing", -32000);
    }
    if (this.#runs.size >= MAX_RUNS) {
      throw new MekaRpcError(`Run limit reached (${MAX_RUNS}); close a retained run`, -32010);
    }
    const selectedProvider = provider(params.provider);
    const prompt = requiredString(params.prompt, "prompt");
    const model = optionalString(params.model, "model");
    const entry: RunRecord = {
      id: randomUUID(),
      provider: selectedProvider,
      state: "starting",
      providerSessionId: null,
      providerRunId: null,
      startedAt: new Date().toISOString(),
      nextSequence: 1,
      events: [],
      eventBytes: 0,
    };
    this.#runs.set(entry.id, entry);
    try {
      const startup = this.#engine.startRun({
        provider: selectedProvider,
        prompt,
        cwd: this.cwd,
        ...(model ? { model } : {}),
        onEvent: (event) => this.#publishRunEvent(entry, event),
      });
      entry.startup = startup;
      const run = await startup;
      entry.startup = undefined;
      if (this.#isClosing || this.#runs.get(entry.id) !== entry) {
        await run.close();
        throw new MekaRpcError("Run was closed while starting", -32012);
      }
      entry.run = run;
      entry.state = run.state;
      entry.providerSessionId = run.providerSessionId;
      entry.providerRunId = run.providerRunId;
      void run.done.then(
        (outcome) => this.#finishRun(entry, outcome),
        (error: unknown) =>
          this.#finishRun(entry, {
            state: "failed",
            error: errorMessage(error),
          }),
      );
      return summary(entry);
    } catch (error) {
      entry.startup = undefined;
      if (this.#runs.get(entry.id) === entry) {
        this.#runs.delete(entry.id);
      }
      throw error;
    }
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
    if (!entry.run || entry.state !== "running") {
      throw new MekaRpcError(`Run is not active: ${entry.id}`, -32011);
    }
    await entry.run.interrupt();
    return { interrupted: true, run: summary(entry) };
  }

  async #closeRun(params: Record<string, unknown>) {
    const entry = this.#requireRun(requiredString(params.runId, "runId"));
    if (entry.state === "starting") {
      throw new MekaRpcError(`Run is still starting: ${entry.id}`, -32012);
    }
    await entry.run?.close();
    if (!entry.outcome) {
      this.#finishRun(entry, { state: "closed" });
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

  #finishRun(run: RunRecord, outcome: MekaRunOutcome): void {
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

  #requireReady(): MekaReadyInfo {
    if (!this.#ready) {
      throw new MekaRpcError("Meka server is not ready", -32000);
    }
    return this.#ready;
  }
}

const RESPONSE_ALREADY_SENT = Symbol("response already sent");

function summary(run: RunRecord): MekaRunSummary {
  return {
    id: run.id,
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
