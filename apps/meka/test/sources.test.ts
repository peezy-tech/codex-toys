import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import {
  decodeGitHubWebhook,
  pollRssSource,
  runCommandSource,
  runConfiguredCommand,
} from "../src/sources.ts";

test("polls and deduplicates bounded RSS input", async () => {
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Meka</title><item><guid>one</guid><title>First</title><link>https://example.test/one</link></item></channel></rss>`;
  const server = http.createServer((request, response) => {
    if (request.headers["if-none-match"] === '"v1"') {
      response.writeHead(304).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/rss+xml", etag: '"v1"' });
    response.end(feed);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  try {
    const first = await Effect.runPromise(
      pollRssSource({ id: "news", url: `http://127.0.0.1:${address.port}/feed` }),
    );
    expect(first.notModified).toBe(false);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      type: "rss.item",
      source: "rss:news",
      verified: false,
      payload: { guid: "one", title: "First" },
    });

    const second = await Effect.runPromise(
      pollRssSource({
        id: "news",
        url: `http://127.0.0.1:${address.port}/feed`,
        cursor: first.cursor,
      }),
    );
    expect(second).toMatchObject({ notModified: true, events: [] });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("verifies GitHub webhook signatures before normalizing", async () => {
  const body = JSON.stringify({ action: "opened", pull_request: { number: 42 } });
  const secret = "test-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const event = await Effect.runPromise(
    decodeGitHubWebhook({
      sourceId: "project",
      eventName: "pull_request",
      deliveryId: "delivery-1",
      signature,
      secret,
      body,
    }),
  );
  expect(event).toMatchObject({
    type: "github.pull_request",
    source: "github:project",
    deliveryId: "delivery-1",
    verified: true,
    metadata: { action: "opened" },
  });
  await expect(
    Effect.runPromise(
      decodeGitHubWebhook({
        sourceId: "project",
        eventName: "pull_request",
        deliveryId: "delivery-1",
        signature: "sha256=bad",
        secret,
        body,
      }),
    ),
  ).rejects.toThrow("signature does not match");
});

test("runs command sources without a shell and requires JSON output", async () => {
  const event = await Effect.runPromise(
    runCommandSource({
      id: "inventory",
      argv: [process.execPath, "-e", "process.stdout.write(JSON.stringify({count: 3}))"],
      cwd: process.cwd(),
      eventType: "inventory.updated",
    }),
  );
  expect(event).toMatchObject({
    type: "inventory.updated",
    source: "command:inventory",
    verified: false,
    payload: { count: 3 },
  });
});

test("force-kills configured commands that ignore the timeout signal", async () => {
  const startedAt = Date.now();
  const result = await Effect.runPromise(
    runConfiguredCommand({
      argv: [
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      cwd: process.cwd(),
      timeoutMs: 300,
    }),
  );
  expect(result).toMatchObject({ timedOut: true, signal: "SIGKILL" });
  expect(Date.now() - startedAt).toBeLessThan(2_500);
});

test("terminates descendant processes that retain command output pipes", async () => {
  const startedAt = Date.now();
  const result = await Effect.runPromise(
    runConfiguredCommand({
      argv: [
        process.execPath,
        "-e",
        `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", 1, 2] }); child.unref();`,
      ],
      cwd: process.cwd(),
      timeoutMs: 300,
    }),
  );
  expect(result.timedOut).toBe(true);
  expect(Date.now() - startedAt).toBeLessThan(2_500);
});

test("terminates configured-command descendants after normal completion", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(path.join(os.tmpdir(), "meka-command-complete-test-"));
  const pidPath = path.join(directory, "descendant.pid");
  let descendantPid: number | undefined;
  try {
    const result = await Effect.runPromise(
      runConfiguredCommand({
        argv: [
          process.execPath,
          "-e",
          `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref(); writeFileSync(process.argv[1], String(child.pid));`,
          pidPath,
        ],
        cwd: process.cwd(),
      }),
    );
    expect(result).toMatchObject({ code: 0, timedOut: false });
    descendantPid = Number(await readFile(pidPath, "utf8"));
    await waitForProcessExit(descendantPid);
  } finally {
    if (descendantPid && isProcessAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("aborts configured commands and their descendants", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(path.join(os.tmpdir(), "meka-command-abort-test-"));
  const pidPath = path.join(directory, "descendant.pid");
  const controller = new AbortController();
  let descendantPid: number | undefined;
  try {
    const execution = Effect.runPromise(
      runConfiguredCommand({
        argv: [
          process.execPath,
          "-e",
          `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref(); writeFileSync(process.argv[1], String(child.pid)); setInterval(() => {}, 1000);`,
          pidPath,
        ],
        cwd: process.cwd(),
        signal: controller.signal,
      }),
    );
    descendantPid = Number(await waitForFile(pidPath));
    controller.abort(new Error("test stop"));
    await expect(execution).rejects.toThrow("Command execution aborted: test stop");
    await waitForProcessExit(descendantPid);
  } finally {
    controller.abort();
    if (descendantPid && isProcessAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects command output and encoded results above durable limits", async () => {
  await expect(
    Effect.runPromise(
      runConfiguredCommand({
        argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(800 * 1024))"],
        cwd: process.cwd(),
      }),
    ),
  ).rejects.toThrow("Command output exceeds");

  await expect(
    Effect.runPromise(
      runConfiguredCommand({
        argv: [process.execPath, "-e", "process.stdout.write(Buffer.alloc(200 * 1024))"],
        cwd: process.cwd(),
      }),
    ),
  ).rejects.toThrow("durable JSON bytes");
});

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Command descendant remained alive: ${pid}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}
