import { expect, test } from "vite-plus/test";
import { CodexAppServerClient } from "../src/providers/codex/app-server/client.ts";
import { CodexEventEmitter } from "../src/providers/codex/app-server/events.ts";

test("identifies the default app-server client as Meka", async () => {
  const transport = new FakeTransport();
  const client = new CodexAppServerClient({ transport });

  await client.connect();

  expect(transport.requests).toEqual([
    {
      method: "initialize",
      params: {
        clientInfo: {
          name: "meka",
          title: "Codex Client",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
    },
  ]);
  expect(transport.notifications).toEqual([{ method: "initialized", params: undefined }]);
});

class FakeTransport extends CodexEventEmitter {
  readonly requestTimeoutMs = 1_000;
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];

  start(): void {}
  close(): void {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    return {} as T;
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }

  respond(): void {}
  respondError(): void {}
}
