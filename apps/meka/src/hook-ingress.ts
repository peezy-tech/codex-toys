import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AutomationValidationError } from "./automation/errors.ts";
import type { AgentHookEventInput } from "./automation/types.ts";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_ENTRY_BYTES = 1024 * 1024;
const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_ENTRIES = 4096;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CONSUMER_LEASE_MS = 30_000;
const MAX_CONSUMER_LEASE_MS = 60_000;
const MAX_DEAD_LETTERS = 1_024;
const CONSUMER_LOCK_TIMEOUT_MS = 5_000;
const CONSUMER_LOCK_STALE_MS = 2 * 60_000;
const ROUTING_LOCK_CLAIM_PREFIX = "claim-";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const ENTRY_ID =
  /^hook-[0-9]{13}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONSUMER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

type SerializedHookIngressEntry = {
  version: 1;
  id: string;
  kind: "agent.hook";
  createdAt: string;
  cwd: string;
  payload: AgentHookEventInput;
};

type ParsedHookIngressEntry = SerializedHookIngressEntry & {
  path: string;
  bytes: number;
};

type SerializedConsumerRegistration = {
  version: 1;
  consumerId: string;
  workspaceRoot: string;
  token: string;
  state: "active" | "released";
  pid: number;
  registeredAt: string;
  updatedAt: string;
  leaseExpiresAt: string;
};

type RoutingLockRecord = {
  version: 1;
  token: string;
  pid: number;
  consumerId: string;
  createdAt: string;
};

type RoutingMutationLock = {
  claimPath: string;
  token: string;
};

export type HookIngressOptions = {
  /** Overrides XDG_STATE_HOME for deterministic tests and sandbox supervisors. */
  stateHome?: string;
};

export type HookIngressLocation = {
  root: string;
  inboxPath: string;
  claimsPath: string;
  consumersPath: string;
  deadLetterPath: string;
};

export type ClaimHookIngressOptions = HookIngressOptions & {
  /** A workspace claims hook events emitted from itself or any descendant cwd. */
  workspaceRoot: string;
  /** Stable across restarts. Concurrent consumers should use distinct ids. */
  consumerId?: string;
  /** Fencing token returned by registerHookIngressConsumer. */
  consumerToken?: string;
  limit?: number;
  now?: number | Date;
};

export type RegisterHookIngressConsumerOptions = HookIngressOptions & {
  workspaceRoot: string;
  consumerId?: string;
  leaseMs?: number;
  now?: number | Date;
};

export type HookIngressConsumerRegistration = {
  consumerId: string;
  workspaceRoot: string;
  token: string;
  registeredAt: string;
  updatedAt: string;
  leaseExpiresAt: string;
  ingressRoot: string;
};

export type HookIngressClaim = {
  id: string;
  createdAt: string;
  cwd: string;
  input: AgentHookEventInput;
  consumerId: string;
  path: string;
  ingressRoot: string;
};

export type PruneHookIngressOptions = HookIngressOptions & {
  maxEntries?: number;
  maxAgeMs?: number;
  now?: number | Date;
};

export type HookIngressPruneResult = {
  removed: number;
  remaining: number;
};

export function resolveHookIngressLocation(options: HookIngressOptions = {}): HookIngressLocation {
  const stateHome = resolveStateHome(options.stateHome);
  const root = path.join(stateHome, "meka", "hook-ingress");
  return {
    root,
    inboxPath: path.join(root, "inbox"),
    claimsPath: path.join(root, "claims"),
    consumersPath: path.join(root, "consumers"),
    deadLetterPath: path.join(root, "dead-letter"),
  };
}

/**
 * Publishes a short private lease used to route an event to the most-specific
 * live workspace. A live registration with the same stable consumer id cannot
 * be replaced by a different process token.
 */
export async function registerHookIngressConsumer(
  options: RegisterHookIngressConsumerOptions,
): Promise<HookIngressConsumerRegistration> {
  const now = optionTimestamp(options.now);
  const leaseMs = assertConsumerLeaseMs(options.leaseMs ?? DEFAULT_CONSUMER_LEASE_MS);
  const workspaceRoot = await canonicalPath(options.workspaceRoot, "workspaceRoot");
  const consumerId = assertConsumerId(options.consumerId ?? defaultConsumerId(workspaceRoot));
  const location = await ensureHookIngressLocation(options);
  const target = consumerRegistrationPath(location, consumerId);
  return await withRoutingMutationLock(location, consumerId, async () => {
    const existing = await readConsumerRegistration(target);
    if (existing?.state === "active" && Date.parse(existing.leaseExpiresAt) > now) {
      throw new AutomationValidationError(
        `Hook ingress consumer is already active for ${workspaceRoot}`,
      );
    }
    const timestamp = new Date(now).toISOString();
    const record: SerializedConsumerRegistration = {
      version: 1,
      consumerId,
      workspaceRoot,
      token: randomUUID(),
      state: "active",
      pid: process.pid,
      registeredAt: timestamp,
      updatedAt: timestamp,
      leaseExpiresAt: new Date(now + leaseMs).toISOString(),
    };
    await writePrivateJson(target, record);
    return toConsumerRegistration(record, location.root);
  });
}

