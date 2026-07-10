import { Schema } from "effect";

export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  | JsonPrimitive
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

/** A recursive schema for values that can be transported over JSON IPC. */
export const JsonValueSchema: Schema.Schema<JsonValue, JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.Null,
    Schema.Boolean,
    Schema.Number,
    Schema.String,
    Schema.Array(JsonValueSchema),
    Schema.Record({ key: Schema.String, value: JsonValueSchema }),
  ),
);

export const JsonObjectSchema: Schema.Schema<JsonObject, JsonObject> = Schema.Record({
  key: Schema.String,
  value: JsonValueSchema,
});

/**
 * Converts any thrown value, defect, or service detail into a JSON-safe value.
 * It is intentionally total so a runner can always report its terminal result.
 */
export function toJsonValue(value: unknown): JsonValue {
  try {
    return convertJsonValue(value, new WeakSet<object>());
  } catch (error) {
    return `[Unserializable: ${formatUnknown(error)}]`;
  }
}

function convertJsonValue(value: unknown, active: WeakSet<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined") {
    return null;
  }
  if (typeof value === "symbol") {
    return value.description ?? value.toString();
  }
  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Error) {
    if (active.has(value)) {
      return "[Circular]";
    }
    active.add(value);
    try {
      const error: Record<string, JsonValue> = {
        name: value.name,
        message: value.message,
      };
      if (value.stack) {
        error.stack = value.stack;
      }
      if (value.cause !== undefined) {
        error.cause = convertJsonValue(value.cause, active);
      }
      return error;
    } finally {
      active.delete(value);
    }
  }

  const object = value as object;
  if (active.has(object)) {
    return "[Circular]";
  }
  active.add(object);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => convertJsonValue(item, active));
    }

    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(object).sort()) {
      try {
        result[key] = convertJsonValue((object as Record<string, unknown>)[key], active);
      } catch (error) {
        result[key] = `[Unserializable: ${formatUnknown(error)}]`;
      }
    }
    return result;
  } finally {
    active.delete(object);
  }
}

export function formatUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message || value.name;
  }
  try {
    const formatted = String(value);
    return formatted.length > 0 ? formatted : "Unknown error";
  } catch {
    return "Unknown error";
  }
}
