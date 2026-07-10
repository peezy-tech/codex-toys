# Meka examples

- [`workflows/github-pr-review.ts`](./workflows/github-pr-review.ts) validates a
  GitHub pull-request event, applies repository and author allowlists, and
  enqueues an idempotent Codex review through the `reviews` queue.
- [`workflows/repository-status-command.ts`](./workflows/repository-status-command.ts)
  is a provider-free chain from a JSON command source to an Effect workflow,
  the `commands` queue, and a persisted command result.
- [`workflows/release-notes.ts`](./workflows/release-notes.ts) is a minimal
  provider-free RSS policy paired with the `engineering-feed` source fixture.
- [`sources`](./sources) shows RSS, verified GitHub, and JSON command source
  configuration plus the corresponding CLI flow.
- [`events/github-pull-request-opened.json`](./events/github-pull-request-opened.json)
  is a payload fixture for manual workflow and event-ingress checks.

Replace the illustrative repository and author allowlists before using these
examples. The daemon's fixed workspace—not webhook data—selects the checkout.
Workflow and command files are trusted executable code, not safe containers
for unreviewed third-party snippets. Every managed provider run in these
examples is persisted and admitted through a named queue. Codex or Claude
sessions discovered through installed hooks are separate, informational
observations and do not consume these queue limits; reserve operational
headroom for work started outside Meka.
