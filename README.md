# Meka

Meka is a private, local automation runtime for coding agents. It receives
typed events, evaluates trusted TypeScript workflows, and puts resulting work
through durable named queues before Codex or Claude Code executes it.

Codex and Claude remain the agent runtimes: they own authentication, models,
sessions, tools, skills, and provider-specific behavior. Meka is the control
plane around them—workflow policy, queueing, recovery, and visibility across
both managed runs and agent sessions started outside Meka.

```text
 RSS / Atom       GitHub edge       JSON commands
     │                 │                  │
     └─────────────────┴──────────────────┘
                       │
                 normalized events
                       │
              trusted Effect workflows
                       │
            durable named queues + budgets
                       │
             Codex / Claude Code / jobs

 Codex / Claude hooks ──▶ private global inbox ──▶ observed sessions
                                                  (informational)
```

Meka never opens a public HTTP listener. The daemon exposes a private Unix
socket for a single workspace. RSS polling, webhook ingress, timers, and public
TLS termination stay at a small trusted edge and hand bounded input to Meka.

## Project surfaces

- [`@meka/workflow`](./packages/workflow) is the stable Effect-based contract
  for TypeScript workflows. A workflow validates an event and requests durable
  jobs or queued agent runs; it does not call a provider directly.
- [`@meka/sdk`](./packages/sdk) contains the in-process Codex app-server and
  Claude Agent SDK adapters. Provider-native events stay opaque.
- [`@meka/app`](./apps/meka) is the `meka` executable, durable automation store,
  private-socket daemon, source adapters, workflow child runner, and local
  Codex/Claude integration manager.

This split is deliberate. Meka builds its authoring contract from stable
Effect core primitives—`Effect`, `Schema`, services, layers, and scoped
resources—rather than Effect's alpha workflow package. Effect supplies typed
composition, failures, interruption, and resource safety. Meka supplies the
durable workflow identity, persistence, and queue policy. Codex and Claude
supply the agent loop.

## Install from source

Meka currently installs from a checkout rather than a package registry. It
requires a POSIX host, Node.js 24, pnpm, and at least one locally installed and
authenticated provider harness.

```bash
pnpm install --frozen-lockfile
pnpm run meka -- doctor --cwd "$PWD"
```

`pnpm run meka -- ...` is the supported source launcher. It executes the
TypeScript source directly, so a fresh clone does not depend on stale or
missing build artifacts. `doctor` starts no agent run and sends no prompt; it
checks the private runtime path, performs a Codex app-server handshake, and
checks Claude's local authentication status. Account metadata is redacted.

Install the Meka plugin into both local agent hosts after `doctor` succeeds:

```bash
pnpm run meka -- setup
pnpm run meka -- integration status
```

With no `--provider`, `setup` preflights Codex and Claude and installs every
host CLI that is available; its JSON report lists any skipped provider. Use
`meka setup --provider all` to require both, or select exactly one with
`--provider codex` or `--provider claude`.

`setup` also installs an ownership-recorded launcher at
`~/.local/bin/meka`, so Codex, Claude, and humans can invoke the same CLI from
outside the checkout. Add `~/.local/bin` to `PATH` if the setup report says
`cliShim.onPath` is false.

The plugin gives Codex and Claude a Meka operator skill, an Effect workflow
authoring skill, and local hooks that relay bounded activity events. The
integration manager records what it owns, refuses to overwrite conflicting
marketplace or launcher files, and supports explicit repair and uninstall:

```bash
pnpm run meka -- integration repair
pnpm run meka -- integration uninstall
```

Install and repair never replace an unowned or locally modified
`~/.local/bin/meka`. Uninstalling all providers removes the launcher only when
its ownership receipt and content still match; a conflicting or modified file
is left in place. A provider-specific uninstall leaves the shared launcher
installed for the other host. When a global package manager already provides
that exact path, setup reports `cliShim.state: "external"` and neither claims
nor removes the package-manager symlink.

Provider-native trust still applies. In particular, Codex may ask the user to
review and trust newly installed hooks before it starts invoking them.

Start one daemon for a trusted workspace:

```bash
pnpm run meka -- serve --cwd "$PWD"
```

