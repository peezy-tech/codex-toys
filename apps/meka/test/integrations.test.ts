import path from "node:path";
import { Effect, Layer } from "effect";
import { expect, test } from "vite-plus/test";
import {
  IntegrationPlatform,
  type IntegrationPlatformService,
} from "../src/integrations/platform.ts";
import {
  installIntegrations,
  repairIntegrations,
  statusIntegrations,
  uninstallIntegrations,
} from "../src/integrations/manager.ts";
import type {
  IntegrationCommand,
  IntegrationCommandResult,
  IntegrationLock,
  IntegrationLockOptions,
  IntegrationProvider,
} from "../src/integrations/types.ts";
import { IntegrationFailure } from "../src/integrations/types.ts";

const ASSET_ROOT = "/opt/meka/integrations";
const RECEIPT_PATH = "/state/meka/integrations.json";

test("installs, reports, repairs, and uninstalls owned integrations", async () => {
  const fake = new FakeIntegrationPlatform();
  const options = integrationOptions();
  const installed = await run(fake, installIntegrations(options));

  expect(installed.ready).toBe(true);
  expect(installed.hosts).toEqual([
    expect.objectContaining({
      provider: "codex",
      state: "installed",
      marketplaceOwned: true,
      pluginOwned: true,
    }),
    expect.objectContaining({
      provider: "claude",
      state: "installed",
      marketplaceOwned: true,
      pluginOwned: true,
    }),
  ]);
  expect(fake.files.get(RECEIPT_PATH)).toContain('"marketplaceOwned": true');
  expect(fake.files.get(RECEIPT_PATH)).toContain('"assetFingerprint": "assets-v1"');
  expect(fake.commands.every((command) => Array.isArray(command.args))).toBe(true);

  const mutationCount = fake.commands.filter(isMutation).length;
  await run(fake, installIntegrations(options));
  expect(fake.commands.filter(isMutation).length).toBe(mutationCount);

  fake.hosts.codex.pluginInstalled = false;
  const repaired = await run(fake, repairIntegrations({ ...options, providers: ["codex"] }));
  expect(repaired.hosts[0]).toMatchObject({ state: "installed", pluginOwned: true });
  expect(fake.hosts.codex.pluginInstalled).toBe(true);

  const status = await run(fake, statusIntegrations(options));
  expect(status.ready).toBe(true);
  expect(status.hosts.every((host) => host.state === "installed")).toBe(true);

  const removed = await run(fake, uninstallIntegrations(options));
  expect(removed.ready).toBe(true);
  expect(fake.hosts.codex).toEqual({ pluginInstalled: false });
  expect(fake.hosts.claude).toEqual({ pluginInstalled: false });
  expect(fake.files.has(RECEIPT_PATH)).toBe(false);
});

test("refreshes changed same-root assets only during explicit repair", async () => {
  const fake = new FakeIntegrationPlatform();
  const options = integrationOptions();
  await run(fake, installIntegrations(options));
  expect(fake.hosts.codex.installedAssetFingerprint).toBe("assets-v1");
  expect(fake.hosts.claude.installedAssetFingerprint).toBe("assets-v1");

  fake.assetFingerprint = "assets-v2";
  const mutationsBeforeInspection = fake.commands.filter(isMutation).length;
  const status = await run(fake, statusIntegrations(options));
  expect(
    status.hosts.every(
      (host) =>
        host.state === "drifted" &&
        host.assetFingerprint === "assets-v2" &&
        host.installedAssetFingerprint === "assets-v1" &&
        host.assetsCurrent === false &&
        host.pluginOwned,
    ),
  ).toBe(true);
  expect(fake.commands.filter(isMutation)).toHaveLength(mutationsBeforeInspection);

  const installedAgain = await run(fake, installIntegrations(options));
  expect(installedAgain).toMatchObject({
    ready: false,
  });
  expect(
    installedAgain.hosts.every(
      (host) => host.state === "drifted" && host.assetsCurrent === false,
    ),
  ).toBe(true);
  expect(fake.hosts.codex.installedAssetFingerprint).toBe("assets-v1");
  expect(fake.hosts.claude.installedAssetFingerprint).toBe("assets-v1");
  expect(fake.commands.filter(isMutation)).toHaveLength(mutationsBeforeInspection);

  const repaired = await run(fake, repairIntegrations(options));
  expect(repaired).toMatchObject({
    ready: true,
  });
  expect(
    repaired.hosts.every(
      (host) => host.state === "installed" && host.assetsCurrent === true,
    ),
  ).toBe(true);
  expect(fake.hosts.codex.installedAssetFingerprint).toBe("assets-v2");
  expect(fake.hosts.claude.installedAssetFingerprint).toBe("assets-v2");
  expect(fake.commands.filter(isMutation)).toHaveLength(mutationsBeforeInspection + 4);
  expect(fake.files.get(RECEIPT_PATH)).toContain('"assetFingerprint": "assets-v2"');

  const mutationsBeforeForcedRepair = fake.commands.filter(isMutation).length;
  await run(fake, repairIntegrations(options));
  expect(fake.commands.filter(isMutation)).toHaveLength(mutationsBeforeForcedRepair + 4);
});

