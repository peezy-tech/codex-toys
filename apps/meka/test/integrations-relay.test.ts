import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import {
  acknowledgeHookIngressClaim,
  claimHookIngress,
  resolveHookIngressLocation,
} from "../src/hook-ingress.ts";

const RELAY_PATH = fileURLToPath(
  new URL("../assets/meka-integrations/plugins/meka/scripts/meka-hook-relay.mjs", import.meta.url),
);

test("uses the plugin-root variable supported by each host", async () => {
  const pluginRoot = path.resolve(path.dirname(RELAY_PATH), "..");
  const codexHooks = await readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8");
  const claudeHooks = await readFile(path.join(pluginRoot, "hooks", "claude.json"), "utf8");

  expect(codexHooks).toContain("${CLAUDE_PLUGIN_ROOT}");
  expect(codexHooks).not.toContain("${CODEX_PLUGIN_ROOT}");
  expect(claudeHooks).toContain("${CLAUDE_PLUGIN_ROOT}");
});

test("relays a redacted event through the global inbox for a parent workspace", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-relay-test-"));
  const stateHome = path.join(temporaryDirectory, "state");
  const workspaceRoot = path.join(temporaryDirectory, "workspace");
  const workspace = path.join(workspaceRoot, "packages", "child");
  const unrelatedWorkspace = path.join(temporaryDirectory, "unrelated");
  await mkdir(workspace, { recursive: true });
  await mkdir(unrelatedWorkspace, { recursive: true });

  try {
    const exitCode = await invokeRelay(stateHome, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: workspace,
      model: "test-model",
      reason: "do not persist this reason",
      error: "do not persist this error",
      prompt: "do not persist this prompt",
      tool_input: { token: "do not persist this input" },
    });
    expect(exitCode).toBe(0);
    const location = resolveHookIngressLocation({ stateHome });
    expect(
      await claimHookIngress({
        stateHome,
        workspaceRoot: unrelatedWorkspace,
        consumerId: "unrelated-runtime",
      }),
    ).toEqual([]);
    const claims = await claimHookIngress({
      stateHome,
      workspaceRoot,
      consumerId: "custom-state-root-runtime",
    });
    expect(claims).toHaveLength(1);
    const claim = claims[0];
    expect(claim?.input).toMatchObject({
      source: "codex-hook",
      provider: "codex",
      sessionId: "session-1",
      eventType: "UserPromptSubmit",
    });
    expect(claim?.cwd).toBe(workspace);
    const entryPath = claim?.path ?? path.join(location.inboxPath, "missing.json");
    const line = await readFile(entryPath, "utf8");
    const envelope = JSON.parse(line) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      version: 1,
      kind: "agent.hook",
      cwd: workspace,
      payload: {
        source: "codex-hook",
        provider: "codex",
        sessionId: "session-1",
        eventType: "UserPromptSubmit",
        payload: {
          cwd: workspace,
          turnId: "turn-1",
          model: "test-model",
        },
      },
    });
    expect(line).not.toContain("do not persist");
    expect((await lstat(location.root)).mode & 0o777).toBe(0o700);
    expect((await lstat(location.inboxPath)).mode & 0o777).toBe(0o700);
    expect((await lstat(entryPath)).mode & 0o777).toBe(0o600);
    if (claim) expect(await acknowledgeHookIngressClaim(claim)).toBe(true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("derives a stable provider-native dedupe identity", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-relay-dedupe-test-"));
  const stateHome = path.join(temporaryDirectory, "state");
  const workspace = path.join(temporaryDirectory, "workspace");
  await mkdir(workspace, { recursive: true });
  const input = {
    hook_event_name: "PostToolUse",
    session_id: "session-stable",
    turn_id: "turn-stable",
    tool_use_id: "tool-stable",
    cwd: workspace,
  };
  try {
    expect(await invokeRelay(stateHome, input)).toBe(0);
    expect(await invokeRelay(stateHome, input)).toBe(0);
    const claims = await claimHookIngress({
      stateHome,
      workspaceRoot: workspace,
      consumerId: "dedupe-runtime",
    });
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((claim) => claim.input.sourceEventId)).size).toBe(1);
    for (const claim of claims) await acknowledgeHookIngressClaim(claim);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("fails open when a host sends an unusable hook payload", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-relay-fail-open-test-"));
  try {
    expect(
      await invokeRelay(path.join(temporaryDirectory, "state"), {
        hook_event_name: "SessionStart",
        // A host integration failure must not interrupt Codex or Claude.
        cwd: "",
      }),
    ).toBe(0);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

async function invokeRelay(stateHome: string, input: unknown): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RELAY_PATH, "codex"], {
      env: { ...process.env, XDG_STATE_HOME: stateHome },
      stdio: ["pipe", "ignore", "ignore"],
      shell: false,
    });
    child.once("error", reject);
    child.once("close", resolve);
    child.stdin.end(JSON.stringify(input));
  });
}
