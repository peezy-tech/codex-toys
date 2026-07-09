# @codex-appkit/microbridge

Optional JSON-RPC protocol for sidecars that need to forward Codex app-server
calls through `app.call`, broadcast app-server notifications, and expose a few
local utility methods.

Most Node scripts should use `@codex-appkit/app-server` directly. Use
microbridge when you want to put another process or transport between a UI and
the Codex app-server.
