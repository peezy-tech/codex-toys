# Development Flow

This monorepo is developed on jojo at `jojo.build`. Codeberg is a push mirror, and GitHub is used only when npm trusted publishing needs its workflow.

## Remotes

Use jojo as the normal development remote:

```bash
git remote -v
# origin    git@jojo.build:peezy-tech/codex-toys.git
# codeberg  git@codeberg.org:peezy-tech/codex-toys.git
# github    https://github.com/peezy-tech/codex-toys.git
```

Push ordinary development to jojo:

```bash
git push origin main
```

`jojo.build` push-mirrors `main` to Codeberg. The local `codeberg` remote is kept for diagnostics and manual recovery.

Push to GitHub only when a release needs the trusted publishing workflow:

```bash
git push github main
```

## Accounts

- `peezy` is the human site admin account and has 2FA enabled.
- `matamune` is an active development worker account for this host and is not a site admin.
- Both accounts are Owners in `peezy-tech`.

## Machine Keys

This host uses a dedicated jojo SSH key and GPG key:

```text
~/.config/forgejo-keys/matamune-jojo-build-ssh.pub
~/.config/forgejo-keys/matamune-jojo-build-gpg.asc
```

The Codeberg key remains available for mirror diagnostics:

```text
~/.ssh/id_ed25519_codeberg.pub
```

## Jojo CLI

`fj` can talk to `jojo.build` after creating an application token:

```bash
fj --host jojo.build auth add-key <username> <token>
fj --host jojo.build auth use-ssh true
fj --host jojo.build auth list
```

## CI And Branch Protection

`main` is protected on `jojo.build`.

- Owners can push and merge.
- Required status context: `ci / check (push)`.
- The workflow lives at `.forgejo/workflows/ci.yml`.
- Protection applies to admins.
- Signed commits are not required yet.

The CI workflow runs:

```bash
vp install --frozen-lockfile
vp run check:types
vp run test
vp run release:check
```

## Releases

Canonical user-facing package:

- `codex-toys`

The GitHub publish workflow checks whether each package version already exists
on npm. It publishes a new `codex-toys` version and skips versions
that are already present. Published packages are packed with `pnpm pack` and
then handed to `npm publish` so workspace and catalog dependency specifiers are
converted before the npm registry sees the package while GitHub provenance still
comes from npm.
Version numbers intentionally track the upstream Codex release line rather than
strict semantic-versioning meaning. For example, if the current Codex-aligned
line is `0.132.x`, a breaking codex-toys stack release should usually advance
to `0.132.1` rather than `0.133.0`.

New public core runtime surfaces should be exported through
`codex-toys` first, including reusable protocol helpers and
runnable local backend bins. Product- or channel-specific gateways, such as
Discord text or voice packages, should publish separately and depend on
`codex-toys` from their own repositories.

Before publishing:

```bash
pnpm exec tsx scripts/check-publish-metadata.ts
vp run release:check
vp run check:types
vp run test
vp run docs:build
git diff --check
```

To publish through GitHub trusted publishing:

1. Bump all public package versions in the stack to the same Codex-aligned
   version.
2. Commit and push to jojo.
3. Confirm the Codeberg mirror has received the commit.
4. Push the same commit to GitHub.
5. For a package name that has never existed on npm, create the package/trusted-publisher setup with the owning npm account first. Do not add npm tokens to the repo or GitHub secrets.
6. Run `.github/workflows/publish-codex-toys.yml` on GitHub with confirmation input `publish-codex-toys-packages`.
7. Verify npm:

```bash
npm dist-tag ls codex-toys
```
