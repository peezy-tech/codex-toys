---
name: remote-dashboard-builder
description: Use when building local Vite dashboards that inspect or operate remote Codex workbenches over SSH through codex-toys functions, without exposing remote HTTP ports.
---

# Remote Dashboard Builder

Use this skill when a user wants a browser dashboard for a remote Codex
workspace, especially when human verification needs a local browser but the
workspace runs over SSH.

## Direction

- Build the dashboard as a local Vite app.
- Do not start human-facing preview servers on the remote host.
- Use `codex-toys/runtime` as the public dashboard bridge export, or run
  `codex-toys runtime http` directly for plain HTML.
- Use the `codexToys` browser helper from `codex-toys/runtime` in dashboard
  code.
- Use `.codex/functions.ts` in the remote workspace for active data or actions.
- Keep remote `.codex/functions.ts` self-contained unless the remote workspace
  has its imported packages installed in local `node_modules`.

## Discovery Flow

Before designing the dashboard, inspect what the remote workspace already
exposes:

```bash
codex-toys --ssh <target> --cwd <remote-workspace> functions list --json
codex-toys --ssh <target> --cwd <remote-workspace> functions describe <name> --json
```

Probe only read-only or no-side-effect functions with small sample inputs:

```bash
codex-toys --ssh <target> --cwd <remote-workspace> functions call <name> --params-json '{"sample":true}' --json
```

Do not casually call functions that declare `sideEffects: "writes-local"` or
`sideEffects: "external-write"`. Ask the user before calling functions that can
mutate local workspace state, external systems, money, deployments, accounts,
or production data.

## Vite Setup

Use the Vite plugin in the local dashboard:

```ts
import { codexToysRuntime } from "codex-toys/runtime";

export default {
  plugins: [
    codexToysRuntime({
      ssh: process.env.CODEX_TOYS_REMOTE_SSH_TARGET,
      cwd: process.env.CODEX_TOYS_REMOTE_CWD,
    }),
  ],
};
```

Dashboard code calls the local bridge:

```ts
import { codexToys } from "codex-toys/runtime";

const functions = await codexToys.functions.list();
const snapshot = await codexToys.functions.call("statusSnapshot");
```

The browser talks only to the local Vite server under `/__codex_toys/api`.
The Vite plugin owns the SSH connection and forwards generic `/api/*` requests
to the remote runtime.

For plain HTML without Vite, serve a static directory through the HTTP runtime:

```bash
codex-toys runtime http --ssh <target> --cwd <remote-workspace> --static ./dashboard
```

Plain JavaScript can call:

```ts
const schema = await fetch("/api/schema").then((response) => response.json());
const threads = await fetch("/api/app/thread%2Flist", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ limit: 20 }),
}).then((response) => response.json());
```

## Remote Workspace Functions

Add narrow, named functions only when the dashboard needs active data that is
not already exposed. The canonical format is a plain default-exported object
with no imports:

```ts
export default {
  statusSnapshot: {
    description: "Read the latest workbench status snapshot.",
    sideEffects: "read-only",
    handler: async () => {
      return { status: "ok", updatedAt: new Date().toISOString() };
    },
  },
};
```

Keep functions JSON-in and JSON-out. Return plain objects, arrays, strings,
numbers, booleans, or null. Avoid returning class instances, streams, circular
objects, functions, BigInts, secrets, raw private keys, or broad filesystem
contents.

If the remote workspace installs `codex-toys` locally, TypeScript
authors may optionally import `defineFunctions` from
`@codex-toys/workbench` for type-oriented editor help. Do not use
bare imports in `.codex/functions.ts` unless the remote workspace can resolve
those packages locally.

## Safety Rules

- Never expose arbitrary shell execution to the browser.
- Prefer small read-only functions for discovery and dashboard refresh.
- Use descriptive names, descriptions, schemas, examples, and tags when useful.
- Use `sideEffects: "external-write"` for actions that touch external systems.
- Build the dashboard from real function metadata and returned shapes, not
  guesses.
