#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_INBOX_ENTRIES = 4096;
const MAX_INBOX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ENTRY_NAME = /^hook-([0-9]{13})-[0-9a-f-]{36}\.json$/i;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const MEKA_MANAGED_SESSION_ENV = "MEKA_MANAGED_SESSION";
const source = process.argv[2] === "claude" ? "claude" : "codex";

try {
  const input = await readInput();
  if (process.env[MEKA_MANAGED_SESSION_ENV] !== "1") {
    const event = await normalize(source, input);
    const location = resolveInboxLocation();
    await ensurePrivateDirectory(location.root);
    await ensurePrivateDirectory(location.inboxPath);
    await writeAtomicEntry(location.inboxPath, event);
    await pruneInbox(location.inboxPath);
  }
} catch {
  // Observability is fail-open: an unavailable bridge must not block an agent session.
}

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_INPUT_BYTES) {
      throw new Error("hook payload is too large");
    }
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("hook payload must be an object");
  }
  return value;
}

async function normalize(provider, input) {
  const eventId = randomUUID();
  const now = Date.now();
  const occurredAt = new Date(now).toISOString();
  const cwd = await realpath(path.resolve(requiredString(input.cwd, "cwd", 4096)));
  if (cwd.length > 4096) throw new Error("cwd is too long");
  const nativeEvent = string(input.hook_event_name, 256) ?? "unknown";
  if (!NAME.test(nativeEvent) || !NAME.test(`agent.${provider}.${nativeEvent}`)) {
    throw new Error("hook event name cannot be routed safely");
  }
  const sessionId = string(input.session_id, 512);
  const turnId = string(input.turn_id, 512);
  const toolUseId = string(input.tool_use_id, 512);
  const sourceEventId = stableEventId({
    provider,
    sessionId,
    nativeEvent,
    turnId,
    toolUseId,
    cwd,
    occurrenceId: eventId,
  });
  const metadata = { cwd };
  copy(metadata, "turnId", turnId, 512);
  copy(metadata, "toolUseId", toolUseId, 512);
  copy(metadata, "toolName", input.tool_name, 256);
  copy(metadata, "model", input.model, 256);
  copy(metadata, "permissionMode", input.permission_mode, 128);
  copy(metadata, "sessionSource", input.source, 128);
  return {
    id: `hook-${String(now).padStart(13, "0")}-${eventId}`,
    occurredAt,
    cwd,
    payload: {
      source: `${provider}-hook`,
      sourceEventId,
      provider,
      sessionId,
      eventType: nativeEvent,
      occurredAt,
      payload: metadata,
    },
  };
}

function stableEventId({
  provider,
  sessionId,
  nativeEvent,
  turnId,
  toolUseId,
  cwd,
  occurrenceId,
}) {
  const identity = JSON.stringify([
    provider,
    sessionId ?? null,
    nativeEvent,
    turnId ?? null,
    toolUseId ?? null,
    // A session id does not identify a prompt/lifecycle occurrence. Hosts that
    // omit turn/tool ids therefore get an invocation-scoped identity so later
    // hooks in the same session cannot be collapsed by downstream dedupe.
    turnId || toolUseId ? null : occurrenceId,
    sessionId || turnId || toolUseId ? null : cwd,
  ]);
  return `hook_${createHash("sha256").update(identity).digest("hex")}`;
}

async function writeAtomicEntry(inboxPath, event) {
  const envelope = {
    version: 1,
    id: event.id,
    kind: "agent.hook",
    createdAt: event.occurredAt,
    cwd: event.cwd,
    payload: event.payload,
  };
  const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
  if (bytes.length > MAX_ENTRY_BYTES) {
    throw new Error("spool entry is too large");
  }
  const target = path.join(inboxPath, `${event.id}.json`);
  const temporary = path.join(inboxPath, `.${event.id}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, target);
    await syncDirectory(inboxPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("hook inbox must be a real directory");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("hook inbox must be owned by the current user");
  }
  await chmod(directory, 0o700);
}

async function syncDirectory(directory) {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The entry itself is already fsynced; directory fsync is best effort.
  }
}

function copy(target, key, value, maxLength) {
  const normalized = string(value, maxLength);
  if (normalized !== undefined) {
    target[key] = normalized;
  }
}

function requiredString(value, label, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function string(value, maxLength) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maxLength) : undefined;
}

function resolveInboxLocation() {
  const stateRoot =
    process.env.XDG_STATE_HOME && path.isAbsolute(process.env.XDG_STATE_HOME)
      ? process.env.XDG_STATE_HOME
      : path.join(os.homedir(), ".local", "state");
  const root = path.join(stateRoot, "meka", "hook-ingress");
  return { root, inboxPath: path.join(root, "inbox") };
}

async function pruneInbox(inboxPath) {
  const now = Date.now();
  const entries = [];
  for (const name of await readdir(inboxPath)) {
    const match = ENTRY_NAME.exec(name);
    if (!match) continue;
    const occurredAt = Number(match[1]);
    if (now - occurredAt > MAX_INBOX_AGE_MS) {
      await rm(path.join(inboxPath, name), { force: true });
    } else {
      entries.push({ name, occurredAt });
    }
  }
  entries.sort(
    (left, right) => left.occurredAt - right.occurredAt || left.name.localeCompare(right.name),
  );
  for (const entry of entries.slice(0, Math.max(0, entries.length - MAX_INBOX_ENTRIES))) {
    await rm(path.join(inboxPath, entry.name), { force: true });
  }
}
