---
name: remote-control-operator
description: Use when a Codex App install on a local machine needs to inspect existing Codex remote-control connections, open an SSH/Tailscale tunnel to a remote codex-flows workspace backend, run remote automation, or start a Codex turn on that remote backend.
---

# Remote Control Operator

Use this skill when the user is operating from a local Codex App, such as a
Windows machine, and the target workspace/backend is on a remote VPS reachable
over Tailscale or SSH.

## Direction

- Local machine: where the Codex App plugin and this skill are installed.
- Remote target: the VPS/workspace where the codex-flows workspace backend runs.
- The local plugin does not install hooks or start a local backend.
- Prefer an SSH tunnel to the remote backend when the backend listens on the
  remote machine's loopback address.

## No Backend Check

Start by probing the local app-server remote-control surface and the expected
workspace backend URL:

```bash
codex-flows remote status --timeout-ms 1500
```

If both surfaces are unavailable, report that clearly. Do not pretend a backend
exists. The next step is usually a tunnel dry run.

## Tunnel Flow

Preview the tunnel command:

```bash
codex-flows remote tunnel start --ssh <user@tailscale-host> --dry-run
```

Start the tunnel in a long-running terminal:

```bash
codex-flows remote tunnel start --ssh <user@tailscale-host>
```

Defaults:

- Local WebSocket URL: `ws://127.0.0.1:3586`
- Remote backend address: `127.0.0.1:3586`
- Override with `--local-port`, `--remote-host`, and `--remote-port`.

Environment variables:

```bash
CODEX_FLOWS_REMOTE_SSH_TARGET=<user@tailscale-host>
CODEX_FLOWS_REMOTE_TUNNEL_PORT=3586
CODEX_FLOWS_REMOTE_BACKEND_HOST=127.0.0.1
CODEX_FLOWS_REMOTE_BACKEND_PORT=3586
```

## Remote Target Setup

On the VPS, run the backend from the target workspace:

```bash
codex-flows workspace backend init local
codex-flows workspace backend start
```

The backend can stay bound to `127.0.0.1`; the SSH tunnel exposes it to the
local Codex App machine.

## Turn Start

After the tunnel is up, recheck status:

```bash
codex-flows remote status --workspace-url ws://127.0.0.1:3586
```

Start a turn on the remote backend:

```bash
codex-flows remote turn start --via workspace --prompt "Check workspace status"
```

Use `--cwd <path>` when the remote app-server should start the thread in a
specific remote workspace path.

## Troubleshooting

- `remote status` unavailable: no tunnel, backend not running, or wrong port.
- `remoteControl/status/read` unavailable on the app-server: the local Codex App
  may not expose the remote-control API yet; continue through the workspace
  backend tunnel if that is reachable.
- `remote turn start` fails: retry with `--via workspace` and check that the
  backend URL is reachable.
