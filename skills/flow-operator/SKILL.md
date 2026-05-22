---
name: flow-operator
description: Use when operating, inspecting, debugging, retrying, or replaying Codex flow events and runs in a live or local flow backend.
---

# Flow Operator

Use this skill for operational flow work after a flow has been dispatched.

## Scope

- Inspect stored flow events and run records.
- Diagnose `failed`, `blocked`, or `needs_intervention` results.
- Retry Patch dispatch transport failures.
- Replay accepted backend events to create a new run attempt.
- Verify release-readiness without fabricating an upstream release lifecycle.

## Commands

In a codex-flows checkout:

```bash
bun run flow:backend list-events --limit 20
bun run flow:backend show-event '<event-id>'
bun run flow:backend list-runs --status failed --limit 20
bun run flow:backend show-run '<run-id>'
bun run flow:backend replay-event '<event-id>' --wait
```

Against Patch admin endpoints:

```bash
curl -H "Authorization: Bearer $PATCH_ADMIN_TOKEN" https://patch.moi/flow-events
curl -H "Authorization: Bearer $PATCH_ADMIN_TOKEN" https://patch.moi/flow-dispatches
curl -X POST -H "Authorization: Bearer $PATCH_ADMIN_TOKEN" https://patch.moi/flow-events/<encoded-event-id>/retry
curl -X POST -H "Authorization: Bearer $PATCH_ADMIN_TOKEN" https://patch.moi/flow-events/<encoded-event-id>/replay
```

## Rules

- Treat duplicate dispatch and replay differently. Duplicate dispatch should not start a new run; replay intentionally starts a new run attempt for a stored event.
- Use Patch `retry` for dispatch/network failures before backend acceptance.
- Use backend or Patch `replay` when the backend accepted the event but a run failed, blocked, or needs intervention.
- Preserve run stdout/stderr and `FLOW_RESULT` artifacts when reporting findings.
- Do not fabricate a full `openai/codex` release lifecycle test. Wait for a real upstream release event.
- Before changing live settings, verify health checks and current worktree cleanliness.
