import { expect, test } from "vite-plus/test";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  InstallPluginInput,
  MekaEngine,
  MekaEvent,
  MekaRun,
  MekaRunInput,
  MekaRunOutcome,
  MekaRunState,
  PluginInstallResult,
} from "@meka/sdk";
import { MekaClient } from "../src/client.ts";
import {
  MAX_FRAME_BYTES,
  type JsonRpcNotification,
  type MekaRunEvent,
  type MekaRunStateEvent,
} from "../src/protocol.ts";
import { MekaServer } from "../src/server.ts";

test("serves a complete run lifecycle over a private Unix socket", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-socket-test-"));
  const workspace = path.join(temporaryDirectory, "workspace");
  await mkdir(workspace);
  const engine = new FakeEngine();
  const server = new MekaServer({
    engine,
    cwd: workspace,
    runtimeRoot: path.join(temporaryDirectory, "runtime"),
    instanceId: "11111111-1111-4111-8111-111111111111",
  });
  const ready = await server.start();
  let client = new MekaClient({ socketPath: ready.socketPath });

  try {
    expect((await lstat(ready.socketPath)).mode & 0o777).toBe(0o600);
    const cancelledClient = new MekaClient({ socketPath: ready.socketPath });
    const cancelledConnection = cancelledClient.connect();
    cancelledClient.close();
    await expect(cancelledConnection).rejects.toThrow("closed while connecting");
    await expect(client.connect()).resolves.toMatchObject({
      instanceId: "11111111-1111-4111-8111-111111111111",
      pid: process.pid,
      protocolVersion: 1,
      socketPath: ready.socketPath,
    });

    const status = await client.request<{ cwd: string; runs: unknown[] }>("meka.status");
    expect(status).toMatchObject({ cwd: workspace, runs: [] });

    const run = await client.request<{
      id: string;
      provider: string;
      providerSessionId: string | null;
      providerRunId: string | null;
      state: string;
    }>("run.start", {
      provider: "codex",
      prompt: "inspect this repository",
      model: "gpt-5",
    });
    expect(run).toMatchObject({
      provider: "codex",
      providerSessionId: "provider-session-1",
      providerRunId: "provider-run-1",
      state: "running",
    });
    expect(engine.startInput).toMatchObject({
      provider: "codex",
      prompt: "inspect this repository",
      model: "gpt-5",
      cwd: workspace,
    });

    const replayed = nextNotification<MekaRunEvent>(
      client,
      (message) => message.method === "run.event" && message.params?.runId === run.id,
    );
    const subscription = await client.request<{
      replay: { gap: boolean; oldestAvailable: number; latestAvailable: number };
    }>("run.subscribe", { runId: run.id, afterSequence: 0 });
    expect(subscription.replay).toEqual({
      requestedAfter: 0,
      oldestAvailable: 1,
      latestAvailable: 1,
      gap: false,
    });
    await expect(replayed).resolves.toMatchObject({
      runId: run.id,
      sequence: 1,
      provider: "codex",
      event: { type: "provider.started" },
    });

    const liveEvent = nextNotification<MekaRunEvent>(
      client,
      (message) => message.method === "run.event" && message.params?.sequence === 2,
    );
    engine.emit({ provider: "codex", event: { type: "provider.delta", text: "hello" } });
    await expect(liveEvent).resolves.toMatchObject({
      runId: run.id,
      sequence: 2,
      event: { type: "provider.delta", text: "hello" },
    });

    client.close();
    client = new MekaClient({ socketPath: ready.socketPath });
    await client.connect();
    const reconnectedReplay = nextNotification<MekaRunEvent>(
      client,
      (message) => message.method === "run.event" && message.params?.sequence === 2,
    );
    const reconnected = await client.subscribe(run.id, 1);
    expect(reconnected.replay).toMatchObject({ requestedAfter: 1, gap: false });
    await expect(reconnectedReplay).resolves.toMatchObject({
      runId: run.id,
      sequence: 2,
      event: { type: "provider.delta", text: "hello" },
    });

    const omittedEvent = nextNotification<MekaRunEvent>(
      client,
      (message) => message.method === "run.event" && message.params?.sequence === 3,
    );
    engine.emit({
      provider: "codex",
      event: { type: "provider.oversized", text: "x".repeat(MAX_FRAME_BYTES + 1) },
    });
    await expect(omittedEvent).resolves.toMatchObject({
      runId: run.id,
      sequence: 3,
      event: {
        type: "meka.event_omitted",
        reason: "oversized",
      },
    });

    await client.request("run.interrupt", { runId: run.id });
    expect(engine.run.interruptCalls).toBe(1);

    const completed = nextNotification<MekaRunStateEvent>(
      client,
      (message) =>
        message.method === "run.state" &&
        (message.params?.run as { id?: unknown } | undefined)?.id === run.id,
    );
    engine.run.finish({ state: "failed", error: "x".repeat(MAX_FRAME_BYTES + 1) });
    const terminal = await completed;
    expect(terminal).toMatchObject({
      run: { id: run.id, state: "failed", outcome: { state: "failed" } },
    });
    expect(Buffer.byteLength(terminal.run.outcome?.error ?? "")).toBeLessThanOrEqual(64 * 1024);

    const pluginResult = await client.request<PluginInstallResult>("plugin.install", {
      provider: "claude",
      plugin: "private-tools",
      scope: "project",
    });
    expect(engine.installInput).toEqual({
      provider: "claude",
      plugin: "private-tools",
      scope: "project",
      cwd: workspace,
    });
    expect(pluginResult).toMatchObject({ provider: "claude", stdout: "installed" });

    await client.request("run.close", { runId: run.id });
    await expect(client.request<{ runs: unknown[] }>("meka.status")).resolves.toMatchObject({
      runs: [],
    });
  } finally {
    client.close();
    await server.close();
    await expect(lstat(ready.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  expect(engine.closed).toBe(true);
});

test("does not orphan a provider run when the daemon closes during startup", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-startup-test-"));
  const workspace = path.join(temporaryDirectory, "workspace");
  await mkdir(workspace);
  const engine = new DeferredEngine();
  const server = new MekaServer({
    engine,
    cwd: workspace,
    runtimeRoot: path.join(temporaryDirectory, "runtime"),
  });
  const ready = await server.start();
  const first = new MekaClient({ socketPath: ready.socketPath });
  const second = new MekaClient({ socketPath: ready.socketPath });

  try {
    await Promise.all([first.connect(), second.connect()]);
    const starting = first
      .request("run.start", { provider: "codex", prompt: "wait" })
      .catch((error: unknown) => error);
    await engine.started.promise;
    const status = await second.status();
    const run = status.runs[0];
    expect(run).toMatchObject({ provider: "codex", state: "starting" });
    await expect(second.closeRun(run?.id ?? "missing")).rejects.toMatchObject({
      code: -32012,
    });

    const closing = server.close();
    engine.release.resolve(engine.run);
    await closing;
    await expect(starting).resolves.toBeInstanceOf(Error);
    expect(engine.run.closeCalls).toBe(1);
  } finally {
    first.close();
    second.close();
    await server.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

function nextNotification<T>(
  client: MekaClient,
  predicate: (message: JsonRpcNotification) => boolean,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const unsubscribe = client.onNotification((message) => {
      if (!predicate(message)) {
        return;
      }
      unsubscribe();
      resolve(message.params as T);
    });
  });
}

class FakeEngine implements MekaEngine {
  readonly run = new FakeRun();
  startInput: MekaRunInput | undefined;
  installInput: InstallPluginInput | undefined;
  closed = false;
  #onEvent: ((event: MekaEvent) => void) | undefined;

  async startRun(input: MekaRunInput): Promise<MekaRun> {
    this.startInput = input;
    this.#onEvent = input.onEvent;
    this.emit({ provider: input.provider, event: { type: "provider.started" } });
    return this.run;
  }

  emit(event: MekaEvent): void {
    this.#onEvent?.(event);
  }

  async installPlugin(input: InstallPluginInput): Promise<PluginInstallResult> {
    this.installInput = input;
    return {
      provider: "claude",
      stdout: "installed",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.run.close();
  }
}

class FakeRun implements MekaRun {
  readonly provider = "codex";
  readonly providerSessionId = "provider-session-1";
  readonly providerRunId = "provider-run-1";
  readonly done: Promise<MekaRunOutcome>;
  interruptCalls = 0;
  closeCalls = 0;
  #state: MekaRunState = "running";
  #completion = Promise.withResolvers<MekaRunOutcome>();
  #listeners = new Set<(event: MekaEvent) => void>();

  constructor() {
    this.done = this.#completion.promise;
  }

  get state(): MekaRunState {
    return this.#state;
  }

  onEvent(listener: (event: MekaEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.#state === "running") {
      this.finish({ state: "closed" });
    }
  }

  finish(outcome: MekaRunOutcome): void {
    if (this.#state !== "running") {
      return;
    }
    this.#state = outcome.state;
    this.#completion.resolve(outcome);
  }
}

class DeferredEngine implements MekaEngine {
  readonly run = new FakeRun();
  readonly started = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<MekaRun>();

  async startRun(): Promise<MekaRun> {
    this.started.resolve();
    return await this.release.promise;
  }

  async installPlugin(): Promise<PluginInstallResult> {
    throw new Error("not used");
  }

  async close(): Promise<void> {}
}
