---
name: flow-backend-author
description: Use when designing or implementing Codex flow backend adapters, including local host execution, dispatch-only ingress, Convex orchestration, event idempotency, run state, retries, and external worker handoff.
---

# Flow Backend Author

Use this skill for flow backend infrastructure, not individual flow business logic.

## Backend Responsibilities

A backend should provide:

- `dispatch(event)` to accept generic flow events.
- `startRun({ flow, step, event })` to start a matching step.
- `recordStepResult({ runId, step, result })` to persist the outcome.
- `getRun(runId)` for inspection and recovery.

## Backend Kinds

- **Dispatch-only ingress**: accepts or observes external events, persists audit records, and forwards generic flow events. It does not execute long-running steps.
- **Local host execution**: stores events/runs locally and executes Bun or Code Mode steps on the host.
- **Systemd-local execution**: a local host backend supervised by systemd; it may execute steps directly or wrap each step in a transient `systemd-run` unit.
- **Orchestrated remote execution**: stores durable run state in a service, queues executable jobs, and uses external workers or remote app-servers for actual execution.

## Rules

- Treat `event.id` as the idempotency key.
- Make dispatch and result recording safe to retry.
- Keep payload semantics opaque to the backend except for trigger matching and schema validation.
- Do not put organization-specific release/remotes policy into the backend.
- For Code Mode, support either a worker-owned app-server or a configured remote app-server URL.
- Preserve enough run state to resume or inspect `needs_intervention`, `blocked`, and `failed` runs.
