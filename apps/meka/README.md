# `@meka/app`

Meka is a private Unix-socket service and CLI over `@meka/sdk`. It owns a fixed
workspace, launches full-permission Codex or Claude Code runs, preserves their
native event streams, and lets trusted local controllers reconnect to active
runs.

From the repository root:

```sh
pnpm run meka -- serve --cwd /workspace
# prints one ready JSON line containing socketPath

export MEKA_SOCKET=/path/from/the/ready/line/m.sock
pnpm run meka -- run --provider codex "finish the implementation and test it"
pnpm run meka -- status
```

From this source checkout, run `pnpm run meka -- doctor --cwd /workspace`
before starting the daemon. It verifies the private-socket runtime plus Codex
and Claude readiness without starting a provider thread or sending a prompt.

The runtime directory is mode `0700` and the socket is mode `0600`. This is an
OS-user trust boundary, not isolation between mutually hostile processes owned
by the same user. Anyone who can access the socket can execute a coding harness
with the daemon user's permissions. The fixed `cwd` is only a starting
directory; the external sandbox is the filesystem boundary.
