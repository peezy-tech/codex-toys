---
title: Run web over the local workspace backend
description: Start the browser UI through codex-workspace-backend-local.
---

# Run web over the local workspace backend

Use the networked local workspace backend when the browser UI should share the
same backend boundary as other presenters: the UI is a client, the workspace
backend owns orchestration, and the Codex app-server remains the source of truth
for native app-server methods.

## Start the backend

Connect the workspace backend to an existing app-server WebSocket:

```sh
bun apps/workspace-backend/src/index.ts serve --app-server-url ws://127.0.0.1:3585
```

Or let it start a local stdio app-server:

```sh
bun apps/workspace-backend/src/index.ts serve --local-app-server
```

The backend listens on `ws://127.0.0.1:3586` by default. Override it with
`--host`, `--port`, `CODEX_WORKSPACE_BACKEND_HOST`, or
`CODEX_WORKSPACE_BACKEND_PORT`.

## Start the browser UI

```sh
bun run dev:web
```

The Vite dev server proxies `ws://<web-host>/__codex-workspace-backend` to
`ws://127.0.0.1:3586`. Set `VITE_CODEX_WORKSPACE_BACKEND_PROXY_TARGET` if the
backend is on another host or port.

For a browser that should connect directly to a workspace backend WebSocket
instead of using the dev proxy, set `VITE_CODEX_WORKSPACE_BACKEND_WS_URL`.

## Boundary

The web client uses `CodexWorkspaceBackendClient`. Native app-server operations
such as thread listing, thread reads, thread starts, turn starts, turn
interrupts, auth, and account reads are sent through `appServer.call` and
forwarded by the workspace backend's app-server adapter.

Do not reimplement app-server behavior in the workspace backend just to serve
the web UI. Add workspace-owned methods only for behavior that combines
app-server state with workspace state or policy, such as delegations, workbench
routing, hook-spool wakes, persisted workspace sessions, or flow inspection.
