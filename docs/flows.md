# Flows

Flows are packaged automation units. They are discovered from `.codex/flows/*`
first and then `flows/*`, with the installed `.codex` copy taking precedence.

Each flow has:

```text
flow.toml
schemas/*.schema.json
exec/*
```

`flow.toml` is the manifest. Use `flow` naming consistently:

```toml
name = "example-flow"
version = 1
description = "Short operational purpose."

[config]
commit = true

[[steps]]
name = "do-work"
runner = "bun"
script = "exec/do-work.ts"
timeout_ms = 300000

[steps.trigger]
type = "upstream.release"
schema = "schemas/upstream-release.schema.json"
```

The runtime passes a generic event to every step:

```ts
type FlowEvent<T = unknown> = {
  id: string;
  type: string;
  source?: string;
  occurredAt?: string;
  receivedAt: string;
  payload: T;
};
```

Domain payload types live in each flow package as JSON Schema files and are
referenced by `steps.trigger.schema`.

## Runners

`runner = "bun"` executes the script directly with Bun. The step receives JSON
on stdin:

```json
{
  "flow": {
    "name": "example-flow",
    "version": 1,
    "root": "/repo/flows/example-flow",
    "step": "do-work",
    "config": {},
    "event": {}
  }
}
```

The script must print a final line beginning with `FLOW_RESULT ` followed by
JSON.

`runner = "code-mode"` starts a Codex app-server and calls the fork-only
`thread/codeMode/execute` method through a raw JSON-RPC request. Code Mode code
is present on `main`, but execution is disabled unless codex-flows is set to
Code Mode:

```bash
CODEX_FLOWS_MODE=code-mode
```

That single mode setting also makes stdio app-server launches default to
`bunx @peezy.tech/codex`. Set `CODEX_APP_SERVER_CODEX_COMMAND` when Code Mode
should run against a specific local binary instead, or
`CODEX_APP_SERVER_CODEX_PACKAGE` when it should use a different npm package.
The older `CODEX_FLOWS_ENABLE_CODE_MODE=1` gate is still accepted as a narrow
runner-only escape hatch.

## Commands

List flows:

```bash
bun run flow list
```

Fire all matching steps for an event:

```bash
bun run flow fire --event event.json
```

Run one step:

```bash
bun run flow run openai-codex-bindings regenerate-bindings --event event.json
```

## Systemd-Local Backend

`codex-flow-systemd-local` is the first execution backend. Patch posts
generic `FlowEvent` JSON to this service; the service persists events and runs
to SQLite, discovers matching flow steps, and starts each step locally.

Run it directly:

```bash
bun run flow:backend serve --cwd /home/peezy/codex-flows-public
```

Useful environment:

```bash
CODEX_FLOW_BACKEND_HOST=127.0.0.1
CODEX_FLOW_BACKEND_PORT=7345
CODEX_FLOW_BACKEND_DATA_DIR=/var/lib/codex-flow-systemd-local
CODEX_FLOW_BACKEND_SECRET=shared-hmac-secret
CODEX_FLOW_BACKEND_EXECUTOR=direct
```

`CODEX_FLOW_BACKEND_EXECUTOR=systemd-run` wraps each step in a transient
`systemd-run --user --wait --collect` unit. The default `direct` executor is
still suitable when the backend service itself is managed by systemd.

Endpoints:

- `POST /events` or `POST /flow-events`: accept one `FlowEvent`
- `GET /events?limit=<n>`: list stored events
- `GET /events/<event-id>`: inspect a stored event and its runs
- `POST /events/<event-id>/replay`: start a new run attempt for a stored event
- `GET /runs?eventId=<id>&status=<status>&limit=<n>`: inspect recorded runs
- `GET /runs/<run-id>`: inspect one recorded run
- `GET /healthz`: health check

