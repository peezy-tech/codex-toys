import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { Effect } from "effect";
import { XMLParser } from "fast-xml-parser";
import { toJsonValue, type JsonObject, type JsonValue } from "@meka/workflow";
import { killProcessTree, USES_PROCESS_GROUPS } from "./process-tree.ts";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 768 * 1024;
const MAX_DURABLE_RESULT_BYTES = 896 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CURSOR_IDS = 512;

export type NormalizedSourceEvent = {
  id: string;
  type: string;
  source: string;
  observedAt: string;
  verified: boolean;
  deliveryId?: string;
  metadata?: JsonObject;
  payload: JsonValue;
};

export type RssSourceCursor = {
  etag?: string;
  lastModified?: string;
  seen: string[];
};

export type RssPollResult = {
  events: NormalizedSourceEvent[];
  cursor: RssSourceCursor;
  notModified: boolean;
};

export type ConfiguredCommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export class SourceFailure extends Error {
  readonly _tag = "SourceFailure";

  constructor(
    readonly operation: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SourceFailure";
  }
}

/** Polls one configured RSS/Atom URL once; scheduling remains an operator concern. */
export function pollRssSource(options: {
  id: string;
  url: string;
  eventType?: string;
  cursor?: Partial<RssSourceCursor> | null;
  timeoutMs?: number;
}): Effect.Effect<RssPollResult, SourceFailure> {
  return Effect.tryPromise({
    try: async () => {
      const url = new URL(options.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("RSS URL must use http or https");
      }
      const cursor = normalizeCursor(options.cursor);
      const headers = new Headers({
        accept: "application/atom+xml, application/rss+xml, application/xml, text/xml",
      });
      if (cursor.etag) headers.set("if-none-match", cursor.etag);
      if (cursor.lastModified) headers.set("if-modified-since", cursor.lastModified);
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      const nextHeaders = {
        ...(response.headers.get("etag") ? { etag: response.headers.get("etag") as string } : {}),
        ...(response.headers.get("last-modified")
          ? { lastModified: response.headers.get("last-modified") as string }
          : {}),
      };
      if (response.status === 304) {
        return { events: [], cursor: { ...cursor, ...nextHeaders }, notModified: true };
      }
      if (!response.ok) throw new Error(`RSS request failed with HTTP ${response.status}`);
      const xml = await readBoundedResponse(response, MAX_SOURCE_BYTES);
      const document = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@",
        textNodeName: "#text",
        processEntities: false,
        trimValues: true,
      }).parse(xml) as unknown;
      const entries = extractFeedEntries(document);
      const known = new Set(cursor.seen);
      const identities: string[] = [];
      const events: NormalizedSourceEvent[] = [];
      for (const entry of entries) {
        const identity = feedIdentity(entry);
        const deliveryId = sha256(`${options.id}\0${identity}`);
        identities.push(deliveryId);
        if (known.has(deliveryId)) continue;
        events.push({
          id: deliveryId,
          type: options.eventType ?? "rss.item",
          source: `rss:${options.id}`,
          observedAt: new Date().toISOString(),
          verified: false,
          deliveryId,
          metadata: { feedUrl: url.href },
          payload: toJsonValue(entry),
        });
      }
      return {
        events,
        cursor: {
          ...nextHeaders,
          seen: [...identities, ...cursor.seen.filter((id) => !identities.includes(id))].slice(
            0,
            MAX_CURSOR_IDS,
          ),
        },
        notModified: false,
      };
    },
    catch: (error) => sourceFailure("rss.poll", error, true),
  });
}

/** Verifies and normalizes a GitHub webhook body supplied by a trusted ingress edge. */
export function decodeGitHubWebhook(options: {
  sourceId: string;
  eventName: string;
  deliveryId: string;
  signature: string;
  secret: string;
  body: Buffer | string;
}): Effect.Effect<NormalizedSourceEvent, SourceFailure> {
  return Effect.try({
    try: () => {
      const body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body, "utf8");
      if (body.length > MAX_SOURCE_BYTES) throw new Error("GitHub webhook body is too large");
      if (!options.deliveryId || !options.eventName) {
        throw new Error("GitHub delivery id and event name are required");
      }
      const expected = `sha256=${createHmac("sha256", options.secret).update(body).digest("hex")}`;
      const actualBytes = Buffer.from(options.signature, "utf8");
      const expectedBytes = Buffer.from(expected, "utf8");
      if (
        actualBytes.length !== expectedBytes.length ||
        !timingSafeEqual(actualBytes, expectedBytes)
      ) {
        throw new Error("GitHub webhook signature does not match");
      }
      const payload = JSON.parse(body.toString("utf8")) as unknown;
      return {
        id: sha256(`${options.sourceId}\0${options.deliveryId}`),
        type: `github.${options.eventName}`,
        source: `github:${options.sourceId}`,
        observedAt: new Date().toISOString(),
        verified: true,
        deliveryId: options.deliveryId,
        metadata: {
          event: options.eventName,
          ...(readAction(payload) ? { action: readAction(payload) as string } : {}),
        },
        payload: toJsonValue(payload),
      };
    },
    catch: (error) => sourceFailure("github.verify", error, false),
  });
}

