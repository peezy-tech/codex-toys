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

Release packages:

- `@peezy.tech/codex-flows`
- `@peezy.tech/flow-runtime`
- `@peezy.tech/flow-backend-convex`

Before publishing:

```bash
bun run release:check
bun run check:types
bun run test
git diff --check
```

To publish through GitHub trusted publishing:

1. Bump `packages/codex-client/package.json`, `packages/flow-runtime/package.json`, and `packages/flow-backend-convex/package.json` together when releasing the stack.
2. Commit and push to jojo.
3. Confirm the Codeberg mirror has received the commit.
4. Push the same commit to GitHub.
5. For a package name that has never existed on npm, either publish once with a human npm session or add a short-lived `NPM_TOKEN` secret to the `npm-publish` GitHub environment. Package-level trusted publishing can take over after the package exists.
6. Run `.github/workflows/publish-codex-flows.yml` on GitHub with confirmation input `publish-codex-flow-packages`.
7. Verify npm:

```bash
npm dist-tag ls @peezy.tech/codex-flows
npm dist-tag ls @peezy.tech/flow-runtime
npm dist-tag ls @peezy.tech/flow-backend-convex
```
