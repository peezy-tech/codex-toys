# Contributing

Install dependencies and run the checks before submitting changes:

```bash
bun install
bun run build
bun run test
```

Keep changes scoped to the bare package set:

- `apps/web`
- `packages/codex-client`
- `packages/ui`

Avoid reintroducing service, workspace backend, job, or host setup code on this
branch.
