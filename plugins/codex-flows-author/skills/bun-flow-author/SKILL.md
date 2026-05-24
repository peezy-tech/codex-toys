---
name: bun-flow-author
description: Use when writing or reviewing Bun-based flow step scripts that run under a Codex flow runner, read flow context from stdin, use Bun shell or JavaScript runtime APIs, and emit FLOW_RESULT.
---

# Bun Flow Author

Use this skill for `runner = "bun"` flow steps.

## Runtime Contract

- The runner executes `bun <script>`.
- The script reads one JSON object from stdin containing flow context, including `flow.config` and the triggering flow event.
- The script must print exactly one `FLOW_RESULT <json>` line to stdout.
- Use stderr for progress logs that should not be parsed as the result.

## Step Pattern

```ts
const context = JSON.parse(await Bun.stdin.text());
const config = context.flow.config ?? {};

function result(value: Record<string, unknown>): never {
  process.stdout.write(`FLOW_RESULT ${JSON.stringify(value)}\n`);
  process.exit(0);
}

try {
  // Use Bun shell or JS APIs here.
  result({ status: "completed", artifacts: {} });
} catch (error) {
  result({
    status: "failed",
    message: error instanceof Error ? error.message : String(error),
  });
}
```

## Rules

- Prefer structured parsing and APIs over shell text scraping when practical.
- Use Bun shell for concise host automation, but keep commands explicit and logged.
- Treat `event.id` as the idempotency key.
- Do not hardcode secrets. Read environment variable names from flow config or backend config.
- Do not encode project release/remotes policy unless the flow package points to the relevant guidance skill or local docs.
- Return `needs_intervention` when a human or Codex turn must continue from a preserved external state.
