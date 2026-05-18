# Security

`codex-flows` provides clients, local workspace backend surfaces, a browser UI,
and sidecar automation around Codex app-server. It does not add a general
authentication, authorization, persistence, or request-filtering boundary in
front of Codex app-server.

Keep app-server and workspace backend WebSocket surfaces bound to localhost or
another trusted network boundary unless a deployment adds its own access
control. Do not expose Codex app-server or workspace backend control WebSockets
directly to the public internet.

Memory transplant is intentionally scoped to durable files under `memories/`.
It must not be used to copy auth files, sessions, logs, sqlite databases, or
other Codex home runtime internals.

Thread transplant and repo-committed thread artifacts intentionally handle raw
Codex rollout JSONL under `sessions/`. Treat those files as trusted history:
they can contain prompts, model output, tool calls, command output, file paths,
and any sensitive text the agent observed. Do not commit or transplant raw
rollouts unless that exact thread is safe to preserve.
