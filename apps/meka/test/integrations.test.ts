import os from "node:os";
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
  fake.assetPluginVersion = "0.2.0";
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
  expect(fake.commands.filter(isMutation)).toHaveLength(mutationsBeforeInspection + 2);
  expect(fake.files.get(RECEIPT_PATH)).toContain('"assetFingerprint": "assets-v2"');

  const mutationsBeforeForcedRepair = fake.commands.filter(isMutation).length;
  await run(fake, repairIntegrations(options));
  expect(fake.commands.filter(isMutation)).toHaveLength(mutationsBeforeForcedRepair);
});

test.each(["codex", "claude"] as const)(
  "keeps the owned %s plugin and receipt truthful when an in-place refresh fails",
  async (provider) => {
    const fake = new FakeIntegrationPlatform();
    const options = integrationOptions([provider]);
    await run(fake, installIntegrations(options));

    fake.assetFingerprint = "assets-v2";
    fake.assetPluginVersion = "0.2.0";
    fake.failNextRefreshInstall = true;
    const outcome = await run(fake, Effect.either(repairIntegrations(options)));

    expect(outcome).toMatchObject({
      _tag: "Left",
      left: { reason: "command", provider },
    });
    expect(fake.hosts[provider]).toMatchObject({
      pluginInstalled: true,
      installedAssetFingerprint: "assets-v1",
      pluginVersion: "0.1.0",
    });
    expect(fake.files.get(RECEIPT_PATH)).toContain('"assetFingerprint": "assets-v1"');
    expect(fake.files.get(RECEIPT_PATH)).not.toContain('"assetFingerprint": "assets-v2"');

    const status = await run(fake, statusIntegrations(options));
    expect(status).toMatchObject({
      ready: false,
      hosts: [
        {
          provider,
          state: "drifted",
          pluginInstalled: true,
          pluginOwned: true,
          installedAssetFingerprint: "assets-v1",
          assetFingerprint: "assets-v2",
          assetsCurrent: false,
        },
      ],
    });

    if (provider === "claude") {
      const retry = await run(fake, Effect.either(repairIntegrations(options)));
      expect(retry).toMatchObject({
        _tag: "Left",
        left: { reason: "conflict", provider: "claude" },
      });
      expect(fake.hosts.claude.installedAssetFingerprint).toBe("assets-v1");

      fake.assetPluginVersion = "0.3.0";
      const recovered = await run(fake, repairIntegrations(options));
      expect(recovered.ready).toBe(true);
      expect(fake.hosts.claude.installedAssetFingerprint).toBe("assets-v2");
    } else {
      const recovered = await run(fake, repairIntegrations(options));
      expect(recovered.ready).toBe(true);
    }
  },
);

test("refuses a same-version Claude asset refresh without disturbing the old install", async () => {
  const fake = new FakeIntegrationPlatform();
  const options = integrationOptions(["claude"]);
  await run(fake, installIntegrations(options));

  fake.assetFingerprint = "assets-v2";
  const mutationsBeforeRepair = fake.commands.filter(isMutation).length;
  const outcome = await run(fake, Effect.either(repairIntegrations(options)));

  expect(outcome).toMatchObject({
    _tag: "Left",
    left: { reason: "invalid-response", provider: "claude" },
  });
  expect(fake.hosts.claude).toMatchObject({
    pluginInstalled: true,
    installedAssetFingerprint: "assets-v1",
    pluginVersion: "0.1.0",
  });
  expect(fake.commands.filter(isMutation)).toHaveLength(mutationsBeforeRepair);
  expect(fake.files.get(RECEIPT_PATH)).toContain('"assetFingerprint": "assets-v1"');
});

test("adopts a verified Claude refresh after only the receipt write failed", async () => {
  const fake = new FakeIntegrationPlatform();
  const options = integrationOptions(["claude"]);
  await run(fake, installIntegrations(options));

  fake.assetFingerprint = "assets-v2";
  fake.assetPluginVersion = "0.2.0";
  fake.failNextWrite = true;
  const failed = await run(fake, Effect.either(repairIntegrations(options)));
  expect(failed).toMatchObject({ _tag: "Left", left: { reason: "filesystem" } });
  expect(fake.hosts.claude).toMatchObject({
    pluginInstalled: true,
    installedAssetFingerprint: "assets-v2",
    pluginVersion: "0.2.0",
  });
  expect(fake.files.get(RECEIPT_PATH)).toContain('"assetFingerprint": "assets-v1"');

  const mutationsBeforeRetry = fake.commands.filter(isMutation).length;
  const recovered = await run(fake, repairIntegrations(options));
  expect(recovered).toMatchObject({
    ready: true,
    hosts: [{ state: "installed", assetsCurrent: true }],
  });
  expect(fake.commands.filter(isMutation)).toHaveLength(mutationsBeforeRetry);
  expect(fake.files.get(RECEIPT_PATH)).toContain('"assetFingerprint": "assets-v2"');
});

