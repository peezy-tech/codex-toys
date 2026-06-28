---
title: Runtime
description: Local stdio, SSH stdio, and HTTP/browser transport for codex-toys methods.
---

# Runtime

The codex-toys runtime is the transport layer behind local, SSH, and browser
operation. It exposes the same app-server pass-through, workbench, function,
feed, workflow, dispatch, and overview methods through different transports.

## Stdio

Run the stdio runtime directly:

```bash
codex-toys runtime serve --cwd <workspace>
```

Most local CLI commands spawn this process automatically when they need runtime
methods. The server starts a native `codex app-server --listen stdio://` process
in the selected cwd and forwards app-server calls through `app.call`.

## SSH

With `--ssh`, the local CLI starts `codex-toys runtime serve` on the target host
over SSH stdio. No remote HTTP port or tunnel is required.

```bash
codex-toys --ssh <target> --cwd <remote-workspace> runtime preflight --json
codex-toys --ssh <target> --cwd <remote-workspace> fetch
codex-toys --ssh <target> --cwd <remote-workspace> functions list --json
codex-toys --ssh <target> --cwd <remote-workspace> workflow run release-check --event event.json
```

Useful SSH runtime options:

```text
--ssh <target>
--cwd <remote-workspace>
--remote-path-prepend /home/user/.local/bin:/home/user/.bun/bin
--runtime-command /home/user/.local/bin/codex-toys
--codex-command /home/user/.local/bin/codex
--codex-arg -s
```

Environment equivalents:

```text
CODEX_TOYS_REMOTE_SSH_TARGET=<target>
CODEX_TOYS_REMOTE_CWD=<remote-workspace>
CODEX_TOYS_REMOTE_PATH_PREPEND=/home/user/.local/bin:/home/user/.bun/bin
CODEX_TOYS_RUNTIME_COMMAND=codex-toys
CODEX_TOYS_REMOTE_CODEX_COMMAND=codex
CODEX_TOYS_REMOTE_CODEX_ARGS=["-s","danger-full-access"]
```

## HTTP

Run the optional HTTP edge from the main CLI:

```bash
codex-toys runtime http --cwd <workspace> --static ./dashboard
codex-toys runtime http --ssh <target> --cwd <remote-workspace> --static ./dashboard
```

HTTP routes:

```text
GET  /api/status
GET  /api/schema
POST /api/rpc
POST /api/host/overview
POST /api/app/:method
POST /api/workbench/:method
POST /api/workbench/overview
```

The HTTP edge is explicit and local-first. CORS is allowed only for loopback
browser origins such as `localhost`, `127.0.0.1`, `::1`, and `*.localhost`.
Dashboards can avoid CORS entirely by serving static files from the same
runtime process.

## Browser And Vite Helpers

Use the browser client from the merged runtime export:

```ts
import { createCodexToysBrowserClient } from "codex-toys/runtime";

const codexToys = createCodexToysBrowserClient();
const schema = await codexToys.schema();
const threads = await codexToys.app.call("thread/list", { limit: 20 });
const functions = await codexToys.functions.list();
```

Use the Vite helper for local dashboards:

```ts
import { codexToysRuntime } from "codex-toys/runtime";

export default {
  plugins: [
    codexToysRuntime({
      ssh: "workbox",
      cwd: "/srv/codex/workspaces/ops",
    }),
  ],
};
```

The Vite plugin serves the runtime HTTP API under `/__codex_toys/api`.
