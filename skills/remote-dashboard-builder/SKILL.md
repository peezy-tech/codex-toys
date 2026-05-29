---
name: remote-dashboard-builder
description: Use when building local Vite dashboards that inspect or operate remote Codex workspaces over SSH through codex-flows functions, without exposing remote HTTP ports.
---

# Remote Dashboard Builder

Use this skill when a user wants a browser dashboard for a remote Codex
workspace, especially when human verification needs a local browser but the
workspace runs over SSH.

## Direction

- Build the dashboard as a local Vite app.
- Do not start human-facing preview servers on the remote host.
- Use `@peezy.tech/codex-flows/vite` as the local SSH bridge.
- Use `@peezy.tech/codex-flows/browser` from dashboard code.
- Use `.codex/functions.ts` in the remote workspace for active data or actions.

## Discovery Flow

Before designing the dashboard, inspect what the remote workspace already
exposes:

```bash
codex-flows --ssh <target> --cwd <remote-workspace> functions list --json
codex-flows --ssh <target> --cwd <remote-workspace> functions describe <name> --json
```

Probe only read-only or no-side-effect functions with small sample inputs:

```bash
codex-flows --ssh <target> --cwd <remote-workspace> functions call <name> --params-json '{"sample":true}' --json
```

Do not casually call functions that declare `sideEffects: "writes-local"` or
`sideEffects: "external-write"`. Ask the user before calling functions that can
mutate local workspace state, external systems, money, deployments, accounts,
or production data.

## Vite Setup

Use the Vite plugin in the local dashboard:

```ts
import { codexFlowsRemote } from "@peezy.tech/codex-flows/vite";

export default {
  plugins: [
    codexFlowsRemote({
      ssh: process.env.CODEX_FLOWS_REMOTE_SSH_TARGET,
      cwd: process.env.CODEX_FLOWS_REMOTE_CWD,
    }),
  ],
};
```

Dashboard code calls the local bridge:

```ts
import { codexFlows } from "@peezy.tech/codex-flows/browser";

const functions = await codexFlows.functions.list();
const snapshot = await codexFlows.functions.call("portfolioSnapshot");
```

The browser talks only to the local Vite server under `/__codex_flows`. The
Vite plugin owns the SSH connection and forwards requests to the remote-agent.

## Remote Workspace Functions

Add narrow, named functions only when the dashboard needs active data that is
not already exposed:

```ts
import { defineFunctions } from "@peezy.tech/codex-flows/functions";

export default defineFunctions({
  portfolioSnapshot: {
    description: "Read the latest portfolio snapshot.",
    sideEffects: "read-only",
    handler: async () => {
      return { positions: [], cash: 0 };
    },
  },
});
```

Keep functions JSON-in and JSON-out. Return plain objects, arrays, strings,
numbers, booleans, or null. Avoid returning class instances, streams, circular
objects, functions, BigInts, secrets, raw private keys, or broad filesystem
contents.

## Safety Rules

- Never expose arbitrary shell execution to the browser.
- Prefer small read-only functions for discovery and dashboard refresh.
- Use descriptive names, descriptions, schemas, examples, and tags when useful.
- Use `sideEffects: "external-write"` for actions that touch external systems.
- Build the dashboard from real function metadata and returned shapes, not
  guesses.
