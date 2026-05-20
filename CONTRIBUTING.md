# Contributing

Install dependencies from the repository root:

```bash
bun install
```

Run the checks that match the area you touched. For broad changes, use:

```bash
bun run check:types
bun run test
bun run release:check
```

This is a Bun monorepo. Keep changes scoped to the smallest package, app, flow,
or docs surface that solves the problem:

- `packages/codex-client` owns the public `@peezy.tech/codex-flows` package,
  app-server clients, generated protocol types, workspace helpers, and bundled
  bins.
- `packages/flow-runtime` and `packages/flow-backend-convex` are compatibility
  and backend-library packages while the single-package platform migration
  continues.
- `apps/discord-bridge` and `apps/workspace-voice-gateway` are gateway packages
  that depend on `@peezy.tech/codex-flows`.
- `apps/workspace-backend`, `apps/web`, `apps/cli`, and `apps/flow-runner` are
  workspace-local apps that are also bundled into the core package where
  appropriate.
- `flows` contains bundled flow packages used to maintain Codex bindings and
  Peezy fork releases.
- `docs/pages` is the canonical user documentation.

Generated app-server protocol files live under
`packages/codex-client/src/app-server/generated`. Do not hand-edit generated
types unless you are deliberately repairing a generated update and will
regenerate or document the follow-up.

Release and remote policy lives in `RELEASE.md`: jojo.build is canonical,
Codeberg is a mirror, and GitHub is used for npm trusted publishing.
