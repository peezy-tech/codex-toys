---
title: Backends
description: Compare local memory, file state, workspace flow backends, HTTP adapters, and Convex.
---

# Backends

Backends differ in durability and execution location, not in event semantics.

## Local client

The local client runs matching steps synchronously in the current workspace.
Memory state is the default. File state under `.codex/flow-client` gives durable
event ids, list/get, and replay across client instances.

Use it for product CLIs, tests, and local development.

## Workspace flow capability

The workspace flow capability accepts dispatches, stores events and runs in
SQLite, writes event JSON files, and starts local steps directly or through
`systemd-run`. Embedded workspace backends can call it directly; the networked
local workspace backend also mounts compatible HTTP routes.

Use it for a small host-level service where local system tools and Codex are
available.

## Convex component

The Convex component stores generic control-plane state and leases work to
external workers. It is not an executor.

Use it when the product already uses Convex and needs durable app-visible run
state, service-authenticated wrappers, and worker handoff.

## HTTP adapters

Any app can expose a compatible `/events` and `/runs` adapter. The shared
backend client normalizes compatible responses, but authentication and domain
policy remain app-owned.