On startup, `serve` prints one JSON readiness line containing the socket path,
instance ID, PID, and protocol version. Client commands find the most specific
live daemon for their current directory; a supervisor can instead pass an
exact endpoint with `--socket` or `MEKA_SOCKET`.

## TypeScript workflows

A workflow is a normal trusted TypeScript module whose default export comes
from `defineWorkflow`. Its input is an Effect `Schema`, its handler returns an
`Effect`, and all provider work goes through `MekaRuns`:

```ts
import { Effect, MekaRuns, Schema, WorkflowDecision, defineWorkflow } from "@meka/workflow";

const Release = Schema.Struct({
  repository: Schema.String,
  tag: Schema.String,
});

export default defineWorkflow({
  id: "review-release",
  on: "release.published",
  input: Release,
  handler: (event) =>
    Effect.gen(function* () {
      const runs = yield* MekaRuns;
      const job = yield* runs.enqueue({
        queue: "reviews",
        idempotencyKey: `${event.payload.repository}:${event.payload.tag}`,
        intent: {
          _tag: "meka.run",
          provider: "codex",
          prompt: `Review release ${event.payload.tag}`,
        },
      });
      return WorkflowDecision.enqueued([job.id]);
    }),
});
```

See
[`examples/workflows/github-pr-review.ts`](./examples/workflows/github-pr-review.ts)
for a realistic GitHub pull-request allowlist that queues a Codex review.
[`examples/workflows/repository-status-command.ts`](./examples/workflows/repository-status-command.ts)
shows the provider-free path: a command source emits typed JSON, an Effect
workflow builds a validated `DurableCommand`, and the resulting command output
is persisted on the queue job.

Registration imports the module in a one-shot child process, reads its static
ID and triggers, bundles and hashes its local static import graph, and persists
that revision identity. Bare package dependencies and dynamic imports are not
part of this fingerprint; re-register workflows after dependency or lockfile
changes that can alter their behavior.
Execution also happens in a one-shot child. Only durable host operations cross
the IPC boundary. Typed failures, defects, and invalid decisions become
JSON-safe terminal results.

This child boundary protects the long-lived daemon from accidental module
state; it is not a security sandbox. Workflow files are executable code and
must be trusted as fully as the user who starts Meka.

Meka treats entry into a workflow child as an external-dispatch boundary. If
the daemon loses the result, that workflow job becomes `uncertain` instead of
being repeated automatically, because trusted TypeScript could have performed
direct side effects. Workflow authors should still use `DurableJobs` and
`MekaRuns` with idempotency keys instead of direct filesystem, network, or
process effects whenever recovery matters.

## Durable queues and budgets

Managed work is queue-first. Enqueueing commits a job before a worker starts
Codex, Claude, or another side-effecting operation. Meka has one built-in
`default` queue; every other named queue must be explicitly created with
`meka queue configure` before a workflow can use it. Each queue has a durable
policy:

- maximum concurrent leases;
- maximum starts within a rolling time window;
- lease duration and recovery; and
- priority, `notBefore`, and idempotency controls on each job.

Rolling starts count every leased job attempt, including workflow evaluation
jobs as well as provider and command jobs. Keep workflow evaluation on
`default` and use a separate configured queue such as `reviews` when its
budget is intended to describe provider runs. Put both on the same queue only
when the shared budget is deliberate.

`meka queue list` reports pending and active work, remaining concurrency,
rolling starts used and remaining, and the next budget release time when a
window is exhausted. The daemon exposes the same per-queue counters in
`meka status`.

For example, create the queue used by the review workflow above before
registering or running it:

```bash
meka queue configure reviews \
  --concurrency 2 \
  --window-ms 3600000 \
  --max-starts 20 \
  --lease-ms 300000
```

Workflow command actions use `DurableCommand.make({ queue, argv, ... })` and
`DurableJobs.enqueue`. Argv entries must be non-empty, the optional timeout is
positive and capped at 24 hours, and Meka never invokes a shell. Unsupported
job kinds and malformed commands are rejected before durable admission; the
command payload is validated again before external dispatch.

