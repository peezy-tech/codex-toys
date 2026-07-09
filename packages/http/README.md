# @codex-appkit/http

Local-first HTTP and Vite helpers for browser UIs that talk to the Codex
app-server.

Routes:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/app/:method
```

The HTTP edge allows CORS only from loopback origins.
