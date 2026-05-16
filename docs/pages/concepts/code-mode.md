---
title: Code Mode
description: Why Code Mode is gated and how it relates to normal Bun runners.
---

# Code Mode

Most flow steps should use `runner = "bun"`. Bun runners are plain scripts:
they receive flow context, perform deterministic work, and produce
`FLOW_RESULT`. Module-style Bun steps can also call the workspace backend that
launched them and use app-server pass-through to start, resume, read, and wait
for Codex turns.

Use `runner = "code-mode"` when the step needs Codex to operate inside the
repository. Code Mode calls a fork-only app-server method,
`thread/codeMode/execute`, so it is intentionally gated.

Bun+Codex orchestration is different from Code Mode. A Bun step may ask the
workspace backend to start a Codex turn and record the returned thread and turn
ids; the step itself still runs as a normal trusted Bun subprocess. Code Mode
executes saved Code Mode source inside the Codex runtime and therefore depends
on the Peezy Codex fork surface.

## Why it is gated

Code Mode can use Codex tools and repository access. Enabling it changes the
trust and operational model of a flow deployment. The explicit gate keeps
ordinary flow execution safe by default.

## Execution location

Flow orchestration and Codex execution are separate axes. A local flow can start
a local stdio app-server today. A future remote Code Mode transport should use a
real app-server transport, not an unrelated HTTP shell wrapper.
