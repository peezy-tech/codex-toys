# @codex-appkit/http

Optional loopback HTTP and Vite bridge for `@codex-appkit/harness`. It is not a
general Codex RPC proxy: callers can choose a provider, prompt, model, or
provider-native plugin, while the server fixes the working directory and owns
the outer sandbox boundary.

Routes:

```text
GET  /api/status
POST /api/runs
GET  /api/runs/:id/events
POST /api/runs/:id/interrupt
POST /api/runs/:id/close
POST /api/plugins
```

`events` is Server-Sent Events containing the provider-native event wrapped
with its provider name. The bridge accepts browser CORS only from loopback
origins.

```ts
import { agentHarness } from "@codex-appkit/http/vite";

export default {
	plugins: [agentHarness({ cwd: process.cwd() })],
};
```

Use this only where its host is already the intended external sandbox.
