import type { DatabaseSync } from "node:sqlite";
import { MIN_QUEUE_LEASE_MS } from "./constants.ts";

type Migration = {
  version: number;
  sql: string;
};

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS automation_jobs (
        id TEXT PRIMARY KEY,
        queue_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'leased', 'running', 'succeeded', 'failed', 'canceled', 'uncertain')),
        idempotency_key TEXT,
        idempotency_hash TEXT,
        payload_json TEXT NOT NULL,
        priority INTEGER NOT NULL,
        not_before INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_expires_at INTEGER,
        external_dispatch_started_at INTEGER,
        provider TEXT,
        provider_accepted_at INTEGER,
        provider_reference TEXT,
        result_json TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE UNIQUE INDEX IF NOT EXISTS automation_jobs_idempotency
        ON automation_jobs(queue_name, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS automation_jobs_claim
        ON automation_jobs(queue_name, status, not_before, priority DESC, created_at, id);
      CREATE INDEX IF NOT EXISTS automation_jobs_lease
        ON automation_jobs(status, lease_expires_at);

      CREATE TABLE IF NOT EXISTS automation_job_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES automation_jobs(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('leased', 'running', 'succeeded', 'failed', 'canceled', 'expired', 'uncertain')),
        lease_token TEXT NOT NULL,
        leased_at INTEGER NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        started_at INTEGER,
        external_dispatch_started_at INTEGER,
        provider TEXT,
        provider_accepted_at INTEGER,
        provider_reference TEXT,
        finished_at INTEGER,
        error_json TEXT,
        UNIQUE(job_id, attempt_number),
        UNIQUE(job_id, lease_token)
      );
      CREATE INDEX IF NOT EXISTS automation_job_attempts_window
        ON automation_job_attempts(job_id, leased_at);
      CREATE INDEX IF NOT EXISTS automation_job_attempts_active
        ON automation_job_attempts(job_id, status, lease_expires_at);

      CREATE TABLE IF NOT EXISTS automation_queue_policies (
        queue_name TEXT PRIMARY KEY,
        concurrency INTEGER NOT NULL CHECK(concurrency > 0),
        start_window_ms INTEGER NOT NULL CHECK(start_window_ms > 0),
        max_starts_per_window INTEGER NOT NULL CHECK(max_starts_per_window > 0),
        lease_ms INTEGER NOT NULL CHECK(lease_ms > 0),
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_agent_events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        provider TEXT,
        session_id TEXT,
        event_type TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        UNIQUE(source, source_event_id)
      );
      CREATE INDEX IF NOT EXISTS automation_agent_events_session
        ON automation_agent_events(provider, session_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS automation_agent_events_received
        ON automation_agent_events(received_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS automation_external_sessions (
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'released', 'expired')),
        lease_token TEXT NOT NULL,
        leased_until INTEGER,
        first_event_id TEXT NOT NULL,
        last_event_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        released_at INTEGER,
        PRIMARY KEY(provider, session_id)
      );
      CREATE INDEX IF NOT EXISTS automation_external_sessions_active
        ON automation_external_sessions(state, leased_until);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS automation_workflows (
        id TEXT PRIMARY KEY,
        module_realpath TEXT NOT NULL,
        revision_hash TEXT NOT NULL,
        trigger_types_json TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        queue_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS automation_workflows_enabled
        ON automation_workflows(enabled, queue_name, id);

      CREATE TABLE IF NOT EXISTS automation_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        workflow_id TEXT NOT NULL REFERENCES automation_workflows(id) ON DELETE RESTRICT,
        config_json TEXT NOT NULL,
        cursor_json TEXT,
        dedupe_state_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS automation_sources_enabled
        ON automation_sources(enabled, kind, workflow_id, id);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS automation_workflow_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        delivery_id TEXT,
        dedupe_key TEXT NOT NULL,
        verified INTEGER NOT NULL CHECK(verified IN (0, 1)),
        occurred_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        metadata_json TEXT,
        metadata_hash TEXT,
        UNIQUE(source, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS automation_workflow_events_received
        ON automation_workflow_events(received_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS automation_workflow_events_source_type
        ON automation_workflow_events(source, event_type, received_at DESC);
    `,
  },
  {
    version: 4,
    sql: `
      INSERT OR IGNORE INTO automation_queue_policies(
        queue_name, concurrency, start_window_ms, max_starts_per_window, lease_ms, updated_at
      )
      SELECT queue_name, 1, 60000, 60, 60000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
      FROM (
        SELECT queue_name FROM automation_jobs
        UNION
        SELECT queue_name FROM automation_workflows
      );
    `,
  },
  {
    version: 5,
    sql: `
      UPDATE automation_queue_policies
      SET lease_ms = ${MIN_QUEUE_LEASE_MS},
          updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
      WHERE lease_ms < ${MIN_QUEUE_LEASE_MS};
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE automation_external_sessions ADD COLUMN last_occurred_at INTEGER;
      UPDATE automation_external_sessions
      SET last_occurred_at = COALESCE(
        (SELECT occurred_at FROM automation_agent_events
         WHERE automation_agent_events.id = automation_external_sessions.last_event_id),
        updated_at
      );
    `,
  },
];

const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;
const KNOWN_SCHEMA_VERSIONS = new Set(MIGRATIONS.map((migration) => migration.version));

if (
  KNOWN_SCHEMA_VERSIONS.size !== MIGRATIONS.length ||
  MIGRATIONS.some((migration, index) => migration.version !== index + 1)
) {
  throw new Error("Automation migration catalog must use unique contiguous versions");
}

export function applyAutomationMigrations(database: DatabaseSync): number {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  // Refuse a future schema before journal-mode or DDL changes. An older Meka
  // must never mutate a database whose contract it does not understand.
  assertSupportedSchema(database);
  // SQLite can return BUSY immediately when two brand-new connections both
  // attempt the journal-mode transition, even with busy_timeout configured.
  // Retry this one idempotent first-open operation within the same bound.
  execWithBusyRetry(database, "PRAGMA journal_mode = WAL", 5_000);
  database.exec("PRAGMA synchronous = FULL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS automation_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  database.exec("BEGIN IMMEDIATE");
  try {
    // The version snapshot must be taken after the write lock is acquired.
    // Otherwise two first-open processes can both observe an unapplied
    // migration and race to record it.
    const applied = new Set(
      (
        database.prepare("SELECT version FROM automation_schema_migrations").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version),
    );
    assertSupportedVersions(applied);
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO automation_schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, Date.now());
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return LATEST_SCHEMA_VERSION;
}

function assertSupportedSchema(database: DatabaseSync): void {
  const table = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'automation_schema_migrations'",
    )
    .get() as { present: number } | undefined;
  if (!table) return;
  const rows = database.prepare("SELECT version FROM automation_schema_migrations").all() as Array<{
    version: number;
  }>;
  assertSupportedVersions(new Set(rows.map((row) => row.version)));
}

function assertSupportedVersions(versions: ReadonlySet<number>): void {
  const highest = Math.max(0, ...versions);
  if (highest > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Automation schema version ${highest} is newer than this Meka runtime supports (${LATEST_SCHEMA_VERSION})`,
    );
  }
  for (const version of versions) {
    if (!KNOWN_SCHEMA_VERSIONS.has(version)) {
      throw new Error(`Automation schema contains an unknown migration version: ${version}`);
    }
  }
  for (let version = 1; version <= highest; version += 1) {
    if (!versions.has(version)) {
      throw new Error(`Automation schema migration history is missing version ${version}`);
    }
  }
}

const SQLITE_BUSY_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function execWithBusyRetry(database: DatabaseSync, sql: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      database.exec(sql);
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) {
        throw error;
      }
      Atomics.wait(SQLITE_BUSY_WAIT, 0, 0, Math.min(10, Math.max(1, deadline - Date.now())));
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const metadata = error as Error & { errcode?: number; errstr?: string };
  return (
    metadata.errcode === 5 ||
    metadata.errcode === 6 ||
    metadata.errstr === "database is locked" ||
    /database (?:is locked|table is locked|is busy)/i.test(error.message)
  );
}