/** Renews an unexpired consumer lease without changing its fencing token. */
export async function renewHookIngressConsumer(
  registration: HookIngressConsumerRegistration,
  options: HookIngressOptions & { leaseMs?: number; now?: number | Date } = {},
): Promise<HookIngressConsumerRegistration> {
  const location = assertedConsumerLocation(registration, options);
  const now = optionTimestamp(options.now);
  const leaseMs = assertConsumerLeaseMs(options.leaseMs ?? DEFAULT_CONSUMER_LEASE_MS);
  const target = consumerRegistrationPath(location, registration.consumerId);
  return await withRoutingMutationLock(location, registration.consumerId, async () => {
    const current = await readConsumerRegistration(target);
    if (
      !current ||
      current.state !== "active" ||
      current.token !== registration.token ||
      Date.parse(current.leaseExpiresAt) <= now
    ) {
      throw new AutomationValidationError("Hook ingress consumer lease is no longer active");
    }
    const renewed: SerializedConsumerRegistration = {
      ...current,
      updatedAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now + leaseMs).toISOString(),
    };
    await writePrivateJson(target, renewed);
    return toConsumerRegistration(renewed, location.root);
  });
}

/** Releases a consumer lease but leaves a tombstone for safe claim recovery. */
export async function releaseHookIngressConsumer(
  registration: HookIngressConsumerRegistration,
  options: HookIngressOptions & { now?: number | Date } = {},
): Promise<boolean> {
  const location = assertedConsumerLocation(registration, options);
  const target = consumerRegistrationPath(location, registration.consumerId);
  return await withRoutingMutationLock(location, registration.consumerId, async () => {
    const current = await readConsumerRegistration(target);
    if (!current || current.token !== registration.token || current.state !== "active") {
      return false;
    }
    const now = optionTimestamp(options.now);
    await writePrivateJson(target, {
      ...current,
      state: "released",
      updatedAt: new Date(now).toISOString(),
      leaseExpiresAt: new Date(now).toISOString(),
    } satisfies SerializedConsumerRegistration);
    return true;
  });
}

/**
 * Atomically reserves matching global-inbox events for one runtime consumer.
 * Previously claimed events are returned too, which makes a stable consumer id
 * restart-safe. Results are always ordered by occurrence time and then id.
 */
