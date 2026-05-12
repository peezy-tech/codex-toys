# Jojo Development Flow Reference

## Remotes

```bash
git remote -v
# origin    git@jojo.build:peezy-tech/codex-flows.git
# codeberg  git@codeberg.org:peezy-tech/codex-flows.git
# github    https://github.com/peezy-tech/codex-flows.git
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
gh workflow run publish-codex-flows.yml --repo peezy-tech/codex-flows --ref main -f confirm_package='@peezy.tech/codex-flows'
```

## Accounts

- `peezy`: human site admin, 2FA enabled.
- `matamune`: active development worker account for this host, not a site admin.
- `peezy-tech`: organization containing `codex-flows`.
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
fj --host jojo.build repo view peezy-tech/codex-flows
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
bun install --frozen-lockfile
bun run check:types
bun run test
bun run --filter @peezy.tech/codex-flows release:check
```

## Jojo CLI

```bash
fj --host jojo.build auth add-key matamune <token>
fj --host jojo.build auth use-ssh true
```

Create the organization repo when missing:

```bash
fj --host jojo.build org repo create peezy-tech codex-flows \
  -d "Public monorepo for @peezy.tech/codex-flows" \
  -S true
```

Verify the repository:

```bash
fj --host jojo.build repo view peezy-tech/codex-flows
git ls-remote origin HEAD refs/heads/main
```

## Package Release Gate

```bash
bun run --filter @peezy.tech/codex-flows release:check
bun run check:types
bun run test
git diff --check
```

Verify npm after GitHub Actions publishing:

```bash
npm dist-tag ls @peezy.tech/codex-flows
npm view @peezy.tech/codex-flows version repository --json
```

## Current State

- Canonical repo: `https://jojo.build/peezy-tech/codex-flows`
- Codeberg mirror: `https://codeberg.org/peezy-tech/codex-flows`
- GitHub publishing repo: `https://github.com/peezy-tech/codex-flows`
- `origin/main` and `codeberg/main` should stay aligned automatically through the jojo push mirror.
- `github/main` may lag until a release needs npm trusted publishing.
