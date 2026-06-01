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

Public npm package:

- `codex-toys`

The scoped `@codex-toys/*` packages are private workspace boundaries. They are
built, checked, and bundled into the public `codex-toys` tarball, but they are
not published as standalone npm packages. Consumers import feature surfaces from
`codex-toys/*` subpaths such as `codex-toys/workbench`,
`codex-toys/bridge`, and `codex-toys/proxy/browser`.

The GitHub publish workflow checks whether the `codex-toys` version already
exists on npm. It publishes the missing version and skips versions that are
already present. The package is staged by `scripts/pack-public-package.ts`,
packed with `npm pack`, and then handed to `npm publish` so internal workspaces
are bundled and workspace/catalog dependency specifiers are converted before the
npm registry sees the package while GitHub provenance still comes from npm.
Version numbers intentionally track the upstream Codex release line rather than
strict semantic-versioning meaning. For example, if the current Codex-aligned
line is `0.140.x`, a breaking codex-toys stack release should usually advance
to `0.140.5` rather than `0.141.0`.

New core runtime surfaces should land in the internal package that owns the
feature boundary, with `codex-toys` exposing the supported public import through
the matching subpath. Product- or channel-specific gateways, such as Discord
text or voice packages, should publish separately and depend on `codex-toys`
from their own repositories.

Before publishing:

```bash
vp run release:check
vp run check:types
vp run test
vp run docs:build
git diff --check
```

To publish through GitHub trusted publishing:

1. Bump the public `codex-toys` package version and keep internal package
   versions aligned to the same Codex-aligned version.
2. Commit and push to jojo.
3. Confirm the Codeberg mirror has received the commit.
4. Push the same commit to GitHub.
5. If `codex-toys` trusted publishing is not already configured, create the
   package/trusted-publisher setup with the owning npm account first. Do not add
   npm tokens to the repo or GitHub secrets.
6. Run `.github/workflows/publish-codex-toys.yml` on GitHub with confirmation
   input `codex-toys`.
7. Verify npm:

```bash
npm dist-tag ls codex-toys
```
