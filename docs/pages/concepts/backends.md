---
title: Backends
description: Compare direct app-server access, workspace backends, and SSH-backed remote operation.
---

# Backends

Backends differ in ownership and execution location. Turn automation should use
the smallest backend surface that can start the native Codex turn in the target
workspace.

## Direct app-server

Direct app-server access is useful for local development, protocol inspection,
and one-off debugging. It talks to Codex app-server without workspace policy.

Use `--via app` only when you deliberately want this direct path.

## Workspace backend

The workspace backend is the normal automation surface. It owns app-server
pass-through, delegation, hook-spool routing, workspace state, and repo-local
task execution. Turn automation uses `--via workspace` by default.

Use it when automation should respect workspace policy on the local machine.
A persistent local backend can be installed from a user profile with
`workspace backend init local --global` and `workspace backend service install`.

## SSH provider

The SSH provider keeps the CLI local while targeting a remote workspace. It can
start a transient remote agent over SSH without exposing a WebSocket port.

Use it for remote-first prompt automation where scripts run locally but Codex
turns run against the remote checkout.