The workspace-scoped SQLite state survives daemon restarts. An expired lease
can be requeued only when Meka knows the provider never accepted the work. If a
worker may have dispatched a side effect—or a provider accepted the run but
the final result is missing—the job becomes `uncertain` and requires operator
reconciliation. Meka never blindly repeats a possibly accepted agent run.

These controls are start budgets, not exact token or billing quotas. Provider
usage can span sessions and change outside Meka; use provider-native accounting
for authoritative cost. Externally started Codex and Claude sessions observed
through hooks do not consume a Meka queue lease or rolling start budget. Their
presence is informational, so configure queue concurrency and budget headroom
for activity that can happen outside Meka.

## Sources and ingress

Meka normalizes source input into an event envelope with a stable event type,
source, observed time, delivery identity, verification flag, metadata, and
JSON payload. The initial adapters are intentionally small:

- **RSS/Atom:** conditional one-shot polling with ETag/Last-Modified cursors and
  bounded delivery deduplication.
- **GitHub webhook:** HMAC-SHA256 verification and normalization of a bounded
  request body supplied by a trusted ingress edge.
- **Command:** a configured executable plus argv, run without a shell; stdout
  must be bounded JSON.

Polling and recurrence are explicit operator concerns. Run a source once from
cron, systemd, a CI job, or another scheduler; Meka owns the durable cursor,
dedupe record, event, workflow decision, and resulting queue work. A public
GitHub endpoint should terminate TLS elsewhere and pipe the original body and
headers into Meka rather than exposing the daemon socket.

Example source configurations and invocation patterns live under
[`examples/sources`](./examples/sources).

## Managed and external agent activity

Runs started through Meka have a durable queue job plus provider-native session
and run identifiers. The private socket still supports live subscription,
bounded replay, interruption, and close:

```bash
pnpm run meka -- status
pnpm run meka -- run --provider codex --queue reviews --model gpt-5 "Summarize this repository"
pnpm run meka -- subscribe <run-id> --after 42
pnpm run meka -- interrupt <run-id>
pnpm run meka -- close <run-id>
```

Use `meka jobs cancel <job-id>` only for work that is still pending. Once a
managed provider run is active, use `meka interrupt <run-id>` so the daemon that
owns the worker aborts it before settling the durable job. Other active workflow
or command workers must be controlled by their owning daemon. Lease tokens are
internal daemon credentials and are not accepted by the direct state CLI.

The installed hooks also tell Meka when a human or another agent launches
Codex or Claude directly. Hooks write atomically to the private, bounded global
inbox under `$XDG_STATE_HOME/meka/hook-ingress` (by default,
`~/.local/state/meka/hook-ingress`); they do not need a daemon or workspace
socket to be live at hook time. A running daemon, or an `agents` CLI command,
claims matching events for its workspace and descendant working directories,
persists them, and acknowledges the inbox entry.

Live daemons publish short private consumer leases. When daemon workspaces
overlap, the most-specific workspace deterministically owns each new event;
claims from an expired or released consumer are returned to the inbox for
recovery. Invalid envelopes are removed to bounded, sanitized dead-letter
receipts so one poison event cannot block later observations. Provider/session,
event, turn, and tool identifiers form the stable deduplication identity.

Those records are `observed_external` activity: useful for operator visibility
and conservative capacity planning, but not proof of exact token usage, cost,
intent, or successful completion. They are not queue jobs and currently debit
neither queue concurrency nor rolling start budgets. Operators should reserve
headroom for external activity themselves. Hook delivery is best effort and
fail-open: an unavailable ingress path must never block the host agent. The
relay records bounded lifecycle metadata and deliberately excludes prompt text
and tool inputs, as well as raw provider error and end-reason text. Persisted
agent observations and their routed workflow-event copies are pruned to bounded
age and count defaults; workflow events still needed by active durable jobs are
retained until those jobs settle.

```bash
meka agents list
meka agents events --limit 20
```

Meka does not replace provider-native sessions or flatten provider events.
Codex app-server notifications and Claude Agent SDK messages remain opaque and
are correlated through their native IDs.

Socket traffic is newline-delimited JSON-RPC 2.0 with an initialization
handshake. Runs outlive a disconnected client; subscriptions can reconnect and
replay bounded event history by sequence number. The runtime bounds frame size,
clients, active runs, in-flight requests, retained events, command output, and
client write buffering.

