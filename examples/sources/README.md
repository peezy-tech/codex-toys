# Source examples

The JSON files here show the durable registration shape for the three built-in
source adapters. They are examples, not secrets files: GitHub configuration
stores the name of an environment variable, while the webhook secret remains
in the ingress process environment.

Start with a bounded review queue and register the workflow:

```bash
meka queue configure reviews \
  --concurrency 2 \
  --window-ms 3600000 \
  --max-starts 20 \
  --lease-ms 300000

meka workflow add ./examples/workflows/github-pr-review.ts
meka workflow list
```

`default` is the built-in workflow-evaluation queue. Every other queue must be
configured explicitly. Queue concurrency and rolling start budgets apply to
every job attempt on that queue, so this example reserves `reviews` for the
provider run enqueued by the workflow.
Externally started Codex or Claude sessions discovered through hooks are
informational and do not debit these limits, so choose limits with enough
headroom for activity outside Meka.

Run state commands from the daemon workspace, or pass the same `--cwd` and
`--state-root` used by `meka serve`. Registration stores configuration and
cursors; it does not start a public listener or an implicit scheduler.

## Exercise policy without a source

Emit a normalized event with a JSON payload on standard input:

```bash
meka event emit github.pull_request \
  --source development-fixture \
  --delivery-id fixture-pr-42 \
  < ./examples/events/github-pull-request-opened.json
```

The fixture is intentionally not marked verified, so the example review
workflow skips it. This demonstrates that `verified` is a policy input rather
than something a caller should grant casually. To test the allowlisted path,
use a correctly signed GitHub delivery through the adapter.

To invoke the workflow directly, pipe the same JSON payload to `workflow run`.
Manual workflow events are trusted local input and are marked verified:

```bash
meka workflow run trusted-github-pr-review \
  < ./examples/events/github-pull-request-opened.json
```

## RSS / Atom

Register the provider-free example workflow, create the source, and invoke one
bounded poll (replace the placeholder URL with a feed you trust):

```bash
meka workflow add ./examples/workflows/release-notes.ts
meka source add rss engineering-feed release-notes \
  --url https://example.com/engineering/feed.xml \
  --event rss.item \
  --timeout-ms 30000

meka source poll engineering-feed
```

Meka sends conditional headers from the durable cursor, deduplicates feed
entry identities, emits `rss.item` events, and persists the next cursor. Cron
or systemd owns the recurrence.

## GitHub webhook

Terminate public HTTPS in an existing ingress service. Preserve the exact body
bytes and pass the GitHub headers to a short-lived local command:

```bash
export GITHUB_WEBHOOK_SECRET='set-outside-the-repository'

meka source add github github-prs trusted-github-pr-review \
  --secret-env GITHUB_WEBHOOK_SECRET \
  --events pull_request

meka source github github-prs \
  --event pull_request \
  --delivery "$GITHUB_DELIVERY" \
  --signature "$GITHUB_SIGNATURE" \
  < webhook-body.json
```

Meka bounds the body, verifies `X-Hub-Signature-256` with HMAC-SHA256, and only
then sets `verified: true`. It does not expose an HTTP port.

## Provider-free command chain

Command sources use a configured argv array and require bounded JSON on
stdout. Options precede `--`; every token after it is preserved as command
argv and is never interpreted by a shell. This complete example routes that
JSON through an Effect workflow and a separate durable command queue, without
starting Codex or Claude:

Start `meka serve --cwd "$PWD"` in one terminal. From a second terminal in the
same workspace, run:

```bash
meka queue configure commands \
  --concurrency 1 \
  --window-ms 60000 \
  --max-starts 10 \
  --lease-ms 60000

meka workflow add ./examples/workflows/repository-status-command.ts \
  --queue default

meka source add command repository-status repository-status-command \
  --event repository.status \
  --timeout-ms 30000 \
  -- node ./examples/sources/repository-status.mjs

meka source run repository-status
meka jobs list --queue commands
meka jobs show COMMAND_JOB_ID
```

[`repository-status.mjs`](./repository-status.mjs) is a small example producer.
Its output becomes the typed payload of `repository.status`.
[`repository-status-command.ts`](../workflows/repository-status-command.ts)
uses `DurableCommand.make` to enqueue the fixed
[`repository-summary.mjs`](../actions/repository-summary.mjs) argv on
`commands`. With `meka serve --cwd "$PWD"` running, the daemon executes both
the workflow job and command job. `jobs show` exposes the terminal command
result under `job.result`, including exit code, stdout, stderr, signal, and
timeout status.

Both source and action commands run in Meka's fixed registered workspace. The
source argv is trusted configuration and must never be derived from an event.
The action executable is fixed in reviewed workflow code; event fields remain
untrusted data even when passed as individual argv entries. Meka does not use
a shell, but the invoked program still runs with the Meka user's authority.

Inspect persisted effects after any source invocation:

```bash
meka jobs list --queue commands
meka source list
meka agents events
```