test("preserves exact pre-existing state that Meka does not own", async () => {
  const fake = new FakeIntegrationPlatform();
  fake.hosts.codex = { source: ASSET_ROOT, pluginInstalled: true };
  const options = integrationOptions(["codex"]);

  const installed = await run(fake, installIntegrations(options));
  expect(installed.hosts[0]).toMatchObject({
    state: "installed",
    marketplaceOwned: false,
    pluginOwned: false,
  });

  const mutationCount = fake.commands.filter(isMutation).length;
  const repaired = await run(fake, repairIntegrations(options));
  expect(repaired.hosts[0]).toMatchObject({
    state: "installed",
    marketplaceOwned: false,
    pluginOwned: false,
  });
  expect(fake.commands.filter(isMutation)).toHaveLength(mutationCount);

  const removed = await run(fake, uninstallIntegrations(options));
  expect(removed.ready).toBe(true);
  expect(fake.hosts.codex).toEqual({ source: ASSET_ROOT, pluginInstalled: true });
  expect(fake.commands.some((command) => command.args.includes("remove"))).toBe(false);
});

test("fails closed when the marketplace name belongs to another exact source", async () => {
  const fake = new FakeIntegrationPlatform();
  fake.hosts.codex = { source: "/other/meka", pluginInstalled: false };

  const outcome = await run(
    fake,
    Effect.either(installIntegrations(integrationOptions(["codex"]))),
  );
  expect(outcome).toMatchObject({
    _tag: "Left",
    left: { reason: "conflict", provider: "codex" },
  });
  expect(fake.hosts.codex).toEqual({ source: "/other/meka", pluginInstalled: false });
  expect(fake.files.has(RECEIPT_PATH)).toBe(false);
});

test("rolls back newly owned host state when the receipt cannot be committed", async () => {
  const fake = new FakeIntegrationPlatform();
  fake.failNextWrite = true;

  const outcome = await run(
    fake,
    Effect.either(installIntegrations(integrationOptions(["codex"]))),
  );
  expect(outcome).toMatchObject({ _tag: "Left", left: { reason: "filesystem" } });
  expect(fake.hosts.codex).toEqual({ pluginInstalled: false });
  expect(fake.files.has(RECEIPT_PATH)).toBe(false);

  const retried = await run(fake, installIntegrations(integrationOptions(["codex"])));
  expect(retried.ready).toBe(true);
});

test("serializes receipt mutations so concurrent provider installs preserve both owners", async () => {
  const fake = new FakeIntegrationPlatform();

  await Promise.all([
    run(fake, installIntegrations(integrationOptions(["codex"]))),
    run(fake, installIntegrations(integrationOptions(["claude"]))),
  ]);

  const receipt = JSON.parse(fake.files.get(RECEIPT_PATH) ?? "null") as {
    hosts?: Record<string, unknown>;
  } | null;
  expect(Object.keys(receipt?.hosts ?? {}).sort()).toEqual(["claude", "codex"]);
  expect(fake.lockAcquisitions).toBe(2);
  expect(fake.maximumConcurrentLocks).toBe(1);
});

test("keeps status lock-free while a mutation lock is held", async () => {
  const fake = new FakeIntegrationPlatform();
  fake.hosts.codex = { source: ASSET_ROOT, pluginInstalled: true };
  const held = await Effect.runPromise(
    fake.acquireLock(`${RECEIPT_PATH}.lock`, { timeoutMs: 100, staleMs: 100 }),
  );
  const acquisitionsBeforeStatus = fake.lockAcquisitions;

  const status = await run(fake, statusIntegrations(integrationOptions(["codex"])));

  expect(status.ready).toBe(true);
  expect(fake.lockAcquisitions).toBe(acquisitionsBeforeStatus);
  await Effect.runPromise(fake.releaseLock(held));
});

function integrationOptions(providers?: IntegrationProvider[]) {
  return {
    providers,
    assetRoot: ASSET_ROOT,
    receiptPath: RECEIPT_PATH,
    executables: { codex: "codex-test", claude: "claude-test" },
    commandTimeoutMs: 100,
    maxOutputBytes: 1024,
  };
}

async function run<A, E>(
  fake: FakeIntegrationPlatform,
  effect: Effect.Effect<A, E, IntegrationPlatform>,
): Promise<A> {
  return await Effect.runPromise(
    effect.pipe(Effect.provide(Layer.succeed(IntegrationPlatform, fake))),
  );
}

