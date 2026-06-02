---
name: jojo-development-flow
description: Use when working in this repository on development flow, remotes, jojo.build operations, Codeberg mirroring, branch tracking, commit signing, jojo Actions, npm trusted publishing, release validation, or publishing codex-toys.
---

# Jojo Development Flow

## Overview

Use `jojo.build` as the canonical development home for `peezy-tech/codex-toys`. Codeberg is a push mirror. GitHub is only for npm trusted publishing.

## Current Structure

- Canonical repo: `https://jojo.build/peezy-tech/codex-toys`
- Git remote `origin`: `git@jojo.build:peezy-tech/codex-toys.git`
- Git remote `codeberg`: `git@codeberg.org:peezy-tech/codex-toys.git`
- Git remote `github`: `https://github.com/peezy-tech/codex-toys.git`
- `main` tracks `origin/main`.
- `jojo.build` push-mirrors `main` to Codeberg.
- GitHub is pushed manually only when npm trusted publishing needs the release workflow.

## Access

Use an operator account with push access to jojo, permission to update the
GitHub publishing mirror, and permission to run the GitHub trusted-publishing
workflow. Do not commit machine-specific SSH keys, GPG keys, personal account
names, or long-lived tokens to this repository.

## Core Rules

- Push normal development to `origin`.
- Do not treat Codeberg as canonical; use it only as a mirror and recovery remote.
- Do not treat GitHub as a development remote.
- Push to GitHub only when the release workflow must publish to npm.
- Do not add npm tokens to the repo or GitHub secrets. GitHub publishes through trusted publishing.
- Publish only the unscoped npm package `codex-toys`. The `@codex-toys/*`
  package scope is reserved for private workspace boundaries bundled into that
  package; do not use `@peezy-tech/codex-toys`.
- Before release work, verify `origin/main` and `codeberg/main` are aligned.
- Keep commits signed when possible, but signed commits are not currently required by branch protection.

## Setup Checks

When asked to set up or verify the repo, check:

```bash
git remote -v
git status --short --branch
ssh -T git@jojo.build
git ls-remote origin refs/heads/main
git ls-remote codeberg refs/heads/main
gpg --list-secret-keys --keyid-format=long
```

Local SSH and Git signing configuration is machine-specific and should be kept
outside the repository.

## Jojo CI

`main` is protected on `jojo.build`.

- Owners can push and merge.
- Required status context: `ci / check (push)`
- The workflow lives at `.forgejo/workflows/ci.yml`.
- The runner is `jojo-build-runner-01`.

The CI workflow runs:

```bash
vp install --frozen-lockfile
vp run check:types
vp run test
vp run release:check
```

## Release Workflow

Normal development:

```bash
git pull
git push
```

Before release, run:

```bash
vp run release:check
vp run check:types
vp run test
git diff --check
```

Then:

1. Bump the public `codex-toys` manifest and keep internal package versions aligned.
2. Commit.
3. Push to jojo: `git push`.
4. Confirm Codeberg mirror has received the commit.
5. Push to GitHub: `git push github main`.
6. Run GitHub workflow `.github/workflows/publish-codex-toys.yml` with `confirm_package=codex-toys`.
7. Verify `npm dist-tag ls codex-toys`.

## References

- Read `references/development-flow.md` for exact setup and command details.
