---
name: delegation-orchestrator
description: Use when acting as the main Codex workspace operator and coordinating delegated Codex threads through privileged codex_workspace tools for fan-out work, status reads, result flushing, return modes, and group wakes.
---

# Delegation Orchestrator

Use this skill only from the main workspace operator thread. Delegated threads
must not receive or use privileged `codex_workspace` tools.

## Role

Coordinate work across Codex threads without taking ownership of backend state.
The workspace backend owns delegation records, return policies, pending wakes,
and presenter-specific metadata. Your job is to choose when to delegate, keep
prompts crisp, inspect progress, and merge results.

## When To Delegate

Delegate when work can proceed in parallel or when a task has a clear boundary:

- independent repository or module investigation
- bounded code changes with disjoint write ownership
- verification that can run while implementation continues
- research or log inspection that does not block the immediate next local step

Keep work local when the next action is blocked on the answer, the work is
tightly coupled, or the task requires continuous judgment from the main thread.

## Tool Use

Use `codex_workspace.list_delegations` before starting new work if active
delegations may already exist.

Use `codex_workspace.start_delegation` for new bounded work. Include:

- a concrete objective
- repository or directory context
- expected output format
- write ownership, if code edits are allowed
- return mode and group id, when coordination matters

Use `codex_workspace.resume_delegation` when an existing Codex thread should be
tracked again instead of starting a new thread.

Use `codex_workspace.send_delegation` for follow-up instructions. Keep the
message focused on the delegated thread's current ownership.

Use `codex_workspace.read_delegation` to inspect state before deciding whether
to wait, redirect, flush, or summarize.

Use `codex_workspace.set_delegation_policy` to change return mode or grouping
when orchestration requirements change.

Use `codex_workspace.flush_delegation_results` for manual or record-only results
that are ready to merge back into the operator thread.

Use `codex_workspace.list_delegation_groups` when coordinating fan-out/fan-in
work across several related delegations.

## Return Modes

- `wake_on_done`: wake the operator when this delegation reaches a terminal state.
- `wake_on_group`: wake after all delegations in the same group are terminal.
- `record_only`: record and mirror results without waking the operator.
- `manual`: leave completed results pending until explicitly flushed.
- `detached`: track the task without injecting, mirroring, or waking.

Choose `wake_on_group` for parallel fan-out, `manual` when you want to review
before injecting, and `detached` for background work that should not affect the
main thread.

## Fan-Out Pattern

1. Define the slices and ownership boundaries.
2. Start one delegation per independent slice with a shared `groupId`.
3. Use `wake_on_group` unless each result should interrupt independently.
4. Continue local non-overlapping work.
5. Read or flush results once the group is terminal.
6. Integrate results explicitly; do not assume delegated edits are conflict-free.

## Prompt Pattern

```text
Objective: <specific outcome>
Context: <repo/path/state>
Ownership: <files/modules, or read-only>
Constraints: <tests, style, no unrelated edits>
Return: <summary, files changed, verification>
```

## Guardrails

- Do not expose `codex_workspace` tools to delegated threads.
- Do not ask delegated threads to manage delegation lifecycle.
- Do not duplicate work across delegations.
- Do not delegate vague ownership such as "fix everything".
- Do not treat presenter-specific details as core delegation state.
- Preserve the workspace backend boundary: app-server methods stay native and
  delegation state stays in the backend.