test("rejects a Claude refresh whose active cache does not match the source", async () => {
  const fake = new FakeIntegrationPlatform();
  const options = integrationOptions(["claude"]);
  await run(fake, installIntegrations(options));

  fake.assetFingerprint = "assets-v2";
  fake.assetPluginVersion = "0.2.0";
  fake.corruptNextRefreshCache = true;
  const failed = await run(fake, Effect.either(repairIntegrations(options)));
  expect(failed).toMatchObject({
    _tag: "Left",
    left: { reason: "invalid-response", provider: "claude" },
  });
  expect(fake.hosts.claude).toMatchObject({
    pluginInstalled: true,
    installedAssetFingerprint: "partial-cache",
    pluginVersion: "0.2.0",
  });
  expect(fake.files.get(RECEIPT_PATH)).toContain('"assetFingerprint": "assets-v1"');

  const status = await run(fake, statusIntegrations(options));
  expect(status).toMatchObject({
    ready: false,
    hosts: [{ state: "drifted", pluginInstalled: true, assetsCurrent: false }],
  });
  const mutationsBeforeRetry = fake.commands.filter(isMutation).length;
  const retry = await run(fake, Effect.either(repairIntegrations(options)));
  expect(retry).toMatchObject({
    _tag: "Left",
    left: { reason: "invalid-response", provider: "claude" },
  });
  expect(fake.commands.filter(isMutation)).toHaveLength(mutationsBeforeRetry);
});

test("rejects a forged Claude cache suffix outside the effective config directory", async () => {
  const fake = new FakeIntegrationPlatform();
  const options = integrationOptions(["claude"]);
  await run(fake, installIntegrations(options));

  fake.assetFingerprint = "assets-v2";
  fake.assetPluginVersion = "0.2.0";
  const forgedPath = "/tmp/forged/plugins/cache/meka-local/meka/0.1.0";
  fake.claudeInstallPathOverride = forgedPath;
  const outcome = await run(fake, Effect.either(repairIntegrations(options)));

  expect(outcome).toMatchObject({
    _tag: "Left",
    left: { reason: "invalid-response", provider: "claude" },
  });
  expect(fake.cachePathInspections.some((entry) => entry.filePath === forgedPath)).toBe(false);
  expect(fake.hosts.claude).toMatchObject({
    pluginInstalled: true,
    installedAssetFingerprint: "assets-v1",
    pluginVersion: "0.1.0",
  });
  expect(fake.files.get(RECEIPT_PATH)).toContain('"assetFingerprint": "assets-v1"');
});

test("treats an explicitly disabled Claude plugin as drifted with enable guidance", async () => {
  const fake = new FakeIntegrationPlatform();
  const options = integrationOptions(["claude"]);
  await run(fake, installIntegrations(options));
  fake.hosts.claude.enabled = false;

  const status = await run(fake, statusIntegrations(options));
  expect(status).toMatchObject({
    ready: false,
    hosts: [
      {
        state: "drifted",
        pluginInstalled: true,
        message: expect.stringContaining("claude plugin enable meka@meka-local --scope user"),
      },
    ],
  });

  const mutationsBeforeRepair = fake.commands.filter(isMutation).length;
  const repair = await run(fake, Effect.either(repairIntegrations(options)));
  expect(repair).toMatchObject({
    _tag: "Left",
    left: {
      reason: "invalid-response",
      provider: "claude",
      message: expect.stringContaining("claude plugin enable meka@meka-local --scope user"),
    },
  });
  expect(fake.commands.filter(isMutation)).toHaveLength(mutationsBeforeRepair);
  expect(fake.hosts.claude.enabled).toBe(false);
});

