# @codex-appkit/claude-code

Local Claude Code primitives for browser or desktop utilities.

The package runs the `claude` command already available on `PATH` by default.
It intentionally does not set `HOME`, `CLAUDE_CONFIG_DIR`, credentials, or a
remote application endpoint, so normal Claude Code sessions, MCP connectors,
plugins, and user settings remain available.

```ts
import { ClaudeCodeClient } from "@codex-appkit/claude-code";

const claude = new ClaudeCodeClient();
const sessions = await claude.listSessions({ limit: 20 });
const session = claude.startSession({ cwd: process.cwd() });

session.on("event", console.log);
session.sendText("Summarize this repository");
```

Use `session.resolveApproval()` to answer an approval or `AskUserQuestion`
request emitted by the session.
