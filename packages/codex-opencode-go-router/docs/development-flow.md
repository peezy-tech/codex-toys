# Development Flow

`@peezy.tech/codex-opencode-go-router` is developed inside the
`codex-flows` monorepo. Continue normal development through the monorepo's
canonical jojo remote; Codeberg remains the monorepo mirror, and GitHub is used
only for the monorepo's npm trusted publishing workflow.

## Verify

Run the package-local checks:

```bash
vp run --filter @peezy.tech/codex-opencode-go-router check
vp run --filter @peezy.tech/codex-opencode-go-router test
```

Run the monorepo gates that include this package:

```bash
vp run check:types
vp run test
git diff --check
```

## Publishing

This package is private and is not part of the public npm release set. Do not
add it to the GitHub publish workflow unless the package is intentionally made
public later.
