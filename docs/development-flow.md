# Development Flow

This monorepo is developed on jojo at `jojo.build`. Codeberg is a push mirror, and GitHub is used only when npm trusted publishing needs its workflow.

## Remotes

Use jojo as the normal development remote:

```bash
git remote -v
# origin    git@jojo.build:peezy-tech/codex-flows.git
# codeberg  git@codeberg.org:peezy-tech/codex-flows.git
# github    https://github.com/peezy-tech/codex-flows.git
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
bun install --frozen-lockfile
bun run check:types
bun run test
bun run --filter @peezy.tech/codex-flows release:check
```

## Releases

Release package: `@peezy.tech/codex-flows`

Before publishing:

```bash
bun run --filter @peezy.tech/codex-flows release:check
bun run check:types
bun run test
git diff --check
```

To publish through GitHub trusted publishing:

1. Bump `packages/codex-client/package.json`.
2. Commit and push to jojo.
3. Confirm the Codeberg mirror has received the commit.
4. Push the same commit to GitHub.
5. Run `.github/workflows/publish-codex-flows.yml` on GitHub with confirmation input `@peezy.tech/codex-flows`.
6. Verify npm:

```bash
npm dist-tag ls @peezy.tech/codex-flows
```
