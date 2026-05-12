# Development Flow

This monorepo is developed on Forgejo at `jojo.build`. Codeberg is a push mirror, and GitHub is used only when npm trusted publishing needs its workflow.

## Remotes

Use Forgejo as the normal development remote:

```bash
git remote -v
# origin    git@jojo.build:peezy-tech/codex-flows.git
# codeberg  git@codeberg.org:peezy-tech/codex-flows.git
# github    https://github.com/peezy-tech/codex-flows.git
```

Push ordinary development to Forgejo:

```bash
git push origin main
```

Forgejo should push-mirror `main` to Codeberg. The local `codeberg` remote is kept for diagnostics and manual recovery.

Push to GitHub only when a release needs the trusted publishing workflow:

```bash
git push github main
```

## Machine Keys

This machine uses dedicated Forgejo and Codeberg SSH keys:

```text
~/.ssh/id_ed25519_jojo_build.pub
~/.ssh/id_ed25519_codeberg.pub
```

The public GPG key for commit verification is exported here:

```text
~/.config/forgejo-keys/matamune-jojo-build-gpg.asc
```

Upload the Forgejo SSH and GPG public keys to the `jojo.build` account before pushing over SSH or expecting verified commits. Keep the Codeberg SSH key available for mirror diagnostics.

## Forgejo CLI

`forgejo-cli` is installed as `fj`.

Authenticate with `jojo.build` after creating an application token:

```bash
fj --host jojo.build auth add-key <forgejo-username> <token>
fj --host jojo.build auth use-ssh true
fj --host jojo.build auth list
```

If browser login is available, this may also work:

```bash
fj auth login
fj auth use-ssh true
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
2. Commit and push to Forgejo.
3. Confirm the Codeberg mirror has received the commit.
4. Push the same commit to GitHub.
5. Run `.github/workflows/publish-codex-flows.yml` on GitHub with confirmation input `@peezy.tech/codex-flows`.
6. Verify npm:

```bash
npm dist-tag ls @peezy.tech/codex-flows
```
