# Agent Harness Starter

A compact TypeScript starter for unattended local Codex and Claude Code runs.
It preserves each provider's existing local authentication, threads/sessions,
plugins, skills, hooks, and configuration. The common layer intentionally
normalizes only starting a run, interrupting it, closing it, and installing a
provider-native plugin; provider events remain native.

```text
harness
├── codex    native app-server adapter, including generated bindings
├── claude   Claude Agent SDK adapter
├── cli      generic run and plugin-install commands
└── http     optional loopback bridge with a fixed workspace
```

`packages/microbridge` is deliberately absent: there is no second Codex-only
RPC protocol to maintain.

## Install and validate

```bash
pnpm install
pnpm run check:types
pnpm test
pnpm run build
```

## Run either provider

```ts
import { AgentHarness } from "@codex-appkit/harness";

const harness = new AgentHarness();
const run = await harness.run({
	provider: "claude", // or "codex"
	prompt: "Inspect this repository and fix the failing test.",
	cwd: process.cwd(),
	onEvent: console.log,
});
```

Every run disables interactive approval. Codex uses `approvalPolicy: "never"`
and `danger-full-access`; Claude Code uses `bypassPermissions` and
`allowDangerouslySkipPermissions`. Run only inside an external sandbox or
equivalent containment that you control.

## Install provider-native plugins

Plugins are the shared installation unit: a plugin can contain provider-owned
skills, hooks, MCP servers, and configuration.

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
	remoteMarketplaceName: "internal",
});
```

## CLI and HTTP bridge

```bash
agent-harness run "summarize this repo" --provider codex --cwd "$PWD"
agent-harness plugin install my-plugin --provider claude --scope project
agent-harness http serve --cwd "$PWD" --static ./dist
```

The HTTP bridge is loopback-only and fixes its working directory at server
startup. It exposes runs, Server-Sent native events, interrupts, closes, and
plugin installation—never arbitrary Codex RPC calls.

The examples are [`examples/node-run`](/home/peezy/repos/codex-effects/examples/node-run)
and [`examples/vite-runner`](/home/peezy/repos/codex-effects/examples/vite-runner).

## Regenerate Codex bindings

The Codex adapter keeps generated app-server bindings because they follow the
installed Codex protocol exactly.

```bash
pnpm bindings:generate
git diff -- packages/codex/src/app-server/generated
pnpm run check:types
pnpm test
```