When `CODEX_FLOW_BACKEND_SECRET` is configured, HTTP dispatches must include an
HMAC SHA-256 body signature. The preferred header is `x-flow-signature-256`;
`x-patch-flow-signature-256` is also accepted for Patch dispatches.

The CLI exposes the same operational surface:

```bash
bun run flow:backend list-events --limit 20
bun run flow:backend show-event 'patch:source:entry:upstream.release'
bun run flow:backend list-runs --status failed --limit 20
bun run flow:backend show-run run_abc123
bun run flow:backend replay-event 'patch:source:entry:upstream.release' --wait
```

Normal dispatch is idempotent by `event.id`: a duplicate `POST /events` returns
the existing run ids and does not start another attempt. `replay-event` and
`POST /events/<event-id>/replay` intentionally create a new run attempt for the
stored event, which is the recovery path for accepted events whose flow step
failed or blocked.

The live backend state is a SQLite database under
`CODEX_FLOW_BACKEND_DATA_DIR` plus per-event JSON files under
`CODEX_FLOW_BACKEND_DATA_DIR/events`. Back up both by copying the whole data
directory while the service is stopped, or by using SQLite online backup plus a
copy of the `events/` directory. For the current host deployment the intended
values are:

```text
CODEX_FLOW_BACKEND_CWD=/home/peezy/codex-flows-public
CODEX_FLOW_BACKEND_DATA_DIR=/home/peezy/.local/state/codex-flow-systemd-local
CODEX_FLOWS_MODE=code-mode
CODEX_FLOW_PUSH=1
CODEX_FLOW_PUBLISH=1
PEEZY_CODEX_REPO=/home/peezy/codex-flow-worktrees/codex
PEEZY_CODEX_TARGET_BRANCH=code-mode-exec-hooks
```

Do not fabricate an upstream Codex release lifecycle test. Until the next real
`openai/codex` release, use health checks, non-release smoke events, and stored
event inspection/replay tooling only.

## Convex Backend Direction

Convex should be a durable orchestration backend, not the place where long
running Codex or shell work executes. A future Convex backend should:

- accept the same generic `FlowEvent` shape
- persist event, run, step, retry, and result records durably
- choose matching flow steps from a stored or installed flow manifest
- lease work to an external worker or remote app-server
- receive heartbeats and final `FLOW_RESULT` records from that worker
- expose programmatic fire/retry/cancel APIs

This keeps Patch dispatch-only, keeps Convex durable, and keeps process-heavy
work on infrastructure that can run Codex, Bun, Git, Cargo, and system tools.

The reusable component package now lives at
`packages/flow-backend-convex`. It owns only generic flow control-plane state:
synced manifests, events, runs, attempts, leases, compact output events, and
final results. Installing apps should expose their own service-authenticated
wrapper functions and keep domain-specific completion in app code. For example,
the 2D pet game keeps asset registration, payment state, and minting outside the
generic backend.

The first component version stores readable progress chunks in
`flowOutputEvents`. If durable long-form transcripts become important, add
`@convex-dev/persistent-text-streaming` as a child component and attach a stream
id to each run attempt; canonical run state should remain in the flow backend
tables.

## Codex Release Flows

The upstream `openai/codex` release event fans out to two flow packages:

- `openai-codex-bindings`: Bun runner. Uses canonical `@openai/codex@version`,
  regenerates `@peezy.tech/codex-flows` app-server bindings, runs checks,
  commits when changed, and can push/trigger trusted publishing when configured.
- `peezy-codex-fork`: Code Mode runner. Rebases the Peezy fork patch stack onto
  the upstream release tag, optionally squashes the patch stack, verifies the
  fork, and can push/tag to trigger the fork release flow when configured.

Publishing is controlled by flow config and environment. The packaged defaults
commit local changes when appropriate but do not push or publish until
`push = true`, `publish = true`, or matching `CODEX_FLOW_PUSH=1` /
`CODEX_FLOW_PUBLISH=1` deployment configuration is set.
