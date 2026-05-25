---
name: bun-flow-author
description: Use only when maintaining a custom or legacy Bun-backed flow runner. The current portable codex-flows runtime uses node steps, so prefer turn automation scripts or node flow steps for new work.
---

# Bun Flow Author

Use this skill only for `runner = "bun"` flow steps in a custom or legacy
runner. The portable codex-flows runtime currently supports `runner = "node"`;
new prompt automation should usually use `codex-flows automation run`.

## Runtime Contract

- The custom runner executes `bun <script>`.
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