Generic provider plugins remain available independently of Meka's own bridge:

```bash
meka plugin install --provider claude --scope project my-plugin
meka plugin install --provider codex --remote-marketplace-name internal my-plugin
```

## Security and trust

Meka is designed for unattended execution inside a sandbox. Managed runs use
full harness permissions:

- Codex: `approvalPolicy: "never"` and `danger-full-access`
- Claude Code: `bypassPermissions` and
  `allowDangerouslySkipPermissions: true`

There is no interactive approval mode. The external sandbox is the security
boundary. Do not feed untrusted prompts, workflows, commands, or webhook
configuration into an unsandboxed workstation.

The daemon creates a unique instance directory with mode `0700`, a Unix socket
with mode `0600`, and private metadata. It never binds TCP. These permissions
isolate OS users, but any process running as the same user and able to reach
the socket can exercise the daemon's authority. Meka supports POSIX hosts only.

Source-specific safeguards do not make workflow code safe: GitHub signatures
authenticate delivery, RSS is unverified remote input, and command sources
avoid shell interpolation but still execute the configured program. Validate
every payload with `Schema` before applying policy. Keep secrets out of event
payloads and workflow logs.

RSS URLs and redirects are trusted operator configuration, not an SSRF
boundary; do not let event payloads or untrusted users choose them. GitHub
secrets are referenced by environment-variable name and are never stored in a
source registration.

No cloud-side provider configuration is required. Meka uses the daemon user's
normal Codex and Claude authentication, configuration, plugins, skills, and
hooks. Integration uninstall removes only unchanged state recorded as
Meka-owned, including the shared CLI launcher when all providers are selected.

## Private local archive install

For a machine-local global command, pack and install the three linked archives
together:

```bash
archive_dir=$(mktemp -d)
pnpm --filter @meka/workflow pack --pack-destination "$archive_dir"
pnpm --filter @meka/sdk pack --pack-destination "$archive_dir"
pnpm --filter @meka/app pack --pack-destination "$archive_dir"
npm install --global \
  "$archive_dir"/meka-workflow-*.tgz \
  "$archive_dir"/meka-sdk-*.tgz \
  "$archive_dir"/meka-app-*.tgz

meka doctor --cwd "$PWD"
meka setup
```

The linked install is deliberate: the app depends on the workflow and SDK
packages, and the private packages are not assumed to exist in a registry.

## In-process SDK

Applications that share a process with the harness can use the provider
adapter directly:

```ts
import { Meka } from "@meka/sdk";

const meka = new Meka();
const run = await meka.startRun({
  provider: "codex",
  prompt: "Inspect this repository and fix the failing test.",
  cwd: process.cwd(),
  onEvent: ({ provider, event }) => console.log(provider, event),
});

console.log(run.providerSessionId, await run.done);
await meka.close();
```

This API bypasses durable workflow queueing by design. Use the runtime's
managed-run path for automation that needs budgets, recovery, and idempotency.

Managed runs execute in the daemon's fixed workspace. A workflow may omit
`intent.cwd` to use it; if supplied, the path must resolve to exactly the
daemon's `--cwd`. Event data can never select a different working directory.

Codex stays app-server-native. By default the SDK launches `codex app-server`
over stdio. With `CODEX_WORKSPACE_APP_SERVER_SOCK`, it uses
`codex app-server proxy --sock ...` and attaches to an existing local server.
Claude is driven through the Agent SDK and the installed `claude` executable.

## Validate the repository

```bash
pnpm run check:types
pnpm test
pnpm run check:dist
pnpm run check:source-install
pnpm run check:package-install
```

The package-install check starts from clean build artifacts, packs all linked
packages, installs them into an empty consumer, verifies the integration
assets, imports the workflow authoring API, registers a TypeScript workflow
outside the install tree, starts the installed daemon, and proves that workflow
can enqueue and complete a durable command on a configured named queue. It
validates a local artifact set without implying registry publication.

## Regenerate Codex bindings

```bash
pnpm bindings:generate
git diff -- packages/sdk/src/providers/codex/app-server/generated
pnpm run check:types
pnpm test
```
