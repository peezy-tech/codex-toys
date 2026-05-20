import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FlowEvent } from "@peezy.tech/codex-flows/flow-runtime";

export type FlowRunStatus = "queued" | "running" | "completed" | "failed";

export type FlowRunRecord = {
	id: string;
	eventId: string;
	flowName: string;
	stepName: string;
	status: FlowRunStatus;
	backend: "workspace-local";
	executor: string;
	unit?: string;
	eventPath: string;
	commandJson?: string;
	resultJson?: string;
	stdout?: string;
	stderr?: string;
	error?: string;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
};

export type FlowEventRecord = {
	id: string;
	type: string;
	source?: string;
	occurredAt?: string;
	receivedAt: string;
	payload: Record<string, unknown>;
	raw: FlowEvent;
	createdAt: string;
};

export type ListRunsOptions = {
	eventId?: string;
	status?: FlowRunStatus;
	limit?: number;
};

export type ListEventsOptions = {
	type?: string;
	limit?: number;
};

export class FlowBackendStore {
	readonly dbPath: string;
	#db: DatabaseSync;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
		mkdirSync(path.dirname(dbPath), { recursive: true });
		this.#db = new DatabaseSync(dbPath);
		this.#db.exec(`
			create table if not exists flow_events (
				id text primary key,
				type text not null,
				source text,
				occurred_at text,
				received_at text not null,
				payload_json text not null,
				raw_json text not null,
				created_at text not null
			);
			create table if not exists flow_runs (
				id text primary key,
				event_id text not null,
				flow_name text not null,
				step_name text not null,
				status text not null,
				backend text not null,
				executor text not null,
				unit text,
				event_path text not null,
				command_json text,
				result_json text,
				stdout text,
				stderr text,
				error text,
				created_at text not null,
				started_at text,
				completed_at text
			);
			create index if not exists flow_runs_event_id_idx on flow_runs(event_id);
			create index if not exists flow_runs_status_idx on flow_runs(status);
			create index if not exists flow_events_type_idx on flow_events(type);
		`);
	}

	insertEvent(event: FlowEvent): boolean {
		const result = this.#db
			.prepare(
				`insert or ignore into flow_events
					(id, type, source, occurred_at, received_at, payload_json, raw_json, created_at)
					values ($id, $type, $source, $occurredAt, $receivedAt, $payloadJson, $rawJson, $createdAt)`,
			)
			.run({
				$id: event.id,
				$type: event.type,
				$source: event.source ?? null,
				$occurredAt: event.occurredAt ?? null,
				$receivedAt: event.receivedAt,
				$payloadJson: JSON.stringify(event.payload),
				$rawJson: JSON.stringify(event),
				$createdAt: new Date().toISOString(),
			});
		return result.changes > 0;
	}

	createRun(record: FlowRunRecord): void {
		this.#db
			.prepare(
				`insert into flow_runs
					(id, event_id, flow_name, step_name, status, backend, executor, unit, event_path,
						command_json, result_json, stdout, stderr, error, created_at, started_at, completed_at)
					values
					($id, $eventId, $flowName, $stepName, $status, $backend, $executor, $unit, $eventPath,
						$commandJson, $resultJson, $stdout, $stderr, $error, $createdAt, $startedAt, $completedAt)`,
			)
			.run(runParams(record));
	}

	markRunRunning(id: string, commandJson: string, unit?: string): void {
		this.#db
			.prepare(
				`update flow_runs
					set status = 'running', started_at = $startedAt, command_json = $commandJson, unit = $unit
					where id = $id`,
			)
			.run({
				$id: id,
				$startedAt: new Date().toISOString(),
				$commandJson: commandJson,
				$unit: unit ?? null,
			});
	}

	markRunCompleted(id: string, values: { status: FlowRunStatus; resultJson?: string; stdout: string; stderr: string; error?: string }): void {
		this.#db
			.prepare(
				`update flow_runs
					set status = $status, completed_at = $completedAt, result_json = $resultJson,
						stdout = $stdout, stderr = $stderr, error = $error
					where id = $id`,
			)
			.run({
				$id: id,
				$status: values.status,
				$completedAt: new Date().toISOString(),
				$resultJson: values.resultJson ?? null,
				$stdout: values.stdout,
				$stderr: values.stderr,
				$error: values.error ?? null,
			});
	}

	listRunsByEvent(eventId: string): FlowRunRecord[] {
		return this.listRuns({ eventId, limit: 1_000 });
	}

	listRuns(options: ListRunsOptions = {}): FlowRunRecord[] {
		const clauses: string[] = [];
		const params: Record<string, string | number> = {
			$limit: clampLimit(options.limit),
		};
		if (options.eventId) {
			clauses.push("event_id = $eventId");
			params.$eventId = options.eventId;
		}
		if (options.status) {
			clauses.push("status = $status");
			params.$status = options.status;
		}
		const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
		return this.#db
			.prepare(`select * from flow_runs ${where} order by created_at desc, id desc limit $limit`)
			.all(params)
			.map(rowToRunRecord);
	}

	getRun(id: string): FlowRunRecord | undefined {
		const row = this.#db.prepare("select * from flow_runs where id = $id").get({ $id: id });
		return row ? rowToRunRecord(row) : undefined;
	}

	listEvents(options: ListEventsOptions = {}): FlowEventRecord[] {
		const clauses: string[] = [];
		const params: Record<string, string | number> = {
			$limit: clampLimit(options.limit),
		};
		if (options.type) {
			clauses.push("type = $type");
			params.$type = options.type;
		}
		const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
		return this.#db
			.prepare(`select * from flow_events ${where} order by created_at desc, id desc limit $limit`)
			.all(params)
			.map(rowToEventRecord);
	}

	getEvent(id: string): FlowEventRecord | undefined {
		const row = this.#db.prepare("select * from flow_events where id = $id").get({ $id: id });
		return row ? rowToEventRecord(row) : undefined;
	}

	close(): void {
		this.#db.close();
	}
}

function clampLimit(value: number | undefined): number {
	if (!value || !Number.isFinite(value)) {
		return 50;
	}
	return Math.max(1, Math.min(500, Math.trunc(value)));
}

function runParams(record: FlowRunRecord): Record<string, string | null> {
	return {
		$id: record.id,
		$eventId: record.eventId,
		$flowName: record.flowName,
		$stepName: record.stepName,
		$status: record.status,
		$backend: record.backend,
		$executor: record.executor,
		$unit: record.unit ?? null,
		$eventPath: record.eventPath,
		$commandJson: record.commandJson ?? null,
		$resultJson: record.resultJson ?? null,
		$stdout: record.stdout ?? null,
		$stderr: record.stderr ?? null,
		$error: record.error ?? null,
		$createdAt: record.createdAt,
		$startedAt: record.startedAt ?? null,
		$completedAt: record.completedAt ?? null,
	};
}

function rowToRunRecord(row: unknown): FlowRunRecord {
	if (!isRecord(row)) {
		throw new Error("invalid run row");
	}
	return {
		id: String(row.id),
		eventId: String(row.event_id),
		flowName: String(row.flow_name),
		stepName: String(row.step_name),
		status: String(row.status) as FlowRunStatus,
		backend: "workspace-local",
		executor: String(row.executor),
		...(typeof row.unit === "string" ? { unit: row.unit } : {}),
		eventPath: String(row.event_path),
		...(typeof row.command_json === "string" ? { commandJson: row.command_json } : {}),
		...(typeof row.result_json === "string" ? { resultJson: row.result_json } : {}),
		...(typeof row.stdout === "string" ? { stdout: row.stdout } : {}),
		...(typeof row.stderr === "string" ? { stderr: row.stderr } : {}),
		...(typeof row.error === "string" ? { error: row.error } : {}),
		createdAt: String(row.created_at),
		...(typeof row.started_at === "string" ? { startedAt: row.started_at } : {}),
		...(typeof row.completed_at === "string" ? { completedAt: row.completed_at } : {}),
	};
}

function rowToEventRecord(row: unknown): FlowEventRecord {
	if (!isRecord(row)) {
		throw new Error("invalid event row");
	}
	const payload = JSON.parse(String(row.payload_json)) as unknown;
	const raw = JSON.parse(String(row.raw_json)) as unknown;
	if (!isRecord(payload) || !isRecord(raw)) {
		throw new Error("invalid event json");
	}
	return {
		id: String(row.id),
		type: String(row.type),
		...(typeof row.source === "string" ? { source: row.source } : {}),
		...(typeof row.occurred_at === "string" ? { occurredAt: row.occurred_at } : {}),
		receivedAt: String(row.received_at),
		payload,
		raw: raw as FlowEvent,
		createdAt: String(row.created_at),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
