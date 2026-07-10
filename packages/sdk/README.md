# @meka/sdk

Meka's in-process interface to the Codex and Claude Code coding harnesses. It
uses their normal local executables, authentication, sessions, plugins, skills,
hooks, and settings. Native events remain opaque.

```ts
import { Meka } from "@meka/sdk";

const meka = new Meka();
const run = await meka.startRun({
  provider: "codex",
  prompt: "Inspect this repository.",
  cwd: process.cwd(),
  onEvent: console.log,
});
```

All runs bypass interactive permission checks. The SDK is intended only for an
externally sandboxed environment.
