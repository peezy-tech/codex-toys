# @codex-appkit/app-server

Typed client primitives for the native Codex app-server.

```ts
import { CodexAppServerClient } from "@codex-appkit/app-server";

const codex = new CodexAppServerClient({
	transportOptions: { cwd: process.cwd() },
});

await codex.connect();
const threads = await codex.listThreads({ limit: 20, sourceKinds: [] });
codex.close();
```

Regenerate protocol bindings after installing a new Codex release:

```bash
pnpm bindings:generate
```
