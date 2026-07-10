# @codex-appkit/http

Local-first HTTP and Vite helpers for browser UIs that talk to the Codex
app-server.

Routes:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/app/:method
GET  /api/claude/sessions
GET  /api/claude/sessions/:sessionId/messages
POST /api/claude/sessions
POST /api/claude/sessions/:sessionId/input
POST /api/claude/sessions/:sessionId/interrupt
POST /api/claude/sessions/:sessionId/approvals/:requestId
GET  /api/claude/sessions/:sessionId/events
```

The HTTP edge allows CORS only from loopback origins.

Claude routes use the normal `claude` binary found on `PATH` by default and do
not set a Claude home or remote endpoint. They therefore preserve the user’s
normal local Claude Code state. The `events` route is a Server-Sent Events
stream; send approval decisions to the approval route so the paused Claude
session can continue.