/** Runs a configured argv directly (never through a shell) and parses stdout as JSON. */
export function runCommandSource(options: {
  id: string;
  argv: readonly [string, ...string[]];
  cwd: string;
  eventType?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}): Effect.Effect<NormalizedSourceEvent, SourceFailure> {
  return Effect.tryPromise({
    try: async () => {
      const result = await runBoundedCommand(
        options.argv,
        options.cwd,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options.env,
      );
      if (result.timedOut) {
        throw new Error(`Command timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
      }
      if (result.code !== 0) {
        throw new Error(
          `Command exited with ${result.signal ?? result.code}: ${result.stderr || "no stderr"}`,
        );
      }
      const payload = JSON.parse(result.stdout) as unknown;
      const deliveryId = sha256(`${options.id}\0${new Date().toISOString()}\0${result.stdout}`);
      return {
        id: deliveryId,
        type: options.eventType ?? "command.result",
        source: `command:${options.id}`,
        observedAt: new Date().toISOString(),
        verified: false,
        deliveryId,
        metadata: { argv0: options.argv[0] },
        payload: toJsonValue(payload),
      };
    },
    catch: (error) => sourceFailure("command.run", error, true),
  });
}

/** Executes a trusted configured command as argv with bounded output and no shell. */
export function runConfiguredCommand(options: {
  argv: readonly [string, ...string[]];
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}): Effect.Effect<ConfiguredCommandResult, SourceFailure> {
  return Effect.tryPromise({
    try: (effectSignal) =>
      runBoundedCommand(
        options.argv,
        options.cwd,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options.env,
        options.signal ? AbortSignal.any([effectSignal, options.signal]) : effectSignal,
      ),
    catch: (error) => sourceFailure("command.run", error, true),
  });
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw new Error(`Source response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function extractFeedEntries(value: unknown): Record<string, unknown>[] {
  const root = asRecord(value) ?? {};
  const rss = asRecord(root.rss) ?? {};
  const channel = asRecord(rss.channel) ?? {};
  const feed = asRecord(root.feed) ?? {};
  const input = channel.item ?? feed.entry ?? [];
  const entries = Array.isArray(input) ? input : [input];
  return entries.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)));
}

function feedIdentity(entry: Record<string, unknown>): string {
  for (const key of ["guid", "id", "link", "title"]) {
    const value = textValue(entry[key]);
    if (value) return `${key}:${value}`;
  }
  return `content:${sha256(JSON.stringify(toJsonValue(entry)))}`;
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = textValue(entry);
      if (text) return text;
    }
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["#text", "@href", "href"]) {
    const text = textValue(record[key]);
    if (text) return text;
  }
  return undefined;
}

function readAction(value: unknown): string | undefined {
  const action = asRecord(value)?.action;
  return typeof action === "string" && action.length > 0 ? action : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeCursor(cursor: Partial<RssSourceCursor> | null | undefined): RssSourceCursor {
  return {
    ...(typeof cursor?.etag === "string" ? { etag: cursor.etag } : {}),
    ...(typeof cursor?.lastModified === "string" ? { lastModified: cursor.lastModified } : {}),
    seen: Array.isArray(cursor?.seen)
      ? cursor.seen
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, MAX_CURSOR_IDS)
      : [],
  };
}

function runBoundedCommand(
  argv: readonly [string, ...string[]],
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string>,
  signal?: AbortSignal,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      detached: USES_PROCESS_GROUPS,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let oversized = false;
    let timedOut = false;
    let aborted: Error | undefined;
    const terminate = () => killProcessTree(child);
    const retain = (target: Buffer[], value: Buffer): void => {
      const remaining = MAX_COMMAND_OUTPUT_BYTES - capturedBytes;
      if (remaining > 0) target.push(value.subarray(0, remaining));
      if (value.length > remaining) oversized = true;
      capturedBytes += Math.min(value.length, Math.max(0, remaining));
    };
    child.stdout.on("data", (value: Buffer) => {
      retain(stdout, value);
      if (oversized) terminate();
    });
    child.stderr.on("data", (value: Buffer) => {
      retain(stderr, value);
      if (oversized) terminate();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref();
    const onAbort = () => {
      aborted = abortError(signal as AbortSignal);
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => {
      cleanup();
      terminate();
      reject(aborted ?? error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      // The direct command may exit while a descendant remains in the group.
      // Always close the group before returning a terminal result.
      terminate();
      if (aborted) {
        reject(aborted);
        return;
      }
      if (oversized) {
        reject(new Error(`Command output exceeds ${MAX_COMMAND_OUTPUT_BYTES} bytes`));
        return;
      }
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
      };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_DURABLE_RESULT_BYTES) {
        reject(new Error(`Command result exceeds ${MAX_DURABLE_RESULT_BYTES} durable JSON bytes`));
        return;
      }
      resolve(result);
    });
  });
}

function abortError(signal: AbortSignal): Error {
  const detail =
    signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "");
  const error = new Error(
    detail ? `Command execution aborted: ${detail}` : "Command execution aborted",
  );
  error.name = "AbortError";
  return error;
}

function sourceFailure(operation: string, error: unknown, retryable: boolean): SourceFailure {
  return new SourceFailure(
    operation,
    error instanceof Error ? error.message : String(error),
    retryable,
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
