---
name: codeberg-development-flow
description: Use when working in this repository on development flow, remotes, Forgejo or Codeberg CLI operations, Forgejo repo creation, branch tracking, commit signing, mirroring, npm trusted publishing, release validation, or publishing @peezy.tech/codex-flows.
---

# Forgejo Development Flow

## Overview

Use Forgejo at `jojo.build` as the primary development forge. Keep Codeberg as a push mirror. Keep GitHub for npm trusted publishing only.

## Core Rules

- Treat `origin` as Forgejo: `git@jojo.build:peezy-tech/codex-flows.git`.
- Treat `codeberg` as the Codeberg mirror: `git@codeberg.org:peezy-tech/codex-flows.git`.
- Treat `github` as the GitHub publishing remote: `https://github.com/peezy-tech/codex-flows.git`.
- Keep `main` tracking `origin/main`, not `github/main`.
- Push normal development to Forgejo.
- Configure Forgejo to push-mirror to Codeberg.
- Push to GitHub only when the release workflow must publish to npm.
- Do not add npm tokens to the repo or GitHub secrets. GitHub publishes through trusted publishing.
- Use package name `@peezy.tech/codex-flows`, not `@peezy-tech/codex-flows`.

## Setup Checks

When asked to set up or verify the repo, check:

```bash
git remote -v
ssh -T git@jojo.build
fj --host jojo.build auth list
gpg --list-secret-keys --keyid-format=long
git status --short --branch
```

Expected local key files:

```text
~/.ssh/id_ed25519_jojo_build.pub
~/.config/forgejo-keys/matamune-jojo-build-gpg.asc
```

## Release Workflow

Normal development:

```bash
git pull
git push
```

Before release, run:

```bash
bun run --filter @peezy.tech/codex-flows release:check
bun run check:types
bun run test
git diff --check
```

Then:

1. Bump `packages/codex-client/package.json`.
2. Commit.
3. Push to Forgejo: `git push`.
4. Confirm Codeberg mirror has received the commit.
5. Push to GitHub: `git push github main`.
6. Run GitHub workflow `.github/workflows/publish-codex-flows.yml` with `confirm_package=@peezy.tech/codex-flows`.
6. Verify `npm dist-tag ls @peezy.tech/codex-flows`.

## References

- Read `references/development-flow.md` for exact setup and command details.
