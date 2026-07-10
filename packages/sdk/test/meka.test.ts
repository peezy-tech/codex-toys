import { expect, test } from "vite-plus/test";
import type { v2 } from "../src/providers/codex/app-server/generated/index.ts";
import type { ClaudeCodeSessionStartOptions } from "../src/providers/claude/client.ts";
import { Meka, type MekaEvent } from "@meka/sdk";

test("runs Codex unattended, forwards native events, and closes on completion", async () => {
  const client = new FakeCodexClient();
  const events: MekaEvent[] = [];
  const meka = new Meka({ createCodexClient: () => client as never });

  const run = await meka.startRun({
    provider: "codex",
    prompt: "inspect the repository",
    cwd: "/workspace",
    model: "gpt-5",
    onEvent: (event) => events.push(event),
  });

  expect(client.threadParams).toMatchObject({
    cwd: "/workspace",
    model: "gpt-5",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  expect(client.turnParams).toMatchObject({
    threadId: "thread-1",
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    input: [{ type: "text", text: "inspect the repository", text_elements: [] }],
  });
  expect(run).toMatchObject({
    provider: "codex",
    providerSessionId: "thread-1",
    providerRunId: "turn-1",
    state: "running",
  });
  expect(events).toContainEqual({ provider: "codex", event: { method: "item/started" } });

  await run.interrupt();
  expect(client.interruptParams).toEqual({ threadId: "thread-1", turnId: "turn-1" });
  client.emit("request", {
    jsonrpc: "2.0",
    id: 7,
    method: "item/commandExecution/requestApproval",
    params: {},
  });
  client.emit("request", {
    jsonrpc: "2.0",
    id: 8,
    method: "item/tool/call",
    params: {},
  });
  expect(client.responses).toContainEqual({ id: 7, result: { decision: "accept" } });
  expect(client.responseErrors).toContainEqual({
    id: 8,
    code: -32601,
    message: "Unsupported unattended Codex request: item/tool/call",
  });
  client.emit("notification", {
    method: "turn/completed",
    params: { turn: { id: "turn-1", status: "completed" } },
  });
  await expect(run.done).resolves.toEqual({ state: "completed" });
  await nextTurn();
  expect(client.closed).toBe(true);
});

test("runs Claude with bypass permissions and closes on a successful result", async () => {
  const client = new FakeClaudeClient();
  const events: MekaEvent[] = [];
  const meka = new Meka({ createClaudeClient: () => client as never });
  const run = await meka.startRun({
    provider: "claude",
    prompt: "inspect the repository",
    cwd: "/workspace",
    model: "sonnet",
    onEvent: (event) => events.push(event),
  });

  expect(client.options).toMatchObject({
    cwd: "/workspace",
    model: "sonnet",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  });
  expect(client.session.sent).toEqual(["inspect the repository"]);
  client.session.emit("event", { type: "message", message: { type: "assistant", text: "hello" } });
  expect(events).toContainEqual({
    provider: "claude",
    event: { type: "message", message: { type: "assistant", text: "hello" } },
  });
  client.session.emit("event", {
    type: "message",
    message: { type: "result", subtype: "success" },
  });
  await expect(run.done).resolves.toEqual({ state: "completed" });
  await nextTurn();
  expect(client.closed).toBe(true);
});

test("installs provider-native plugins through one SDK method", async () => {
  const client = new FakeCodexClient();
  const commands: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const meka = new Meka({
    createCodexClient: () => client as never,
    runCommand: async (command, args, options) => {
      commands.push({ command, args, cwd: options.cwd });
      return {
        stdout: "installed",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
  });

  await expect(
    meka.installPlugin({
      provider: "claude",
      plugin: "example",
      scope: "project",
      cwd: "/workspace",
    }),
  ).resolves.toMatchObject({ provider: "claude", stdout: "installed" });
  expect(commands).toEqual([
    {
      command: "claude",
      args: ["plugin", "install", "example", "--scope", "project"],
      cwd: "/workspace",
    },
  ]);

  await meka.installPlugin({
    provider: "codex",
    plugin: "example",
    remoteMarketplaceName: "internal",
  });
  expect(client.pluginParams).toEqual({
    pluginName: "example",
    remoteMarketplaceName: "internal",
  });
});

test("closing Meka aborts an active plugin install and rejects queued work", async () => {
  const started = Promise.withResolvers<void>();
  const meka = new Meka({
    runCommand: async (_command, _args, options) => {
      started.resolve();
      return await new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new Error("plugin install aborted")),
          { once: true },
        );
      });
    },
  });

  const first = meka.installPlugin({ provider: "claude", plugin: "one" });
  const firstOutcome = first.catch((error: unknown) => error);
  await started.promise;
  const second = meka.installPlugin({ provider: "claude", plugin: "two" });
  const secondOutcome = second.catch((error: unknown) => error);

  await meka.close();
  await expect(firstOutcome).resolves.toMatchObject({ message: "plugin install aborted" });
  await expect(secondOutcome).resolves.toMatchObject({ message: "Meka is closed" });
});

class FakeCodexClient {
  #listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  threadParams: v2.ThreadStartParams | undefined;
  turnParams: v2.TurnStartParams | undefined;
  interruptParams: v2.TurnInterruptParams | undefined;
  pluginParams: v2.PluginInstallParams | undefined;
  responses: Array<{ id: string | number; result: unknown }> = [];
  responseErrors: Array<{ id: string | number; code: number; message: string }> = [];
  closed = false;

  on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener as (...args: unknown[]) => void);
    this.#listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (...args: never[]) => void): this {
    this.#listeners.get(event)?.delete(listener as (...args: unknown[]) => void);
    return this;
  }

  async connect(): Promise<void> {}
  close(): void {
    this.closed = true;
  }

  async startThread(params: v2.ThreadStartParams): Promise<v2.ThreadStartResponse> {
    this.threadParams = params;
    return { thread: { id: "thread-1" } } as v2.ThreadStartResponse;
  }

  async startTurn(params: v2.TurnStartParams): Promise<v2.TurnStartResponse> {
    this.turnParams = params;
    this.emit("notification", { method: "item/started" });
    return { turn: { id: "turn-1" } } as v2.TurnStartResponse;
  }

  async interruptTurn(params: v2.TurnInterruptParams): Promise<v2.TurnInterruptResponse> {
    this.interruptParams = params;
    return {} as v2.TurnInterruptResponse;
  }

  async installPlugin(params: v2.PluginInstallParams): Promise<v2.PluginInstallResponse> {
    this.pluginParams = params;
    return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] };
  }

  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.responseErrors.push({ id, code, message });
  }

  emit(event: string, ...payload: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...payload);
    }
  }
}

class FakeClaudeClient {
  options: ClaudeCodeSessionStartOptions | undefined;
  session = new FakeClaudeSession();
  closed = false;

  startSession(options: ClaudeCodeSessionStartOptions): FakeClaudeSession {
    this.options = options;
    return this.session;
  }

  close(): void {
    this.closed = true;
  }
}

class FakeClaudeSession {
  id = "claude-session";
  sent: string[] = [];
  #listeners = new Map<string, Set<(event: unknown) => void>>();

  on(event: string, listener: (event: unknown) => void): this {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (event: unknown) => void): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  sendText(text: string): void {
    this.sent.push(text);
  }
  async interrupt(): Promise<void> {}
  close(): void {}

  emit(event: string, payload: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
