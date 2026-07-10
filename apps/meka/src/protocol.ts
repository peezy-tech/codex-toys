import { TextDecoder } from "node:util";
import type {
  MekaEvent,
  MekaProvider,
  MekaRunOutcome,
  MekaRunState,
  PluginInstallResult,
} from "@meka/sdk";

export const MEKA_PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification;

export type MekaRunSummary = {
  id: string;
  provider: MekaProvider;
  state: MekaRunState | "starting";
  providerSessionId: string | null;
  providerRunId: string | null;
  startedAt: string;
  outcome?: MekaRunOutcome;
};

export type MekaRunEvent = {
  runId: string;
  sequence: number;
  at: string;
  provider: MekaProvider;
  event: MekaEvent["event"];
};

export type MekaRunStateEvent = {
  run: MekaRunSummary;
};

export type MekaInitializeResult = {
  protocolVersion: number;
  instanceId: string;
  pid: number;
  socketPath: string;
  capabilities: string[];
};

export type MekaReadyInfo = {
  socketPath: string;
  instanceId: string;
  pid: number;
  protocolVersion: number;
};

export type MekaStatusResult = MekaInitializeResult & {
  startedAt: string;
  cwd: string;
  runs: MekaRunSummary[];
};

export type MekaSubscribeResult = {
  run: MekaRunSummary;
  replay: {
    requestedAfter: number;
    oldestAvailable: number;
    latestAvailable: number;
    gap: boolean;
  };
};

export type MekaPluginInstallResult = PluginInstallResult;

export class MekaRpcError extends Error {
  constructor(
    message: string,
    readonly code = -32000,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "MekaRpcError";
  }
}

export class NdjsonDecoder {
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(readonly maxFrameBytes = MAX_FRAME_BYTES) {}

  push(chunk: Buffer): unknown[] {
    this.#buffer =
      this.#buffer.length === 0
        ? chunk
        : Buffer.concat([this.#buffer, chunk], this.#buffer.length + chunk.length);
    const frames: unknown[] = [];
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.length > this.maxFrameBytes) {
          throw new MekaRpcError("Frame exceeds maximum size", -32700);
        }
        break;
      }
      let line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.length > 0 && line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      if (line.length === 0) {
        continue;
      }
      if (line.length > this.maxFrameBytes) {
        throw new MekaRpcError("Frame exceeds maximum size", -32700);
      }
      let text: string;
      try {
        text = this.#decoder.decode(line);
      } catch {
        throw new MekaRpcError("Frame is not valid UTF-8", -32700);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new MekaRpcError("Invalid JSON", -32700);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new MekaRpcError("JSON-RPC frame must be an object", -32600);
      }
      frames.push(parsed);
    }
    return frames;
  }
}

export function encodeMessage(message: unknown): Buffer {
  const value = toJsonSafe(message);
  const output = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (output.length > MAX_FRAME_BYTES) {
    throw new MekaRpcError("Encoded frame exceeds maximum size", -32603, {
      bytes: output.length,
    });
  }
  return output;
}

export function success(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function failure(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

export function notification(method: string, params: Record<string, unknown>): JsonRpcNotification {
  return { jsonrpc: "2.0", method, params };
}

export function record(value: unknown, label = "params"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MekaRpcError(`${label} must be an object`, -32602);
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MekaRpcError(`${label} is required`, -32602);
  }
  return value;
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new MekaRpcError(`${label} must be a string`, -32602);
  }
  return value || undefined;
}

export function provider(value: unknown): MekaProvider {
  if (value === "codex" || value === "claude") {
    return value;
  }
  throw new MekaRpcError("provider must be codex or claude", -32602);
}

function toJsonSafe(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 30) {
    return "[MaxDepth]";
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return value.map((entry) => toJsonSafe(entry, seen, depth + 1));
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonSafe(entry, seen, depth + 1)]),
    );
  }
  return String(value);
}
