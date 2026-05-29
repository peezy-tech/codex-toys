# Security

`codex-toys` provides clients, local/SSH stdio toybox surfaces, an optional
loopback HTTP proxy, and sidecar automation around Codex app-server. It does
not add a general authentication, authorization, persistence, or
request-filtering boundary in front of Codex app-server.

Core codex-toys commands do not open network listeners. Treat
`codex-toys-proxy` as an explicit browser-facing edge: keep it bound to
localhost or another trusted network boundary unless a deployment adds its own
access control, origin policy, and request filtering.

Memory transplant is intentionally scoped to durable files under `memories/`.
It must not be used to copy auth files, sessions, logs, sqlite databases, or
other Codex home runtime internals.

Thread transplant and repo-committed thread artifacts intentionally handle raw
Codex rollout JSONL under `sessions/`. Treat those files as trusted history:
they can contain prompts, model output, tool calls, command output, file paths,
and any sensitive text the toybox observed. Do not commit or transplant raw
rollouts unless that exact thread is safe to preserve.