export async function claimHookIngress(
  options: ClaimHookIngressOptions,
): Promise<HookIngressClaim[]> {
  const limit = assertLimit(options.limit ?? DEFAULT_LIMIT);
  const now = optionTimestamp(options.now);
  const workspaceRoot = await canonicalPath(options.workspaceRoot, "workspaceRoot");
  const consumerId = assertConsumerId(options.consumerId ?? defaultConsumerId(workspaceRoot));
  const location = await ensureHookIngressLocation(options);
  return await withRoutingMutationLock(location, consumerId, async () => {
    await recoverStaleClaimsAtLocation(location, now);
    const registrations = await listConsumerRegistrations(location);
    const activeRegistrations = registrations.filter(
      (registration) =>
        registration.state === "active" && Date.parse(registration.leaseExpiresAt) > now,
    );
    const callerRegistration = activeRegistrations.find(
      (registration) => registration.consumerId === consumerId,
    );
    if (callerRegistration && callerRegistration.token !== options.consumerToken) {
      return [];
    }
    const claimDirectory = path.join(location.claimsPath, consumerId);
    await ensurePrivateDirectory(claimDirectory);

    const existing = await listEntries(claimDirectory, location);
    const inbox = await listEntries(location.inboxPath, location);
    const candidates = [
      ...existing.map((entry) => ({ location: "claim" as const, entry })),
      ...inbox.map((entry) => ({ location: "inbox" as const, entry })),
    ].sort((left, right) => compareEntries(left.entry, right.entry));

    const claimed: HookIngressClaim[] = [];
    for (const candidate of candidates) {
      if (claimed.length >= limit) break;
      if (!(await isWithinWorkspace(workspaceRoot, candidate.entry.cwd))) continue;
      const owner = await mostSpecificConsumer(activeRegistrations, candidate.entry.cwd);
      if (owner && (owner.consumerId !== consumerId || owner.token !== options.consumerToken)) {
        if (candidate.location === "claim") {
          await returnClaimPathToInbox(candidate.entry, location);
        }
        continue;
      }

      if (candidate.location === "claim") {
        claimed.push(toClaim(candidate.entry, consumerId, location.root));
        continue;
      }

      const target = path.join(claimDirectory, path.basename(candidate.entry.path));
      try {
        await lstat(target);
        // Never let a duplicate inbox id overwrite a durable claim.
        continue;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      try {
        await rename(candidate.entry.path, target);
        await syncDirectory(location.inboxPath);
        await syncDirectory(claimDirectory);
        claimed.push(toClaim({ ...candidate.entry, path: target }, consumerId, location.root));
      } catch (error) {
        if (isNotFound(error)) {
          // A relay write or legacy caller can still race this routing pass.
          continue;
        }
        throw error;
      }
    }

    return claimed.sort((left, right) => compareClaims(left, right));
  });
}

/** Reads durable claims already owned by a consumer without claiming new work. */
export async function readHookIngressClaims(
  options: ClaimHookIngressOptions,
): Promise<HookIngressClaim[]> {
  const limit = assertLimit(options.limit ?? DEFAULT_LIMIT);
  const now = optionTimestamp(options.now);
  const workspaceRoot = await canonicalPath(options.workspaceRoot, "workspaceRoot");
  const consumerId = assertConsumerId(options.consumerId ?? defaultConsumerId(workspaceRoot));
  const location = await ensureHookIngressLocation(options);
  return await withRoutingMutationLock(location, consumerId, async () => {
    await recoverStaleClaimsAtLocation(location, now);
    const current = (await listConsumerRegistrations(location)).find(
      (registration) =>
        registration.consumerId === consumerId &&
        registration.state === "active" &&
        Date.parse(registration.leaseExpiresAt) > now,
    );
    if (current && current.token !== options.consumerToken) return [];
    const claimDirectory = path.join(location.claimsPath, consumerId);
    await ensurePrivateDirectory(claimDirectory);
    const claims: HookIngressClaim[] = [];
    for (const entry of await listEntries(claimDirectory, location)) {
      if (claims.length >= limit) break;
      if (await isWithinWorkspace(workspaceRoot, entry.cwd)) {
        claims.push(toClaim(entry, consumerId, location.root));
      }
    }
    return claims;
  });
}

/** Removes a claimed event only after the caller has durably ingested it. */
export async function acknowledgeHookIngressClaim(claim: HookIngressClaim): Promise<boolean> {
  const claimPath = assertClaimPath(claim);
  try {
    await unlink(claimPath);
    await syncDirectory(path.dirname(claimPath));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Returns a claim to the shared inbox so another matching runtime can retry it. */
export async function releaseHookIngressClaim(claim: HookIngressClaim): Promise<boolean> {
  const claimPath = assertClaimPath(claim);
  const location = locationFromRoot(claim.ingressRoot);
  await ensurePrivateDirectory(location.inboxPath);
  const target = path.join(location.inboxPath, `${assertEntryId(claim.id)}.json`);
  try {
    await lstat(target);
    throw new AutomationValidationError(`Hook ingress entry already exists: ${claim.id}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    await rename(claimPath, target);
    await syncDirectory(path.dirname(claimPath));
    await syncDirectory(location.inboxPath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Removes a poison claim and persists only a bounded, non-sensitive receipt. */
export async function rejectHookIngressClaim(claim: HookIngressClaim): Promise<boolean> {
  const claimPath = assertClaimPath(claim);
  const location = locationFromRoot(claim.ingressRoot);
  try {
    await lstat(claimPath);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  await deadLetterEntry(claimPath, location, claim.id, "validation");
  await syncDirectory(path.dirname(claimPath));
  return true;
}

/**
 * Returns claims owned by expired or explicitly released consumers to the
 * inbox. A registration is re-read before each move so a replacement token
 * cannot have its claims stolen by a stale recovery pass.
 */
export async function recoverStaleHookIngressClaims(
  options: HookIngressOptions & { now?: number | Date } = {},
): Promise<{ recovered: number }> {
  const location = await ensureHookIngressLocation(options);
  return await withRoutingMutationLock(location, "recovery", () =>
    recoverStaleClaimsAtLocation(location, optionTimestamp(options.now)),
  );
}

/**
 * Convenience at-least-once drain. Validation failures become sanitized dead
 * letters. Transient failures stay durable while later claims are attempted;
 * the first transient error is propagated after the batch.
 */
export async function drainHookIngress(
  options: ClaimHookIngressOptions,
  consume: (claim: HookIngressClaim) => Promise<void>,
): Promise<{ claimed: number; acknowledged: number; rejected: number }> {
  const claims = await claimHookIngress(options);
  let acknowledged = 0;
  let rejected = 0;
  let transientError: unknown;
  for (const claim of claims) {
    try {
      await consume(claim);
      if (await acknowledgeHookIngressClaim(claim)) acknowledged += 1;
    } catch (error) {
      if (error instanceof AutomationValidationError) {
        if (await rejectHookIngressClaim(claim)) rejected += 1;
        continue;
      }
      // A transient failure keeps this claim durable, but later claims in the
      // batch still get a chance to make progress.
      transientError ??= error;
    }
  }
  if (transientError !== undefined) throw transientError;
  return { claimed: claims.length, acknowledged, rejected };
}

/** Prunes only unclaimed inbox events; active durable claims are never expired. */
export async function pruneHookIngress(
  options: PruneHookIngressOptions = {},
): Promise<HookIngressPruneResult> {
  const maxEntries = assertNonNegativeInteger(
    options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    "maxEntries",
  );
  const maxAgeMs = assertNonNegativeInteger(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, "maxAgeMs");
  const now = options.now instanceof Date ? options.now.getTime() : (options.now ?? Date.now());
  if (!Number.isFinite(now)) {
    throw new AutomationValidationError("now must be a finite timestamp");
  }
  const location = await ensureHookIngressLocation(options);
  const names = (await readdir(location.inboxPath))
    .filter((name) => name.endsWith(".json") && ENTRY_ID.test(name.slice(0, -5)))
    .sort();
  const retained: Array<{ name: string; occurredAt: number }> = [];
  let removed = 0;

  for (const name of names) {
    const occurredAt = entryTimestamp(name.slice(0, -5));
    if (now - occurredAt > maxAgeMs) {
      if (await removeInboxFile(location.inboxPath, name)) removed += 1;
    } else {
      retained.push({ name, occurredAt });
    }
  }

  retained.sort(
    (left, right) => left.occurredAt - right.occurredAt || left.name.localeCompare(right.name),
  );
  const overflow = Math.max(0, retained.length - maxEntries);
  for (const entry of retained.slice(0, overflow)) {
    if (await removeInboxFile(location.inboxPath, entry.name)) removed += 1;
  }
  if (removed > 0) await syncDirectory(location.inboxPath);
  return { removed, remaining: retained.length - overflow };
}

async function ensureHookIngressLocation(
  options: HookIngressOptions,
): Promise<HookIngressLocation> {
  const location = resolveHookIngressLocation(options);
  await ensurePrivateDirectory(location.root);
  await ensurePrivateDirectory(location.inboxPath);
  await ensurePrivateDirectory(location.claimsPath);
  await ensurePrivateDirectory(location.consumersPath);
  await ensurePrivateDirectory(location.deadLetterPath);
  return location;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new AutomationValidationError(`Hook ingress path must be a real directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new AutomationValidationError(
      `Hook ingress path is not owned by the current user: ${directory}`,
    );
  }
  await chmod(directory, DIRECTORY_MODE);
}

async function listEntries(
  directory: string,
  location: HookIngressLocation,
): Promise<ParsedHookIngressEntry[]> {
  const entries: ParsedHookIngressEntry[] = [];
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    const target = path.join(directory, name);
    if (!ENTRY_ID.test(name.slice(0, -5))) {
      await deadLetterEntry(target, location, undefined, "invalid-name");
      continue;
    }
    try {
      entries.push(await readEntry(target));
    } catch (error) {
      if (isNotFound(error)) continue;
      if (error instanceof AutomationValidationError) {
        await deadLetterEntry(target, location, name.slice(0, -5), "validation");
        continue;
      }
      throw error;
    }
  }
  return entries.sort(compareEntries);
}

async function readEntry(target: string): Promise<ParsedHookIngressEntry> {
  let handle;
  try {
    handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new AutomationValidationError(`Hook ingress entry is not a regular file: ${target}`);
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new AutomationValidationError(`Hook ingress entry has a foreign owner: ${target}`);
    }
    if ((metadata.mode & 0o777) !== FILE_MODE) {
      throw new AutomationValidationError(`Hook ingress entry must have mode 0600: ${target}`);
    }
    if (metadata.size > MAX_ENTRY_BYTES) {
      throw new AutomationValidationError(`Hook ingress entry exceeds ${MAX_ENTRY_BYTES} bytes`);
    }
    const raw = await handle.readFile();
    if (raw.byteLength > MAX_ENTRY_BYTES) {
      throw new AutomationValidationError(`Hook ingress entry exceeds ${MAX_ENTRY_BYTES} bytes`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      throw new AutomationValidationError(`Hook ingress entry is not valid JSON: ${target}`);
    }
    return validateEntry(parsed, target, raw.byteLength);
  } catch (error) {
    if (isNoFollowLoop(error)) {
      throw new AutomationValidationError(`Hook ingress entry must not be a symlink: ${target}`);
    }
    if (isUnsafeEntryTypeError(error)) {
      throw new AutomationValidationError(`Hook ingress entry cannot be read safely: ${target}`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function validateEntry(value: unknown, target: string, bytes: number): ParsedHookIngressEntry {
  if (!isRecord(value)) {
    throw new AutomationValidationError(`Invalid hook ingress entry: ${target}`);
  }
  const id = assertEntryId(value.id);
  if (path.basename(target) !== `${id}.json`) {
    throw new AutomationValidationError(`Hook ingress filename does not match id: ${target}`);
  }
  if (value.version !== 1 || value.kind !== "agent.hook") {
    throw new AutomationValidationError(`Invalid hook ingress envelope: ${target}`);
  }
  const createdAt = assertTimestamp(value.createdAt, "createdAt");
  const cwd = assertAbsolutePath(value.cwd, "cwd");
  const payload = validatePayload(value.payload);
  return { version: 1, id, kind: "agent.hook", createdAt, cwd, payload, path: target, bytes };
}

function validatePayload(value: unknown): AgentHookEventInput {
  if (!isRecord(value)) {
    throw new AutomationValidationError("Hook ingress payload must be an object");
  }
  const payload: AgentHookEventInput = {
    source: assertName(value.source, "source"),
    eventType: assertName(value.eventType, "eventType"),
  };
  if (value.sourceEventId !== undefined) {
    payload.sourceEventId = assertBoundedText(value.sourceEventId, "sourceEventId", 512);
  }
  if (value.provider !== undefined) {
    payload.provider = assertName(value.provider, "provider");
  }
  if (value.sessionId !== undefined) {
    payload.sessionId = assertBoundedText(value.sessionId, "sessionId", 512);
  }
  if (value.occurredAt !== undefined) {
    payload.occurredAt = assertTimestamp(value.occurredAt, "occurredAt");
  }
  if (value.receivedAt !== undefined) {
    payload.receivedAt = assertTimestamp(value.receivedAt, "receivedAt");
  }
  if (value.sessionLeaseMs !== undefined) {
    if (
      typeof value.sessionLeaseMs !== "number" ||
      !Number.isSafeInteger(value.sessionLeaseMs) ||
      value.sessionLeaseMs < 1 ||
      value.sessionLeaseMs > 24 * 60 * 60_000
    ) {
      throw new AutomationValidationError("sessionLeaseMs must be a positive integer");
    }
    payload.sessionLeaseMs = value.sessionLeaseMs;
  }
  if ("payload" in value) payload.payload = value.payload;
  const routedType = `agent.${payload.provider ?? payload.source}.${payload.eventType}`;
  if (!NAME.test(routedType)) {
    throw new AutomationValidationError(
      "Hook ingress provider and eventType must form a routed name of at most 128 characters",
    );
  }
  return payload;
}

async function listConsumerRegistrations(
  location: HookIngressLocation,
): Promise<SerializedConsumerRegistration[]> {
  const registrations: SerializedConsumerRegistration[] = [];
  for (const name of (await readdir(location.consumersPath)).sort()) {
    if (!name.endsWith(".json") || !CONSUMER_ID.test(name.slice(0, -5))) continue;
    const target = path.join(location.consumersPath, name);
    try {
      const registration = await readConsumerRegistration(target);
      if (registration) registrations.push(registration);
    } catch (error) {
      if (isNotFound(error)) continue;
      if (error instanceof AutomationValidationError) {
        await deadLetterEntry(target, location, undefined, "invalid-consumer");
        continue;
      }
      throw error;
    }
  }
  return registrations;
}

async function readConsumerRegistration(
  target: string,
): Promise<SerializedConsumerRegistration | undefined> {
  let handle;
  try {
    handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== FILE_MODE) {
      throw new AutomationValidationError("Hook ingress consumer record must be a mode 0600 file");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new AutomationValidationError("Hook ingress consumer record has a foreign owner");
    }
    if (metadata.size > 16 * 1024) {
      throw new AutomationValidationError("Hook ingress consumer record is too large");
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new AutomationValidationError("Hook ingress consumer record is not valid JSON");
    }
    if (!isRecord(value) || value.version !== 1) {
      throw new AutomationValidationError("Invalid hook ingress consumer record");
    }
    const consumerId = assertConsumerId(assertBoundedText(value.consumerId, "consumerId", 128));
    if (path.basename(target) !== `${consumerId}.json`) {
      throw new AutomationValidationError("Hook ingress consumer filename does not match its id");
    }
    const state = value.state;
    if (state !== "active" && state !== "released") {
      throw new AutomationValidationError("Invalid hook ingress consumer state");
    }
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1) {
      throw new AutomationValidationError("Invalid hook ingress consumer pid");
    }
    return {
      version: 1,
      consumerId,
      workspaceRoot: assertAbsolutePath(value.workspaceRoot, "consumer workspaceRoot"),
      token: assertBoundedText(value.token, "consumer token", 128),
      state,
      pid: Number(value.pid),
      registeredAt: assertTimestamp(value.registeredAt, "consumer registeredAt"),
      updatedAt: assertTimestamp(value.updatedAt, "consumer updatedAt"),
      leaseExpiresAt: assertTimestamp(value.leaseExpiresAt, "consumer leaseExpiresAt"),
    };
  } catch (error) {
    if (isNotFound(error)) return undefined;
    if (isNoFollowLoop(error)) {
      throw new AutomationValidationError("Hook ingress consumer record must not be a symlink");
    }
    if (isUnsafeEntryTypeError(error)) {
      throw new AutomationValidationError("Hook ingress consumer record cannot be read safely");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function toConsumerRegistration(
  record: SerializedConsumerRegistration,
  ingressRoot: string,
): HookIngressConsumerRegistration {
  return {
    consumerId: record.consumerId,
    workspaceRoot: record.workspaceRoot,
    token: record.token,
    registeredAt: record.registeredAt,
    updatedAt: record.updatedAt,
    leaseExpiresAt: record.leaseExpiresAt,
    ingressRoot,
  };
}

function consumerRegistrationPath(location: HookIngressLocation, consumerId: string): string {
  return path.join(location.consumersPath, `${assertConsumerId(consumerId)}.json`);
}

function assertedConsumerLocation(
  registration: HookIngressConsumerRegistration,
  options: HookIngressOptions,
): HookIngressLocation {
  const location = options.stateHome
    ? resolveHookIngressLocation(options)
    : locationFromRoot(registration.ingressRoot);
  if (path.resolve(registration.ingressRoot) !== location.root) {
    throw new AutomationValidationError("Hook ingress consumer root does not match stateHome");
  }
  assertConsumerId(registration.consumerId);
  assertBoundedText(registration.token, "consumer token", 128);
  return location;
}

async function mostSpecificConsumer(
  registrations: SerializedConsumerRegistration[],
  eventCwd: string,
): Promise<SerializedConsumerRegistration | undefined> {
  const canonicalCwd = await canonicalPath(eventCwd, "hook cwd");
  return registrations
    .filter((registration) => isPathWithin(registration.workspaceRoot, canonicalCwd))
    .sort(
      (left, right) =>
        right.workspaceRoot.length - left.workspaceRoot.length ||
        left.consumerId.localeCompare(right.consumerId),
    )[0];
}

async function recoverStaleClaimsAtLocation(
  location: HookIngressLocation,
  now: number,
): Promise<{ recovered: number }> {
  let recovered = 0;
  const registrations = await listConsumerRegistrations(location);
  for (const stale of registrations.filter(
    (registration) =>
      registration.state !== "active" || Date.parse(registration.leaseExpiresAt) <= now,
  )) {
    const claimDirectory = path.join(location.claimsPath, stale.consumerId);
    try {
      await ensurePrivateDirectory(claimDirectory);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    for (const entry of await listEntries(claimDirectory, location)) {
      const current = await readConsumerRegistration(
        consumerRegistrationPath(location, stale.consumerId),
      );
      if (
        !current ||
        current.token !== stale.token ||
        (current.state === "active" && Date.parse(current.leaseExpiresAt) > now)
      ) {
        break;
      }
      if (await returnClaimPathToInbox(entry, location)) recovered += 1;
    }
  }
  return { recovered };
}

async function returnClaimPathToInbox(
  entry: ParsedHookIngressEntry,
  location: HookIngressLocation,
): Promise<boolean> {
  const target = path.join(location.inboxPath, `${entry.id}.json`);
  try {
    await lstat(target);
    // The durable claim is authoritative. A conflicting inbox copy may be
    // malformed, so never discard the claim in favor of unchecked content.
    await deadLetterEntry(target, location, entry.id, "duplicate-inbox");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    await rename(entry.path, target);
    await syncDirectory(path.dirname(entry.path));
    await syncDirectory(location.inboxPath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function deadLetterEntry(
  target: string,
  location: HookIngressLocation,
  entryId: string | undefined,
  code: "invalid-name" | "validation" | "invalid-consumer" | "duplicate-inbox",
): Promise<void> {
  try {
    await rm(target, { recursive: true, force: false });
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const now = Date.now();
  await writePrivateJson(
    path.join(
      location.deadLetterPath,
      `dead-${String(now).padStart(13, "0")}-${randomUUID()}.json`,
    ),
    {
      version: 1,
      rejectedAt: new Date(now).toISOString(),
      code,
      ...(entryId && ENTRY_ID.test(entryId) ? { entryId } : {}),
    },
  );
  await pruneDeadLetters(location.deadLetterPath, now);
}

async function pruneDeadLetters(directory: string, now: number): Promise<void> {
  const records = (await readdir(directory))
    .map((name) => {
      const match = /^dead-([0-9]{13})-[0-9a-f-]{36}\.json$/i.exec(name);
      return match ? { name, timestamp: Number(match[1]) } : undefined;
    })
    .filter((entry): entry is { name: string; timestamp: number } => Boolean(entry))
    .sort(
      (left, right) => left.timestamp - right.timestamp || left.name.localeCompare(right.name),
    );
  const expired = records.filter((record) => now - record.timestamp > DEFAULT_MAX_AGE_MS);
  const retained = records.slice(expired.length);
  const overflow = retained.slice(0, Math.max(0, retained.length - MAX_DEAD_LETTERS));
  await Promise.all(
    [...expired, ...overflow].map(async (record) => {
      await rm(path.join(directory, record.name), { force: true });
    }),
  );
}

async function writePrivateJson(target: string, value: unknown): Promise<void> {
  const directory = path.dirname(target);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", FILE_MODE);
    await handle.chmod(FILE_MODE);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

async function withRoutingMutationLock<T>(
  location: HookIngressLocation,
  consumerId: string,
  action: () => Promise<T>,
): Promise<T> {
  assertConsumerId(consumerId);
  const lock = await acquireRoutingMutationLock(location, consumerId);
  try {
    return await action();
  } finally {
    await retireRoutingLockClaim(lock.claimPath, lock.token);
  }
}

async function acquireRoutingMutationLock(
  location: HookIngressLocation,
  consumerId: string,
): Promise<RoutingMutationLock> {
  const legacyPath = path.join(location.consumersPath, ".routing.lock");
  const registryPath = path.join(location.consumersPath, ".routing.lock.claims");
  await ensurePrivateDirectory(registryPath);
  const deadline = Date.now() + CONSUMER_LOCK_TIMEOUT_MS;
  while (true) {
    if (await legacyRoutingLockActive(legacyPath)) {
      await waitForRoutingLock(deadline, consumerId);
      continue;
    }
    const token = randomUUID();
    const claimPath = path.join(registryPath, `${ROUTING_LOCK_CLAIM_PREFIX}${token}`);
    try {
      await mkdir(claimPath, { mode: DIRECTORY_MODE });
      await chmod(claimPath, DIRECTORY_MODE);
      await writePrivateJson(path.join(claimPath, "owner.json"), {
        version: 1,
        token,
        pid: process.pid,
        consumerId,
        createdAt: new Date().toISOString(),
      } satisfies RoutingLockRecord);
      await syncDirectory(registryPath);
    } catch (error) {
      await retireRoutingLockClaim(claimPath).catch(() => undefined);
      throw error;
    }

    if (
      !(await hasActiveRoutingLockClaim(registryPath, claimPath)) &&
      !(await legacyRoutingLockActive(legacyPath))
    ) {
      return { claimPath, token };
    }
    await retireRoutingLockClaim(claimPath, token);
    await waitForRoutingLock(deadline, consumerId);
  }
}

async function waitForRoutingLock(deadline: number, consumerId: string): Promise<void> {
  if (Date.now() >= deadline) {
    throw new AutomationValidationError(
      `Timed out acquiring hook consumer lock: ${consumerId}`,
    );
  }
  await new Promise((resolve) =>
    setTimeout(resolve, 5 + Math.floor(Math.random() * 21)),
  );
}

/**
 * Cooperates with the pre-claim-registry lock during upgrades without ever
 * deleting or quarantining its reused path. Dead/stale files are bypassed but
 * preserved; a live or recently incomplete legacy owner remains a blocker.
 */
async function legacyRoutingLockActive(lockPath: string): Promise<boolean> {
  let metadata;
  try {
    metadata = await lstat(lockPath);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== FILE_MODE ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new Error(`Legacy hook routing lock must be a private owned file: ${lockPath}`);
  }
  const ownerPid = await readLegacyRoutingLockPid(lockPath);
  return ownerPid !== undefined
    ? isProcessAlive(ownerPid)
    : Date.now() - metadata.mtimeMs <= CONSUMER_LOCK_STALE_MS;
}

async function readLegacyRoutingLockPid(lockPath: string): Promise<number | undefined> {
  let handle;
  try {
    handle = await open(
      lockPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const value = Number((await handle.readFile({ encoding: "utf8" })).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function hasActiveRoutingLockClaim(
  registryPath: string,
  ownClaimPath: string,
): Promise<boolean> {
  for (const entry of await readdir(registryPath, { withFileTypes: true })) {
    if (!entry.name.startsWith(ROUTING_LOCK_CLAIM_PREFIX)) continue;
    const token = entry.name.slice(ROUTING_LOCK_CLAIM_PREFIX.length);
    if (!UUID.test(token)) continue;
    const claimPath = path.join(registryPath, entry.name);
    if (claimPath === ownClaimPath) continue;

    const inspected = await inspectRoutingLockClaim(claimPath).catch((error) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (!inspected) continue;
    if (inspected.record) {
      if (inspected.record.token !== token) {
        throw new Error(`Hook routing claim token does not match its generation: ${claimPath}`);
      }
      if (isProcessAlive(inspected.record.pid)) return true;
      await retireRoutingLockClaim(claimPath, inspected.record.token);
      continue;
    }
    if (Date.now() - inspected.modifiedAt < CONSUMER_LOCK_STALE_MS) return true;
    await retireRoutingLockClaim(claimPath);
  }
  return false;
}

async function inspectRoutingLockClaim(
  claimPath: string,
): Promise<{ record?: RoutingLockRecord; modifiedAt: number }> {
  const metadata = await lstat(claimPath);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== DIRECTORY_MODE ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new Error(`Hook routing claim must be a private owned directory: ${claimPath}`);
  }
  let handle;
  try {
    handle = await open(
      path.join(claimPath, "owner.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const ownerMetadata = await handle.stat();
    if (
      !ownerMetadata.isFile() ||
      (ownerMetadata.mode & 0o777) !== FILE_MODE ||
      (typeof process.getuid === "function" && ownerMetadata.uid !== process.getuid())
    ) {
      throw new Error(`Hook routing claim owner must be a private owned file: ${claimPath}`);
    }
    const value = JSON.parse(
      await handle.readFile({ encoding: "utf8" }),
    ) as Partial<RoutingLockRecord>;
    if (
      value.version === 1 &&
      typeof value.token === "string" &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.consumerId === "string" &&
      CONSUMER_ID.test(value.consumerId) &&
      typeof value.createdAt === "string"
    ) {
      return { record: value as RoutingLockRecord, modifiedAt: metadata.mtimeMs };
    }
  } catch (error) {
    if (isNotFound(error)) return { modifiedAt: metadata.mtimeMs };
    if (error instanceof SyntaxError) return { modifiedAt: metadata.mtimeMs };
    throw error;
  } finally {
    await handle?.close();
  }
  return { modifiedAt: metadata.mtimeMs };
}

/** Atomically retires a never-reused claim before removing its private tree. */
async function retireRoutingLockClaim(
  claimPath: string,
  expectedToken?: string,
): Promise<boolean> {
  if (expectedToken) {
    const inspected = await inspectRoutingLockClaim(claimPath).catch((error) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (!inspected || inspected.record?.token !== expectedToken) return false;
  }
  const quarantine = `${claimPath}.retired-${randomUUID()}`;
  try {
    await rename(claimPath, quarantine);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  if (expectedToken) {
    const quarantined = await inspectRoutingLockClaim(quarantine).catch(() => undefined);
    if (quarantined?.record?.token !== expectedToken) {
      throw new Error(`Hook routing claim changed while being retired: ${quarantine}`);
    }
  }
  await rm(quarantine, { recursive: true, force: true });
  await syncDirectory(path.dirname(claimPath));
  return true;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
    );
  }
}

function optionTimestamp(value: number | Date | undefined): number {
  const now = value instanceof Date ? value.getTime() : (value ?? Date.now());
  if (!Number.isSafeInteger(now)) {
    throw new AutomationValidationError("now must be a valid timestamp");
  }
  return now;
}

function assertConsumerLeaseMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAX_CONSUMER_LEASE_MS) {
    throw new AutomationValidationError(
      `consumer lease must be an integer from 1000 to ${MAX_CONSUMER_LEASE_MS} milliseconds`,
    );
  }
  return value;
}

function isPathWithin(workspaceRoot: string, candidate: string): boolean {
  const relative = path.relative(workspaceRoot, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function isWithinWorkspace(workspaceRoot: string, eventCwd: string): Promise<boolean> {
  const canonicalCwd = await canonicalPath(eventCwd, "hook cwd");
  return isPathWithin(workspaceRoot, canonicalCwd);
}

async function canonicalPath(value: string, label: string): Promise<string> {
  const absolute = assertAbsolutePath(path.resolve(value), label);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (isNotFound(error)) return absolute;
    throw error;
  }
}

function toClaim(
  entry: ParsedHookIngressEntry,
  consumerId: string,
  ingressRoot: string,
): HookIngressClaim {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    cwd: entry.cwd,
    input: entry.payload,
    consumerId,
    path: entry.path,
    ingressRoot,
  };
}

function assertClaimPath(claim: HookIngressClaim): string {
  const consumerId = assertConsumerId(claim.consumerId);
  const id = assertEntryId(claim.id);
  const location = locationFromRoot(claim.ingressRoot);
  const expected = path.join(location.claimsPath, consumerId, `${id}.json`);
  if (path.resolve(claim.path) !== expected) {
    throw new AutomationValidationError(`Invalid hook ingress claim path: ${claim.path}`);
  }
  return expected;
}

function locationFromRoot(root: string): HookIngressLocation {
  const absolute = path.resolve(root);
  return {
    root: absolute,
    inboxPath: path.join(absolute, "inbox"),
    claimsPath: path.join(absolute, "claims"),
    consumersPath: path.join(absolute, "consumers"),
    deadLetterPath: path.join(absolute, "dead-letter"),
  };
}

function resolveStateHome(configured: string | undefined): string {
  if (configured !== undefined) {
    if (!path.isAbsolute(configured)) {
      throw new AutomationValidationError("stateHome must be an absolute path");
    }
    return configured;
  }
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && path.isAbsolute(xdg)) return xdg;
  return path.join(os.homedir(), ".local", "state");
}

function defaultConsumerId(workspaceRoot: string): string {
  return `workspace-${createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 32)}`;
}

function assertEntryId(value: unknown): string {
  if (typeof value !== "string" || !ENTRY_ID.test(value)) {
    throw new AutomationValidationError("Invalid hook ingress entry id");
  }
  return value;
}

function assertConsumerId(value: string): string {
  if (!CONSUMER_ID.test(value)) {
    throw new AutomationValidationError(
      "consumerId must contain only letters, numbers, '.', '_', or '-' and be at most 128 characters",
    );
  }
  return value;
}

function assertAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    !path.isAbsolute(value)
  ) {
    throw new AutomationValidationError(
      `${label} must be an absolute path of at most 4096 characters`,
    );
  }
  return path.resolve(value);
}

function assertBoundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new AutomationValidationError(
      `${label} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value;
}

function assertName(value: unknown, label: string): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw new AutomationValidationError(
      `${label} must be a name of at most 128 letters, numbers, '.', '_', ':', '/', or '-'`,
    );
  }
  return value;
}

function assertTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new AutomationValidationError(`${label} must be a valid timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AutomationValidationError(`${label} must be a valid timestamp`);
  }
  return date.toISOString();
}

function assertLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new AutomationValidationError("limit must be an integer from 1 to 10000");
  }
  return value;
}

function assertNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AutomationValidationError(`${label} must be a non-negative integer`);
  }
  return value;
}

function entryTimestamp(id: string): number {
  return Number(id.slice("hook-".length, "hook-".length + 13));
}

function compareEntries(
  left: SerializedHookIngressEntry,
  right: SerializedHookIngressEntry,
): number {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id)
  );
}

function compareClaims(left: HookIngressClaim, right: HookIngressClaim): number {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id)
  );
}

async function removeInboxFile(directory: string, name: string): Promise<boolean> {
  try {
    await rm(path.join(directory, name), { force: false });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is a best-effort durability improvement.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isNoFollowLoop(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP";
}

function isUnsafeEntryTypeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EACCES" || error.code === "EPERM" || error.code === "ENXIO";
}