test("honors an absolute CLAUDE_CONFIG_DIR for cache verification and refresh", async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/custom/claude-config";
  try {
    const fake = new FakeIntegrationPlatform();
    const options = integrationOptions(["claude"]);
    await run(fake, installIntegrations(options));
    fake.assetFingerprint = "assets-v2";
    fake.assetPluginVersion = "0.2.0";

    const repaired = await run(fake, repairIntegrations(options));
    expect(repaired.ready).toBe(true);
    expect(
      fake.cachePathInspections.every(
        (entry) =>
          entry.rootDirectory === "/custom/claude-config" &&
          entry.filePath.startsWith("/custom/claude-config/plugins/cache/"),
      ),
    ).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test("resolves a relative CLAUDE_CONFIG_DIR from the inherited cwd", async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "relative-claude-config";
  const expectedRoot = path.resolve(process.cwd(), "relative-claude-config");
  try {
    const fake = new FakeIntegrationPlatform();
    const options = integrationOptions(["claude"]);
    await run(fake, installIntegrations(options));
    fake.assetFingerprint = "assets-v2";
    fake.assetPluginVersion = "0.2.0";

    const repaired = await run(fake, repairIntegrations(options));
    expect(repaired.ready).toBe(true);
    expect(
      fake.cachePathInspections.every(
        (entry) =>
          entry.rootDirectory === expectedRoot &&
          entry.filePath.startsWith(`${expectedRoot}${path.sep}plugins${path.sep}cache${path.sep}`),
      ),
    ).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
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
  readonly cachePathInspections: Array<{
    filePath: string;
    rootDirectory: string;
    parentDirectory: string;
  }> = [];
  readonly hosts: Record<
    IntegrationProvider,
    {
      source?: string;
      pluginInstalled: boolean;
      installedAssetFingerprint?: string;
      pluginVersion?: string;
      enabled?: boolean;
    }
  > = {
    codex: { pluginInstalled: false },
    claude: { pluginInstalled: false },
  };
  failNextWrite = false;
  failNextRefreshInstall = false;
  corruptNextRefreshCache = false;
  claudeInstallPathOverride: string | undefined;
  assetFingerprint = "assets-v1";
  assetPluginVersion = "0.1.0";
  lockAcquisitions = 0;
  maximumConcurrentLocks = 0;
  private activeLock: IntegrationLock | undefined;
  private lockSequence = 0;
  private readonly partialCaches = new Set<string>();

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
            ? [
                {
                  pluginId: "meka@meka-local",
                  name: "meka",
                  marketplaceName: "meka-local",
                  version: state.pluginVersion ?? this.assetPluginVersion,
                },
              ]
            : [
                {
                  id: "meka@meka-local",
                  version: state.pluginVersion ?? this.assetPluginVersion,
                  scope: "user",
                  enabled: state.enabled ?? true,
                  installPath:
                    this.claudeInstallPathOverride ??
                    claudeInstallPath(state.pluginVersion ?? this.assetPluginVersion),
                },
              ]
          : [];
        return result(
          provider === "codex" ? JSON.stringify({ installed }) : JSON.stringify(installed),
        );
      }
      if (matches(args, "plugin", "validate")) {
        return result("Validation passed");
      }
      const refreshing =
        (matches(args, "plugin", "add") && state.pluginInstalled) ||
        matches(args, "plugin", "update");
      if (refreshing && this.failNextRefreshInstall) {
        this.failNextRefreshInstall = false;
        if (provider === "claude") {
          this.partialCaches.add(claudeInstallPath(this.assetPluginVersion));
        }
        return result("", 1, "simulated refresh install failure");
      }
      if (
        matches(args, "plugin", "add") ||
        matches(args, "plugin", "install") ||
        matches(args, "plugin", "update")
      ) {
        state.pluginInstalled = true;
        state.installedAssetFingerprint =
          refreshing &&
          (this.corruptNextRefreshCache ||
            this.partialCaches.has(claudeInstallPath(this.assetPluginVersion)))
            ? "partial-cache"
            : this.assetFingerprint;
        this.corruptNextRefreshCache = false;
        this.partialCaches.delete(claudeInstallPath(this.assetPluginVersion));
        state.pluginVersion = this.assetPluginVersion;
        state.enabled = true;
        return result("{}");
      }
      if (matches(args, "plugin", "remove") || matches(args, "plugin", "uninstall")) {
        state.pluginInstalled = false;
        delete state.installedAssetFingerprint;
        delete state.pluginVersion;
        delete state.enabled;
        return result("{}");
      }
      throw new Error(`Unexpected command: ${command.executable} ${args.join(" ")}`);
    });

  readText = (filePath: string) =>
    Effect.succeed(
      filePath === path.join(ASSET_ROOT, ".claude-plugin", "marketplace.json")
        ? JSON.stringify({
            name: "meka-local",
            plugins: [{ name: "meka", version: this.assetPluginVersion }],
          })
        : this.files.get(filePath),
    );

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

  pathExistsInOwnedDirectory = (
    filePath: string,
    rootDirectory: string,
    parentDirectory: string,
  ) =>
    Effect.sync(() => {
      this.cachePathInspections.push({ filePath, rootDirectory, parentDirectory });
      const claude = this.hosts.claude;
      const activePath =
        this.claudeInstallPathOverride ??
        claudeInstallPath(claude.pluginVersion ?? this.assetPluginVersion);
      return (claude.pluginInstalled && filePath === activePath) || this.partialCaches.has(filePath);
    });

  canonicalPath = (filePath: string) => Effect.succeed(path.resolve(filePath));

  fingerprintTree = (directory: string) => {
    if (directory === path.join(ASSET_ROOT, "plugins", "meka")) {
      return Effect.succeed(this.assetFingerprint);
    }
    const claude = this.hosts.claude;
    if (
      claude.pluginInstalled &&
      directory === claudeInstallPath(claude.pluginVersion ?? this.assetPluginVersion)
    ) {
      return Effect.succeed(claude.installedAssetFingerprint ?? this.assetFingerprint);
    }
    return Effect.succeed(this.assetFingerprint);
  };

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
    !matches(command.args, "plugin", "marketplace", "list") &&
    !matches(command.args, "plugin", "validate")
  );
}

function result(stdout: string, exitCode = 0, stderr = ""): IntegrationCommandResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
  };
}

function claudeInstallPath(version: string): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const configDirectory = configured
    ? path.resolve(process.cwd(), configured)
    : path.join(os.homedir(), ".claude");
  return path.join(
    configDirectory,
    "plugins",
    "cache",
    "meka-local",
    "meka",
    version.replace("+", "-"),
  );
}
