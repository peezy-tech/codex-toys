# Meka

Meka is a small, private control plane above local coding harnesses. Codex and
Claude Code still own the agent loop, authentication, configuration, sessions,
skills, hooks, MCP servers, and provider-specific behavior. Meka supplies one
stable way for an application or sandbox supervisor to start either harness,
observe its native events, interrupt it, and install provider-native plugins.

```text
application or sandbox supervisor
                 │
       private Unix socket
                 │
          Meka service
                 │
          @meka/sdk
          ┌──────┴──────┐
          │             │
   Codex app-server  Claude Agent SDK
```

The project deliberately has only two product surfaces:

- [`@meka/sdk`](./packages/sdk) is the in-process TypeScript API and contains
  the private Codex and Claude adapters.
- [`@meka/app`](./apps/meka) is the `meka` executable, private-socket service,
  JSON-RPC client, and CLI.

There is no HTTP server, browser client, second microbridge protocol, or example
application to keep in sync. An application can embed the SDK when it shares a
process with the harness, or speak the socket protocol when it needs lifecycle
isolation.

## Why a service above the harnesses?

The service is intentionally thinner than another agent framework. It gives a
supervisor a provider-neutral lifecycle without flattening the useful native
details:

- runs continue if a client disconnects;
- clients can reconnect and replay a bounded event history;
- Codex app-server notifications and Claude Agent SDK messages pass through as
  opaque provider events;
- one daemon owns a fixed working directory and a bounded number of runs;
- plugin installation is serialized per provider; and
- the daemon has one private, uniquely named local endpoint rather than a
  network listener.

Meka does not invent its own thread model. Provider session and run identifiers
are returned alongside the Meka run identifier so consumers can correlate work
with the underlying harness.

Codex stays app-server-native. By default the SDK launches the installed
`codex app-server` over stdio. When `CODEX_WORKSPACE_APP_SERVER_SOCK` is set, it
uses `codex app-server proxy --sock ...` instead, so a sandbox supervisor can
attach Meka to an existing local Codex app-server rather than creating a second
state plane. Claude Code is driven through the Agent SDK and the normally
installed `claude` executable.

Version 1 intentionally does not add provider-specific thread browsing/resume,
a generic hook router, HTTP, or durable run storage. Native IDs and events are
preserved so those capabilities can be added later without replacing the
common run and plugin surface.

## Security model

Meka is built for unattended execution inside sandboxes. Every run receives
full harness permissions:

- Codex: `approvalPolicy: "never"` and `danger-full-access`
- Claude Code: `bypassPermissions` and
  `allowDangerouslySkipPermissions: true`

There is no interactive approval path or reduced-permission mode. The external
sandbox is the security boundary; do not run the service around untrusted input
on an unsandboxed workstation.

Meka resolves Codex command, file-change, and permission server requests in the
permissive direction. User-input requests receive an empty answer, MCP
elicitations are cancelled, current-time requests are handled locally, and
unsupported provider requests receive an immediate JSON-RPC error instead of
stalling an unattended run.

The daemon creates a unique instance directory with mode `0700`, a Unix socket
with mode `0600`, and a small instance metadata file. It never binds TCP. These
filesystem permissions isolate OS users, but any process running as the same
user and able to reach the socket can exercise the daemon's full authority.
Meka currently supports POSIX hosts only.

No cloud-side provider configuration is required. Meka launches the normal
local harnesses with the daemon's environment and home directory, so existing
Codex and Claude Code authentication, configuration, plugins, skills, and hooks
remain in effect.

## Source install and validate

Meka is currently a private, source-first project rather than a
registry-published package. It requires a POSIX host, Node.js 24, pnpm, and at
least one locally installed and authenticated provider harness.

```bash
pnpm install --frozen-lockfile
pnpm run meka -- doctor --cwd "$PWD"
```

`pnpm run meka -- ...` is the supported launcher from this checkout. It builds
the SDK and CLI automatically when their ignored `dist` directories are absent,
so it works in a fresh clone without relying on a stale `node_modules/.bin`
shim. `doctor` starts no provider thread and sends no model prompt; it validates
the local private-socket path, performs a Codex app-server handshake, and checks
Claude's local authentication status. Its JSON report intentionally redacts
account metadata.

For repository validation:

```bash
pnpm run check:types
pnpm test
pnpm run check:dist
pnpm run check:source-install
pnpm run check:package-install
```

