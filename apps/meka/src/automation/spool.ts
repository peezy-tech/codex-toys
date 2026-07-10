import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { AutomationValidationError } from "./errors.ts";
import type {
  AutomationTimestamp,
  SpoolEntry,
  SpoolEntryDetail,
  SpoolEntryInput,
} from "./types.ts";

const MAX_SPOOL_ENTRY_BYTES = 1024 * 1024;
const SPOOL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

type SerializedSpoolEntry = {
  version: 1;
  id: string;
  kind: string;
  createdAt: string;
  payload: unknown;
};

/**
 * Persists one envelope with a write+fsync+hard-link commit. The hard link is
 * the no-replace commit point: a repeated explicit id returns the prior entry
 * rather than overwriting an event that has not been consumed yet.
 */
export function writeAtomicSpoolEntry(spoolPath: string, input: SpoolEntryInput): SpoolEntry {
  const createdAt = toIso(input.createdAt ?? Date.now());
  const id = input.id ? assertSpoolId(input.id) : `spool-${randomUUID()}`;
  const kind = assertText(input.kind, "spool kind");
  const target = path.join(spoolPath, `${id}.json`);
  const serialized: SerializedSpoolEntry = {
    version: 1,
    id,
    kind,
    createdAt,
    payload: input.payload,
  };
  const bytes = Buffer.from(`${JSON.stringify(serialized)}\n`, "utf8");
  if (bytes.length > MAX_SPOOL_ENTRY_BYTES) {
    throw new AutomationValidationError(`Spool entry exceeds ${MAX_SPOOL_ENTRY_BYTES} bytes`);
  }

  const temporary = path.join(spoolPath, `.${id}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporary, target);
    } catch (error) {
      if (isAlreadyExists(error)) {
        return spoolEntryFromPath(target);
      }
      throw error;
    }
    fsyncDirectory(spoolPath);
    return { id, kind, createdAt, path: target, bytes: bytes.length };
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    rmSync(temporary, { force: true });
  }
}

export function readSpoolEntry(spoolPath: string, id: string): SpoolEntryDetail | undefined {
  const target = path.join(spoolPath, `${assertSpoolId(id)}.json`);
  try {
    const raw = readFileSync(target, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_SPOOL_ENTRY_BYTES) {
      throw new AutomationValidationError(`Spool entry exceeds ${MAX_SPOOL_ENTRY_BYTES} bytes`);
    }
    const parsed = JSON.parse(raw) as SerializedSpoolEntry;
    if (
      !parsed ||
      parsed.version !== 1 ||
      typeof parsed.id !== "string" ||
      typeof parsed.kind !== "string"
    ) {
      throw new AutomationValidationError(`Invalid spool entry: ${id}`);
    }
    return {
      id: parsed.id,
      kind: parsed.kind,
      createdAt: parsed.createdAt,
      path: target,
      bytes: Buffer.byteLength(raw, "utf8"),
      payload: parsed.payload,
    };
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

export function listSpoolEntries(spoolPath: string, limit = 100): SpoolEntry[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new AutomationValidationError("Spool list limit must be an integer from 1 to 10000");
  }
  return readdirSync(spoolPath)
    .filter((name) => name.endsWith(".json") && SPOOL_NAME.test(name.slice(0, -".json".length)))
    .map((name) => spoolEntryFromPath(path.join(spoolPath, name)))
    .sort((left, right) => {
      const byCreation = left.createdAt.localeCompare(right.createdAt);
      return byCreation === 0 ? left.id.localeCompare(right.id) : byCreation;
    })
    .slice(0, limit);
}

export function acknowledgeSpoolEntry(spoolPath: string, id: string): boolean {
  const target = path.join(spoolPath, `${assertSpoolId(id)}.json`);
  try {
    unlinkSync(target);
    fsyncDirectory(spoolPath);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

export function spoolPayloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function spoolEntryFromPath(target: string): SpoolEntry {
  const detail = readSpoolEntry(path.dirname(target), path.basename(target, ".json"));
  if (!detail) {
    throw new AutomationValidationError(`Spool entry disappeared during read: ${target}`);
  }
  const { payload: _payload, ...entry } = detail;
  return entry;
}

function assertSpoolId(value: string): string {
  if (!SPOOL_NAME.test(value)) {
    throw new AutomationValidationError(
      "Spool id must contain only letters, numbers, '.', '_', or '-'",
    );
  }
  return value;
}

function assertText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new AutomationValidationError(
      `${label} must be a non-empty string of at most 256 characters`,
    );
  }
  return value;
}

function toIso(value: AutomationTimestamp): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AutomationValidationError("Spool createdAt must be a valid timestamp");
  }
  return date.toISOString();
}

function fsyncDirectory(directory: string): void {
  // Directory fsync is a best-effort durability improvement. Some supported
  // filesystems do not permit opening directories through Node.
  try {
    const descriptor = openSync(directory, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // The file itself has already been fsynced. Do not turn a filesystem
    // capability difference into a failed ingestion path.
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
