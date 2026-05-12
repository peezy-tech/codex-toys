# Forgejo Development Flow Reference

## Remotes

```bash
git remote -v
# origin    git@jojo.build:peezy-tech/codex-flows.git
# codeberg  git@codeberg.org:peezy-tech/codex-flows.git
# github    https://github.com/peezy-tech/codex-flows.git
```

`main` should track Forgejo:

```bash
git branch --set-upstream-to=origin/main main
git status --short --branch
# ## main...origin/main
```

Use Forgejo for day-to-day work. Forgejo should push-mirror to Codeberg:

```bash
git pull
git push
git ls-remote codeberg refs/heads/main
```

Use GitHub only to run npm trusted publishing:

```bash
git push github main
gh workflow run publish-codex-flows.yml --repo peezy-tech/codex-flows --ref main -f confirm_package='@peezy.tech/codex-flows'
```

## Keys

SSH public key:

```text
~/.ssh/id_ed25519_jojo_build.pub
```

GPG public key:

```text
~/.config/forgejo-keys/matamune-jojo-build-gpg.asc
```

Git signing is expected:

```bash
git config --global commit.gpgsign true
git config --global user.signingkey E3B0D5FB2E5CF11FAFB2EA113BB8E7D3B968A324
```

## Forgejo CLI

`forgejo-cli` is installed as `fj`.

The configured Forgejo login should be visible for `jojo.build`:

```bash
fj --host jojo.build auth list
```

If authentication needs to be recreated:

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

## Current Constructed State

- Forgejo repo: `https://jojo.build/peezy-tech/codex-flows`
- Codeberg mirror: `https://codeberg.org/peezy-tech/codex-flows`
- GitHub publishing repo: `https://github.com/peezy-tech/codex-flows`
- `origin/main`, `codeberg/main`, and `github/main` should be kept aligned for release commits.
