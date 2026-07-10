import { expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMekaDoctor } from "../src/doctor.ts";

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
