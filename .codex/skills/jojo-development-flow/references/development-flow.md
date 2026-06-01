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
gh workflow run publish-codex-toys.yml --repo peezy-tech/codex-toys --ref main -f confirm_package='publish-codex-toys-packages'
```

## Accounts

- `peezy`: human site admin, 2FA enabled.
- `matamune`: active development worker account for this host, not a site admin.
- `peezy-tech`: organization containing `codex-toys`.
- `load-game`: organization containing both `peezy` and `matamune`.

## Keys

Host SSH public key:

```text
~/.config/forgejo-keys/matamune-jojo-build-ssh.pub
```

Host GPG public key:

```text
~/.config/forgejo-keys/matamune-jojo-build-gpg.asc
```

Codeberg SSH key still exists for direct mirror diagnostics:

```text
~/.ssh/id_ed25519_codeberg.pub
```

Git signing is expected:

```bash
git config --global commit.gpgsign true
git config --global user.signingkey E3B0D5FB2E5CF11FAFB2EA113BB8E7D3B968A324
```

## Jojo CLI And API Checks

`fj` can talk to `jojo.build` when authenticated:

```bash
fj --host jojo.build auth list
fj --host jojo.build repo view peezy-tech/codex-toys
```

For admin automation, prefer a scoped `peezy` token. The old bootstrap `matamune` setup token should not be treated as the long-term admin credential.

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
fj --host jojo.build auth add-key matamune <token>
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
pnpm exec tsx scripts/check-publish-metadata.ts
vp run release:check
vp run check:types
vp run test
git diff --check
```

Verify npm after GitHub Actions publishing:

```bash
npm dist-tag ls codex-toys
npm dist-tag ls @codex-toys/bridge
npm view codex-toys version repository --json
```

## Current State

- Canonical repo: `https://jojo.build/peezy-tech/codex-toys`
- Codeberg mirror: `https://codeberg.org/peezy-tech/codex-toys`
- GitHub publishing repo: `https://github.com/peezy-tech/codex-toys`
- `origin/main` and `codeberg/main` should stay aligned automatically through the jojo push mirror.
- `github/main` may lag until a release needs npm trusted publishing.
