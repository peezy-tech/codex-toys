import net, { type Socket } from "node:net";
import type { MekaProvider, PluginInstallResult } from "@meka/sdk";
import {
  MEKA_PROTOCOL_VERSION,
  MekaRpcError,
  NdjsonDecoder,
  encodeMessage,
  record,
  type JsonRpcId,
  type JsonRpcNotification,
  type MekaInitializeResult,
  type MekaRunSummary,
  type MekaStatusResult,
  type MekaSubscribeResult,
} from "./protocol.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export type MekaClientOptions = {
  socketPath: string;
  requestTimeoutMs?: number;
};

export type MekaRequestOptions = {
  timeoutMs?: number;
};

export type MekaClientPluginInput =
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
    };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
};

/** JSON-RPC client for one Meka private socket. */
export class MekaClient {
  readonly socketPath: string;
  readonly requestTimeoutMs: number;
  initializeResult: MekaInitializeResult | undefined;
  #socket: Socket | undefined;
  #decoder = new NdjsonDecoder();
  #pending = new Map<JsonRpcId, PendingRequest>();
  #listeners = new Set<(notification: JsonRpcNotification) => void>();
  #closeListeners = new Set<(error: Error) => void>();
  #nextId = 1;
  #connecting: Promise<MekaInitializeResult> | undefined;

  constructor(options: MekaClientOptions) {
    this.socketPath = options.socketPath;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  connect(): Promise<MekaInitializeResult> {
    if (this.initializeResult && this.#socket && !this.#socket.destroyed) {
      return Promise.resolve(this.initializeResult);
    }
    if (this.#connecting) {
      return this.#connecting;
    }
    this.#connecting = this.#connect().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: MekaRequestOptions = {},
  ): Promise<T> {
    const socket = this.#socket;
    if (!socket || socket.destroyed || !socket.writable) {
      throw new Error("Meka client is not connected");
    }
    const id = this.#nextId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const completion = Promise.withResolvers<unknown>();
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (this.#pending.delete(id)) {
              completion.reject(new Error(`Meka request timed out: ${method}`));
            }
          }, timeoutMs)
        : undefined;
    timer?.unref();
    this.#pending.set(id, {
      resolve: completion.resolve,
      reject: completion.reject,
      timer,
    });
    try {
      socket.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    } catch (error) {
      this.#settle(id, false, error);
    }
    return (await completion.promise) as T;
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  status(): Promise<MekaStatusResult> {
    return this.request("meka.status");
  }

  startRun(input: {
    provider: MekaProvider;
    prompt: string;
    model?: string;
  }): Promise<MekaRunSummary> {
    return this.request("run.start", input);
  }

  subscribe(runId: string, afterSequence = 0): Promise<MekaSubscribeResult> {
    return this.request("run.subscribe", { runId, afterSequence });
  }

  unsubscribe(runId: string): Promise<{ unsubscribed: boolean }> {
    return this.request("run.unsubscribe", { runId });
  }

  interrupt(runId: string): Promise<{ interrupted: boolean; run: MekaRunSummary }> {
    return this.request("run.interrupt", { runId });
  }

  closeRun(runId: string): Promise<{ closed: boolean; run: MekaRunSummary }> {
    return this.request("run.close", { runId });
  }

  installPlugin(input: MekaClientPluginInput): Promise<PluginInstallResult> {
    const { provider, plugin, ...options } = input;
    return this.request("plugin.install", { provider, plugin, ...options }, { timeoutMs: 0 });
  }

  close(): void {
    this.initializeResult = undefined;
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#rejectAll(new Error("Meka client closed"));
  }

  async #connect(): Promise<MekaInitializeResult> {
    this.close();
    this.#decoder = new NdjsonDecoder();
    const socket = net.createConnection(this.socketPath);
    let socketError: Error | undefined;
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      if (this.#socket === socket) {
        this.#receive(chunk);
      }
    });
    socket.on("error", (error) => {
      socketError = error;
      if (this.#socket === socket) {
        this.#rejectAll(error);
      }
    });
    socket.once("close", () => {
      if (this.#socket !== socket) {
        return;
      }
      this.#socket = undefined;
      this.initializeResult = undefined;
      const error = socketError ?? new Error("Meka socket closed");
      this.#rejectAll(error);
      for (const listener of Array.from(this.#closeListeners)) {
        try {
          listener(error);
        } catch {
          // A lifecycle listener must not break socket cleanup.
        }
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanUp = () => {
          socket.off("connect", onConnect);
          socket.off("error", onError);
          socket.off("close", onClose);
        };
        const onConnect = () => {
          cleanUp();
          resolve();
        };
        const onError = (error: Error) => {
          cleanUp();
          reject(error);
        };
        const onClose = () => {
          cleanUp();
          reject(new Error("Meka socket closed while connecting"));
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
        socket.once("close", onClose);
      });
    } catch (error) {
      if (this.#socket === socket) {
        this.close();
      }
      throw error;
    }
    if (this.#socket !== socket) {
      throw new Error("Meka client closed while connecting");
    }
    try {
      const initialized = await this.request<MekaInitializeResult>("meka.initialize", {
        protocolVersion: MEKA_PROTOCOL_VERSION,
        client: { name: "@meka/app", version: "0.1.0" },
      });
      if (this.#socket !== socket) {
        throw new Error("Meka client closed while initializing");
      }
      this.initializeResult = initialized;
      return initialized;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #receive(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.#decoder.push(chunk);
    } catch (error) {
      this.#rejectAll(error instanceof Error ? error : new Error(String(error)));
      this.#socket?.destroy();
      return;
    }
    for (const value of messages) {
      try {
        const message = record(value, "JSON-RPC message");
        if (message.jsonrpc !== "2.0") {
          throw new Error("Invalid JSON-RPC version from Meka");
        }
        if (typeof message.method === "string" && message.id === undefined) {
          const notification = message as JsonRpcNotification;
          for (const listener of Array.from(this.#listeners)) {
            try {
              listener(notification);
            } catch {
              // A consumer callback must not break the protocol stream.
            }
          }
          continue;
        }
        if (!(typeof message.id === "string" || typeof message.id === "number")) {
          throw new Error("Meka response is missing an id");
        }
        if (message.error && typeof message.error === "object") {
          const error = record(message.error, "JSON-RPC error");
          this.#settle(
            message.id,
            false,
            new MekaRpcError(
              typeof error.message === "string" ? error.message : "Meka request failed",
              typeof error.code === "number" ? error.code : -32000,
              error.data,
            ),
          );
        } else {
          this.#settle(message.id, true, message.result);
        }
      } catch (error) {
        this.#rejectAll(error instanceof Error ? error : new Error(String(error)));
        this.#socket?.destroy();
        return;
      }
    }
  }

  #settle(id: JsonRpcId, resolved: boolean, value: unknown): void {
    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }
    this.#pending.delete(id);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    if (resolved) {
      pending.resolve(value);
    } else {
      pending.reject(value instanceof Error ? value : new Error(String(value)));
    }
  }

  #rejectAll(error: Error): void {
    for (const [id] of this.#pending) {
      this.#settle(id, false, error);
    }
  }
}
