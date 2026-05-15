---
title: Code Mode
description: Why Code Mode is gated and how it relates to normal Bun runners.
---

# Code Mode

Most flow steps should use `runner = "bun"`. Bun runners are plain scripts:
they receive flow context on stdin, perform deterministic work, and emit
`FLOW_RESULT`.

Use `runner = "code-mode"` when the step needs Codex to operate inside the
repository. Code Mode calls a fork-only app-server method,
`thread/codeMode/execute`, so it is intentionally gated.

## Why it is gated

Code Mode can use Codex tools and repository access. Enabling it changes the
trust and operational model of a flow deployment. The explicit gate keeps
ordinary flow execution safe by default.

## Execution location

Flow orchestration and Codex execution are separate axes. A local flow can start
a local stdio app-server today. A future remote Code Mode transport should use a
real app-server transport, not an unrelated HTTP shell wrapper.
