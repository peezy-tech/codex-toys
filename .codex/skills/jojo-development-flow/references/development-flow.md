# Jojo Development Flow Reference

## Remotes

```bash
git remote -v
# origin    git@jojo.build:peezy-tech/codex-toys.git
# codeberg  git@codeberg.org:peezy-tech/codex-toys.git
# github    https://github.com/peezy-tech/codex-toys.git
```

`main` should track jojo:

```bash
git branch --set-upstream-to=origin/main main
git status --short --branch
# ## main...origin/main
```

Use jojo for day-to-day work:

```bash
git pull
git push
```

Confirm Codeberg mirror state:

```bash
git ls-remote origin refs/heads/main
git ls-remote codeberg refs/heads/main
```

Use GitHub only to run npm trusted publishing:

```bash
git push github main
gh workflow run publish-codex-toys.yml --repo peezy-tech/codex-toys --ref main -f confirm_package='codex-toys'
```

## Access

Use an operator account with push access to jojo, permission to update the
GitHub publishing mirror, and permission to run the GitHub trusted-publishing
workflow. Local SSH keys, GPG keys, personal account names, signing-key IDs, and
long-lived tokens are machine-specific and should stay outside this repository.

Git signing may be used when configured locally, but this project does not
require checked-in signing-key details.

## Jojo CLI And API Checks

`fj` can talk to `jojo.build` when authenticated:

```bash
fj --host jojo.build auth list
fj --host jojo.build repo view peezy-tech/codex-toys
```

For admin automation, prefer a scoped operator token and keep token material out
of the repository.

## Branch Protection

`main` is protected:

- Owners can push and merge.
- Required status context: `ci / check (push)`.
- Protection applies to admins.
- Signed commits are not required yet.

## Jojo Actions

Workflow file:

```text
.forgejo/workflows/ci.yml
```

The runner label used by CI is `ubuntu-latest`, backed by `node:22-bookworm`. The workflow installs Bun before running checks because the release dry-run needs `npm`.

Current CI gate:

```bash
vp install --frozen-lockfile
vp run check:types
vp run test
vp run release:check
```

## Jojo CLI

```bash
fj --host jojo.build auth add-key <username> <token>
fj --host jojo.build auth use-ssh true
```

Create the organization repo when missing:

```bash
fj --host jojo.build org repo create peezy-tech codex-toys \
  -d "Public monorepo for codex-toys" \
  -S true
```

Verify the repository:

```bash
fj --host jojo.build repo view peezy-tech/codex-toys
git ls-remote origin HEAD refs/heads/main
```

## Package Release Gate

```bash
vp run release:check
vp run check:types
vp run test
git diff --check
```

Verify npm after GitHub Actions publishing:

```bash
npm dist-tag ls codex-toys
npm view codex-toys version repository --json
```

## Current State

- Canonical repo: `https://jojo.build/peezy-tech/codex-toys`
- Codeberg mirror: `https://codeberg.org/peezy-tech/codex-toys`
- GitHub publishing repo: `https://github.com/peezy-tech/codex-toys`
- `origin/main` and `codeberg/main` should stay aligned automatically through the jojo push mirror.
- `github/main` may lag until a release needs npm trusted publishing.
