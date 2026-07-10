# Agent Harness

`@codex-appkit/harness` is the small common entry point for unattended local
Codex and Claude Code runs. It deliberately preserves each provider's local
authentication and installed state, and forwards provider-native events rather
than attempting to normalize their sessions or tool protocols.

```ts
import { AgentHarness } from "@codex-appkit/harness";

const harness = new AgentHarness();
const run = await harness.run({
	provider: "codex", // or "claude"
	prompt: "Inspect the repository and fix the failing test.",
	cwd: process.cwd(),
	onEvent: console.log,
});
```

Every run explicitly bypasses interactive permissions. Codex uses
`approvalPolicy: "never"` plus `danger-full-access`; Claude Code uses
`bypassPermissions` plus `allowDangerouslySkipPermissions`. Run it only inside
the external sandbox or other containment that you control.

Plugins are provider-native installation units: they can contain skills, hooks,
MCP servers, or provider-specific configuration.

```ts
await harness.installPlugin({
	provider: "claude",
	plugin: "my-plugin",
	scope: "project",
	cwd: process.cwd(),
});

await harness.installPlugin({
	provider: "codex",
	plugin: "my-plugin",
	remoteMarketplaceName: "my-marketplace",
});
```
