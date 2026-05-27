# Contributing

Install dependencies from the repository root:

```bash
vp install
```

Run the checks that match the area you touched. For broad changes, use:

```bash
vp run check:types
vp run test
vp run release:check
```

Pull requests get a lightweight `pr-policy` check first. That check runs from
trusted target-branch code with `pull_request_target` and does not check out or
execute PR code. Full CI runs through the `trusted-ci` workflow after a
maintainer applies the `ci:run-full` label; if a PR gets new commits, remove
and reapply that label to approve another run for the new head. PRs that change
`.forgejo/workflows` need the maintainer-applied `ci:reviewed-workflow` label
before the policy check passes.

This is a Node 24 + pnpm + VitePlus monorepo. Keep changes scoped to the smallest package, app, flow,
or docs surface that solves the problem:

- `packages/codex-client` owns the public `@peezy.tech/codex-flows` package,
  app-server clients, generated protocol types, workspace helpers, and bundled
  bins.
- `apps/workspace-backend` owns the runnable local workspace backend app that is
  bundled into the core package.
- Discord gateway integrations are extracted from the main monorepo lifecycle.
  Keep shared runtime surfaces in `@peezy.tech/codex-flows`; channel-specific
  packages should live in their own repository and depend on the published core
  package.
- `docs/pages` is the canonical user documentation.

Generated app-server protocol files live under
`packages/codex-client/src/app-server/generated`. Do not hand-edit generated
types unless you are deliberately repairing a generated update and will
regenerate or document the follow-up.

Release and remote policy lives in `RELEASE.md`: jojo.build is canonical,
Codeberg is a mirror, and GitHub is used for npm trusted publishing.
