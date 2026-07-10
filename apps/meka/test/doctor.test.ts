import { expect, test } from "vite-plus/test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMekaDoctor } from "../src/doctor.ts";
import { resolveHookIngressLocation } from "../src/hook-ingress.ts";

test("reports ready when the runtime and either provider are ready", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-doctor-test-"));
  const workspace = path.join(temporaryDirectory, "workspace");
  const runtimeRoot = path.join(temporaryDirectory, "runtime");
  await mkdir(workspace);

  try {
    const report = await runMekaDoctor({
      cwd: workspace,
      runtimeRoot,
      platform: "linux",
      nodeVersion: "24.15.0",
      checkCodex: async () => ({ accountType: "chatgpt", requiresOpenaiAuth: true }),
      runCommand: async () => ({
        code: 0,
        stdout: JSON.stringify({
          loggedIn: false,
          email: "private@example.com",
          orgName: "Private organization",
        }),
      }),
    });

    expect(report.ready).toBe(true);
    expect(report.checks).toEqual([
      expect.objectContaining({ id: "node", status: "pass" }),
      expect.objectContaining({ id: "platform", status: "pass" }),
      expect.objectContaining({ id: "runtime", status: "pass" }),
      expect.objectContaining({ id: "codex", status: "pass" }),
      expect.objectContaining({ id: "claude", status: "fail" }),
    ]);
    expect(await readdir(runtimeRoot)).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("private@example.com");
    expect(JSON.stringify(report)).not.toContain("Private organization");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("accepts Claude as the only ready provider and redacts account details", async () => {
  const report = await runMekaDoctor({
    platform: "linux",
    nodeVersion: "24.0.0",
    checkRuntime: async () => {},
    checkCodex: async () => {
      throw new Error("no Codex account");
    },
    runCommand: async () => ({
      code: 0,
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "private@example.com",
        orgId: "private-org",
      }),
    }),
  });

  expect(report.ready).toBe(true);
  expect(report.checks).toContainEqual(
    expect.objectContaining({
      id: "claude",
      status: "pass",
      detail: "Claude authentication is configured (claude.ai)",
    }),
  );
  expect(JSON.stringify(report)).not.toContain("private@example.com");
  expect(JSON.stringify(report)).not.toContain("private-org");
});

test("does not claim global hook observations during its disposable runtime probe", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-doctor-hooks-test-"));
  const workspace = path.join(temporaryDirectory, "workspace");
  const stateHome = path.join(temporaryDirectory, "global-state");
  const runtimeRoot = path.join(temporaryDirectory, "runtime");
  await mkdir(workspace);
  const location = resolveHookIngressLocation({ stateHome });
  await mkdir(location.inboxPath, { recursive: true, mode: 0o700 });
  await chmod(location.root, 0o700);
  await chmod(location.inboxPath, 0o700);
  const now = Date.now();
  const id = `hook-${String(now).padStart(13, "0")}-00000000-0000-4000-8000-000000000001`;
  const createdAt = new Date(now).toISOString();
  await writeFile(
    path.join(location.inboxPath, `${id}.json`),
    `${JSON.stringify({
      version: 1,
      id,
      kind: "agent.hook",
      createdAt,
      cwd: workspace,
      payload: {
        source: "codex-hook",
        sourceEventId: "doctor-must-not-consume",
        provider: "codex",
        sessionId: "doctor-session",
        eventType: "AfterAgent",
        occurredAt: createdAt,
        payload: { cwd: workspace },
      },
    })}\n`,
    { mode: 0o600 },
  );

  try {
    const report = await runMekaDoctor({
      cwd: workspace,
      runtimeRoot,
      stateHome,
      platform: "linux",
      nodeVersion: "24.0.0",
      checkCodex: async () => ({ accountType: "chatgpt", requiresOpenaiAuth: true }),
      runCommand: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: false }) }),
    });

    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "runtime", status: "pass" }),
    );
    expect(await readdir(location.inboxPath)).toEqual([`${id}.json`]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("fails when the host is unsupported or neither provider is ready", async () => {
  let runtimeChecked = false;
  const report = await runMekaDoctor({
    platform: "win32",
    nodeVersion: "23.9.0",
    checkRuntime: async () => {
      runtimeChecked = true;
    },
    checkCodex: async () => ({ accountType: null, requiresOpenaiAuth: false }),
    runCommand: async () => ({ code: 0, stdout: "not-json" }),
  });

  expect(report.ready).toBe(false);
  expect(runtimeChecked).toBe(false);
  expect(report.checks).toEqual([
    expect.objectContaining({ id: "node", status: "fail" }),
    expect.objectContaining({ id: "platform", status: "fail" }),
    expect.objectContaining({ id: "runtime", status: "fail" }),
    expect.objectContaining({ id: "codex", status: "fail" }),
    expect.objectContaining({ id: "claude", status: "fail" }),
  ]);
});