class FakeIntegrationPlatform implements IntegrationPlatformService {
  readonly files = new Map<string, string>();
  readonly commands: IntegrationCommand[] = [];
  readonly hosts: Record<
    IntegrationProvider,
    { source?: string; pluginInstalled: boolean; installedAssetFingerprint?: string }
  > = {
    codex: { pluginInstalled: false },
    claude: { pluginInstalled: false },
  };
  failNextWrite = false;
  assetFingerprint = "assets-v1";
  lockAcquisitions = 0;
  maximumConcurrentLocks = 0;
  private activeLock: IntegrationLock | undefined;
  private lockSequence = 0;

  run = (command: IntegrationCommand) =>
    Effect.sync(() => {
      this.commands.push(command);
      const provider = command.executable.startsWith("codex") ? "codex" : "claude";
      const state = this.hosts[provider];
      const args = command.args;
      if (matches(args, "plugin", "marketplace", "list")) {
        return result(
          provider === "codex"
            ? JSON.stringify({
                marketplaces: state.source
                  ? [
                      {
                        name: "meka-local",
                        root: state.source,
                        marketplaceSource: { sourceType: "local", source: state.source },
                      },
                    ]
                  : [],
              })
            : JSON.stringify(
                state.source
                  ? [
                      {
                        name: "meka-local",
                        source: "directory",
                        path: state.source,
                        installLocation: state.source,
                      },
                    ]
                  : [],
              ),
        );
      }
      if (matches(args, "plugin", "marketplace", "add")) {
        state.source = args[3] as string;
        return result("{}");
      }
      if (matches(args, "plugin", "marketplace", "remove")) {
        delete state.source;
        return result("{}");
      }
      if (matches(args, "plugin", "list")) {
        const installed = state.pluginInstalled
          ? provider === "codex"
            ? [{ pluginId: "meka@meka-local", name: "meka", marketplaceName: "meka-local" }]
            : [{ id: "meka@meka-local", scope: "user", enabled: true }]
          : [];
        return result(
          provider === "codex" ? JSON.stringify({ installed }) : JSON.stringify(installed),
        );
      }
      if (matches(args, "plugin", "add") || matches(args, "plugin", "install")) {
        state.pluginInstalled = true;
        state.installedAssetFingerprint = this.assetFingerprint;
        return result("{}");
      }
      if (matches(args, "plugin", "remove") || matches(args, "plugin", "uninstall")) {
        state.pluginInstalled = false;
        delete state.installedAssetFingerprint;
        return result("{}");
      }
      throw new Error(`Unexpected command: ${command.executable} ${args.join(" ")}`);
    });

  readText = (filePath: string) => Effect.succeed(this.files.get(filePath));

  writeTextAtomic = (filePath: string, contents: string) =>
    this.failNextWrite
      ? Effect.sync(() => {
          this.failNextWrite = false;
        }).pipe(
          Effect.flatMap(() =>
            Effect.fail(new IntegrationFailure("filesystem", "simulated receipt failure")),
          ),
        )
      : Effect.sync(() => {
          this.files.set(filePath, contents);
        });

  removeFile = (filePath: string) =>
    Effect.sync(() => {
      this.files.delete(filePath);
    });

  canonicalPath = (filePath: string) => Effect.succeed(path.resolve(filePath));

  fingerprintTree = (_directory: string) => Effect.succeed(this.assetFingerprint);

  acquireLock = (lockPath: string, options: IntegrationLockOptions) =>
    Effect.tryPromise({
      try: async () => {
        const deadline = Date.now() + options.timeoutMs;
        while (this.activeLock) {
          if (Date.now() >= deadline) {
            throw new IntegrationFailure("lock-timeout", "simulated lock timeout");
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        const lock = { path: lockPath, token: `fake-lock-${String(++this.lockSequence)}` };
        this.activeLock = lock;
        this.lockAcquisitions += 1;
        this.maximumConcurrentLocks = Math.max(
          this.maximumConcurrentLocks,
          this.activeLock ? 1 : 0,
        );
        return lock;
      },
      catch: (cause) =>
        cause instanceof IntegrationFailure
          ? cause
          : new IntegrationFailure("filesystem", String(cause)),
    });

  releaseLock = (lock: IntegrationLock) =>
    Effect.sync(() => {
      if (this.activeLock?.token === lock.token) {
        this.activeLock = undefined;
      }
    });

  now = () => "2026-07-10T00:00:00.000Z";
}

function matches(args: readonly string[], ...prefix: string[]): boolean {
  return prefix.every((value, index) => args[index] === value);
}

function isMutation(command: IntegrationCommand): boolean {
  return (
    !matches(command.args, "plugin", "list") &&
    !matches(command.args, "plugin", "marketplace", "list")
  );
}

function result(stdout: string): IntegrationCommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
  };
}
