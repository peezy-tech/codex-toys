import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import {
  encodeMessage,
  MEKA_PROTOCOL_VERSION,
  NdjsonDecoder,
  notification,
  success,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type MekaRunSummary,
} from "../src/protocol.ts";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE_ENTRYPOINT = path.join(REPOSITORY_ROOT, "apps", "meka", "src", "main.ts");
const TSX_IMPORT = import.meta.resolve("tsx");

test("meka subscribe prints completed-run replay history before exiting", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meka-cli-subscribe-test-"));
  const socketPath = path.join(temporaryDirectory, "meka.sock");
  const run: MekaRunSummary = {
    id: "completed-run",
    jobId: "completed-job",
    queue: "default",
    provider: "codex",
    state: "completed",
    providerSessionId: "provider-session",
    providerRunId: "provider-run",
    startedAt: "2026-07-11T00:00:00.000Z",
    outcome: { state: "completed" },
  };
  const sockets = new Set<Socket>();
  let subscribeRequest: JsonRpcRequest | undefined;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const decoder = new NdjsonDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const value of decoder.push(chunk)) {
        const request = value as JsonRpcRequest;
        if (request.method === "meka.initialize") {
          socket.write(
            encodeMessage(
              success(request.id, {
                protocolVersion: MEKA_PROTOCOL_VERSION,
                instanceId: "11111111-1111-4111-8111-111111111111",
                pid: process.pid,
                socketPath,
                capabilities: ["runs", "event-replay"],
              }),
            ),
          );
          continue;
        }
        if (request.method !== "run.subscribe") {
          continue;
        }
        subscribeRequest = request;
        socket.write(
          encodeMessage(
            success(request.id, {
              run,
              replay: {
                requestedAfter: 0,
                oldestAvailable: 1,
                latestAvailable: 1,
                gap: false,
              },
            }),
          ),
          () => {
            setTimeout(() => {
              if (!socket.writable) {
                return;
              }
              socket.write(
                encodeMessage(
                  notification("run.event", {
                    runId: run.id,
                    sequence: 1,
                    at: "2026-07-11T00:00:01.000Z",
                    provider: "codex",
                    event: { type: "provider.delta", text: "replayed output" },
                  }),
                ),
              );
              socket.write(encodeMessage(notification("run.state", { run })));
            }, 100);
          },
        );
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const result = await executeCli([
      "subscribe",
      run.id,
      "--after",
      "0",
      "--socket",
      socketPath,
    ]);
    const messages = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRpcNotification);

    expect(result.stderr).toBe("");
    expect(subscribeRequest?.params).toEqual({ runId: run.id, afterSequence: 0 });
    expect(messages.map((message) => message.method)).toEqual(["run.event", "run.state"]);
    expect(messages[0]?.params).toMatchObject({
      runId: run.id,
      sequence: 1,
      event: { type: "provider.delta", text: "replayed output" },
    });
    expect(messages[1]?.params).toMatchObject({ run: { id: run.id, state: "completed" } });
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

async function executeCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", TSX_IMPORT, SOURCE_ENTRYPOINT, ...args],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: path.join(REPOSITORY_ROOT, "tsconfig.base.json"),
        },
        timeout: 20_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
