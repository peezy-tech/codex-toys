import { expect, test } from "vite-plus/test";
import { probeCodexReadiness, type CodexReadinessClient } from "../src/index.ts";

test("probes Codex readiness without starting a thread or refreshing credentials", async () => {
  const client = new FakeCodexReadinessClient({
    account: { type: "apiKey" },
    requiresOpenaiAuth: true,
  });

  await expect(probeCodexReadiness({ createClient: () => client })).resolves.toEqual({
    accountType: "apiKey",
    requiresOpenaiAuth: true,
  });
  expect(client.connected).toBe(true);
  expect(client.closed).toBe(true);
  expect(client.params).toEqual({ refreshToken: false });
});

test("closes the app-server client when the readiness read fails", async () => {
  const client = new FakeCodexReadinessClient(undefined, new Error("account read failed"));

  await expect(probeCodexReadiness({ createClient: () => client })).rejects.toThrow(
    "account read failed",
  );
  expect(client.closed).toBe(true);
});

class FakeCodexReadinessClient implements CodexReadinessClient {
  connected = false;
  closed = false;
  params: { refreshToken?: boolean } | undefined;

  constructor(
    readonly result:
      | {
          account: { type: "apiKey" } | null;
          requiresOpenaiAuth: boolean;
        }
      | undefined,
    readonly error?: Error,
  ) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  close(): void {
    this.closed = true;
  }

  async getAccount(params: { refreshToken?: boolean }) {
    this.params = params;
    if (this.error) {
      throw this.error;
    }
    return this.result ?? { account: null, requiresOpenaiAuth: false };
  }
}
