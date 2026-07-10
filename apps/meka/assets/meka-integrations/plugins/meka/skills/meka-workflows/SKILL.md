---
name: meka-workflows
description: Author and validate TypeScript workflows for Meka using Effect. Use when creating event handlers, feeds, queued agent work, retry policy, or workflow tests.
---

# Meka Workflows

Meka workflows interpret typed events and enqueue controlled work. Use Effect for composition, dependencies, errors, interruption, and resource safety; let Meka own durable execution and queue policy.

## Before editing

1. Run `meka workflow --help` and inspect the installed workflow types. Do not invent imports or a manifest shape.
2. Read the nearest working workflow and its tests when the repository already has examples.
3. Identify the event schema, required capabilities, queue, idempotency key, and expected terminal result.

## Authoring rules

- Validate untrusted source payloads before applying policy.
- Keep source verification and normalization separate from workflow interpretation.
- Enqueue provider runs through `MekaRuns` and command actions with `DurableJobs.enqueue(DurableCommand.make(...))`; every request must name a configured queue. Do not invent job kinds or spawn detached work from a workflow.
- Derive deterministic idempotency keys from stable source identifiers.
- Express expected failures as typed Effect errors and use scoped resources for cleanup.
- Bound retries and recursive follow-up events. A provider run that may have produced side effects must not be retried blindly after an uncertain outcome.
- Pass commands as a fixed executable plus argv. Keep argv entries non-empty, use a positive timeout of at most 24 hours, and never construct a shell command from event data.
- Keep workflow module output serializable.

## Validate

Run the repository's TypeScript and unit checks, then use `meka workflow add <file.ts> --queue <name>` to make the registrar import and validate the module. A manual payload can be piped to `meka workflow run <id>`. Test duplicate delivery, invalid payloads, cancellation, and recovery after a worker stops. Report unsupported runtime features instead of simulating them inside the workflow.
