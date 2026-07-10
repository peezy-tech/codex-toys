# `@meka/app`

`@meka/app` is the local Meka runtime and `meka` CLI. It owns one trusted
workspace, a private Unix socket, durable SQLite automation state, Effect
workflow execution, named queues, source adapters, and provider runs through
`@meka/sdk`.

From the repository root:

```sh
pnpm run meka -- doctor --cwd /workspace
pnpm run meka -- setup
pnpm run meka -- serve --cwd /workspace
```

`setup` installs the Meka plugin for Codex and Claude Code plus an
ownership-recorded `~/.local/bin/meka` launcher. The plugin includes
operator/workflow skills and best-effort hooks for observing external agent
sessions. Use `meka integration status`, `repair`, or `uninstall` to inspect or
reconcile only the host state recorded as Meka-owned. Setup and repair refuse
to overwrite an unowned or modified launcher. Uninstalling all providers
removes it only when its receipt and content still match; provider-specific
uninstall leaves the shared launcher in place. Codex may require an explicit
hook trust review. Add `~/.local/bin` to `PATH` when `cliShim.onPath` is false.
Without `--provider`, setup installs every available host and reports skipped
CLIs; use `--provider all` when both hosts are required.

The daemon prints one readiness JSON line containing its socket path. Client
commands resolve an explicit `--socket`, then `MEKA_SOCKET`, then the most
specific live daemon for their current directory.

```sh
meka queue configure reviews \
  --concurrency 2 --window-ms 3600000 --max-starts 20 --lease-ms 300000
meka workflow add ./review-pr.ts
meka source add github github-prs review-pr \
  --secret-env GITHUB_WEBHOOK_SECRET --events pull_request
meka source list
meka jobs list --queue reviews
```

Managed agent work is persisted before dispatch. If a lease expires before
external dispatch, it can be recovered; if a provider may already have
accepted the work, Meka marks the job `uncertain` instead of retrying a
possibly side-effecting run.

`default` is the only built-in queue. Every other name must be configured
before workflow registration or enqueue. A rolling start budget counts every
job attempt on that queue, so the example keeps workflow evaluation on
`default` and reserves `reviews` for the provider run it enqueues.

The workflow contract uses stable Effect core (`Effect`, `Schema`, services,
layers, and scoped resources), not the alpha Effect workflow package. Workflow
modules are trusted TypeScript. They validate normalized events and request
durable work; Meka owns persistence, queue admission, and provider dispatch.

The source adapters poll RSS/Atom, verify GitHub webhook bodies supplied on
stdin, and execute configured argv without a shell. Scheduling and public TLS
termination remain outside Meka—there is no HTTP listener.

Codex and Claude hooks write bounded activity envelopes to the private global
inbox under `$XDG_STATE_HOME/meka/hook-ingress` (by default,
`~/.local/state/meka/hook-ingress`), even when no daemon is live. A daemon
claims events emitted from its workspace or descendant directories and records
them as external activity. These observations are informational: they do not
consume queue concurrency or rolling start budgets, so operators must
configure headroom for agent work started outside Meka.

Daemons publish short private routing leases, so the most-specific live
workspace wins when workspaces overlap. Expired claims are recovered, invalid
input becomes a sanitized bounded dead-letter receipt, and stable native
session/event/turn/tool identifiers deduplicate relay retries. Prompt, tool
input, raw error, and raw end-reason content are not persisted. Persisted hook
observations are age- and count-pruned, except routed events still required by
active durable jobs.

State commands use the current directory as their workspace unless `--cwd` is
supplied. Use the same workspace and state root as the daemon. Workflow-managed
runs inherit that fixed workspace; an explicit run-intent `cwd` must resolve to
the exact same directory.

## Trust boundary

The runtime directory is mode `0700` and the socket is mode `0600`. This is an
OS-user boundary, not isolation between mutually hostile processes owned by
the same user. Anyone who can reach the socket can execute a full-permission
coding harness as the daemon user.

Workflow modules are imported in one-shot child processes, but they are
trusted executable TypeScript, not sandboxed code. The fixed `cwd` is only a
starting directory; the external sandbox is the filesystem boundary.