`check:package-install` starts with clean build artifacts, packs the SDK and
CLI, installs both archives into an empty temporary consumer, and invokes the
installed `meka --help`. It validates the paired-package artifact without
implying that the private packages are published to a registry.

## Private local archive install

When a source checkout is available but a global command is more convenient,
pack and install both private archives together with npm:

```bash
archive_dir=$(mktemp -d)
pnpm --filter @meka/sdk pack --pack-destination "$archive_dir"
pnpm --filter @meka/app pack --pack-destination "$archive_dir"
npm install --global "$archive_dir"/meka-sdk-*.tgz "$archive_dir"/meka-app-*.tgz

meka doctor --cwd "$PWD"
```

The paired install is deliberate: `@meka/app` depends on the private SDK and
neither package is published to a registry. It gives the installed CLI its
normal `meka` command without changing the project into a public package.

## In-process SDK

```ts
import { Meka } from "@meka/sdk";

const meka = new Meka();
const run = await meka.startRun({
  provider: "codex", // or "claude"
  prompt: "Inspect this repository and fix the failing test.",
  cwd: process.cwd(),
  onEvent: ({ provider, event }) => {
    console.log(provider, event);
  },
});

console.log(run.providerSessionId, await run.done);
await meka.close();
```

The common event envelope contains only `provider` and the opaque native
`event`. Provider-specific data is not translated into a lowest-common-
denominator schema.

Plugins are the shared installation unit. A provider plugin may contain the
skills, hooks, MCP servers, agents, or configuration understood by that
provider:

```ts
await meka.installPlugin({
  provider: "claude",
  plugin: "my-plugin",
  scope: "project",
  cwd: process.cwd(),
});

await meka.installPlugin({
  provider: "codex",
  plugin: "my-plugin",
  remoteMarketplaceName: "internal",
});
```

## Private-socket service

Start one daemon for one trusted workspace from this source checkout:

```bash
pnpm run meka -- serve --cwd "$PWD"
```

Once listening, `meka serve` writes exactly one JSON readiness object to
standard output. It includes `socketPath`, `instanceId`, `pid`, and
`protocolVersion`. A supervisor should capture `socketPath` and pass it to
clients through `MEKA_SOCKET`.

```bash
export MEKA_SOCKET=/path/from/the/readiness/object/m.sock
pnpm run meka -- status
pnpm run meka -- run --provider codex --model gpt-5 "Summarize this repository"
pnpm run meka -- subscribe <run-id> --after 42
pnpm run meka -- interrupt <run-id>
pnpm run meka -- close <run-id>
pnpm run meka -- plugin install --provider claude --scope project my-plugin
```

Every client command also accepts `--socket PATH` instead of `MEKA_SOCKET`.
`meka run` accepts `--provider codex|claude`, an optional `--model`, and the
prompt. `meka subscribe` can resume after an observed event sequence with
`--after N`. Plugin installation exposes only the relevant provider flags:
Claude's `--scope user|project|local`, and Codex's marketplace path or remote
marketplace name.

The socket carries newline-delimited JSON-RPC 2.0. A client must call
`meka.initialize` first. The version 1 method set is:

- `meka.initialize` and `meka.status`
- `run.start`, `run.subscribe`, and `run.unsubscribe`
- `run.interrupt` and `run.close`
- `plugin.install`

Subscribed clients receive `run.event` notifications with a monotonically
increasing sequence number and `run.state` notifications for lifecycle
changes. Replay is bounded; a subscription response reports a gap when the
requested sequence predates retained history. The protocol also bounds frame
size, clients, active runs, in-flight requests, event history, command output,
and client write buffering.

The daemon starting directory is fixed at startup, so socket clients cannot
select a different starting `cwd` for runs or Claude plugin installation.
Codex marketplace paths remain an explicit plugin-install input, and a
full-permission agent can access any path allowed by the daemon process. The
external sandbox—not `cwd`—is the filesystem boundary. State is intentionally
in-memory: stopping the daemon closes its runs and removes its owned runtime
directory.

## Regenerate Codex bindings

The SDK vendors generated TypeScript definitions for the installed Codex
app-server protocol:

```bash
pnpm bindings:generate
git diff -- packages/sdk/src/providers/codex/app-server/generated
pnpm run check:types
pnpm test
```
