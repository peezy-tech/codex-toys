import { expect, test } from "vite-plus/test";
import {
  MAX_FRAME_BYTES,
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
} from "../src/protocol.ts";

test("decodes fragmented NDJSON frames, CRLF, and blank lines", () => {
  const decoder = new NdjsonDecoder();

  expect(decoder.push(Buffer.from('{"jsonrpc":"2.0","id":1'))).toEqual([]);
  expect(decoder.push(Buffer.from(',"method":"meka.status"}\r\n\n'))).toEqual([
    { jsonrpc: "2.0", id: 1, method: "meka.status" },
  ]);
  expect(decoder.push(Buffer.from('{"one":1}\n{"two":2}\n{"partial":'))).toEqual([
    { one: 1 },
    { two: 2 },
  ]);
  expect(decoder.push(Buffer.from("true}\n"))).toEqual([{ partial: true }]);
});

test("rejects malformed frames with JSON-RPC parse errors", () => {
  expect(() => new NdjsonDecoder().push(Buffer.from("not-json\n"))).toThrowError(
    expect.objectContaining({ code: -32700, message: "Invalid JSON" }),
  );
  expect(() => new NdjsonDecoder().push(Buffer.from("[]\n"))).toThrowError(
    expect.objectContaining({ code: -32600 }),
  );
  expect(() => new NdjsonDecoder().push(Buffer.from([0xc3, 0x28, 0x0a]))).toThrowError(
    expect.objectContaining({ code: -32700, message: "Frame is not valid UTF-8" }),
  );
});

test("enforces the byte limit for terminated and unterminated frames", () => {
  const unterminated = new NdjsonDecoder(4);
  expect(() => unterminated.push(Buffer.from("12345"))).toThrowError(
    expect.objectContaining({ code: -32700, message: "Frame exceeds maximum size" }),
  );

  const terminated = new NdjsonDecoder(4);
  expect(() => terminated.push(Buffer.from("12345\n"))).toThrowError(
    expect.objectContaining({ code: -32700, message: "Frame exceeds maximum size" }),
  );
});

test("encodes provider values into one JSON-safe NDJSON frame", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const encoded = encodeMessage({
    big: 42n,
    notFinite: Number.POSITIVE_INFINITY,
    error: new Error("boom"),
    circular,
  });

  expect(encoded.at(-1)).toBe(0x0a);
  expect(encoded.length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  expect(JSON.parse(encoded.toString("utf8"))).toEqual({
    big: "42",
    notFinite: "Infinity",
    error: { name: "Error", message: "boom" },
    circular: { self: "[Circular]" },
  });
});

test("builds JSON-RPC envelopes without adding undefined data", () => {
  expect(success("request-1", { ok: true })).toEqual({
    jsonrpc: "2.0",
    id: "request-1",
    result: { ok: true },
  });
  expect(failure(1, -32601, "Unknown method")).toEqual({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32601, message: "Unknown method" },
  });
  expect(failure(null, -32000, "Failed", { reason: "test" })).toEqual({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32000, message: "Failed", data: { reason: "test" } },
  });
  expect(notification("run.event", { runId: "run-1" })).toEqual({
    jsonrpc: "2.0",
    method: "run.event",
    params: { runId: "run-1" },
  });
});

test("validates method parameters at the protocol boundary", () => {
  expect(record({ provider: "codex" })).toEqual({ provider: "codex" });
  expect(requiredString(" hello ", "prompt")).toBe(" hello ");
  expect(optionalString("", "model")).toBeUndefined();
  expect(optionalString(null, "model")).toBeUndefined();
  expect(provider("codex")).toBe("codex");
  expect(provider("claude")).toBe("claude");

  expect(() => record([], "params")).toThrowError(MekaRpcError);
  expect(() => requiredString("  ", "prompt")).toThrowError(
    expect.objectContaining({ code: -32602 }),
  );
  expect(() => optionalString(1, "model")).toThrowError(expect.objectContaining({ code: -32602 }));
  expect(() => provider("other")).toThrowError(expect.objectContaining({ code: -32602 }));
});
