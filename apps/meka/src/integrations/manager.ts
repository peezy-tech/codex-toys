import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { IntegrationPlatform, type IntegrationPlatformService } from "./platform.ts";
import {
  IntegrationFailure,
  type IntegrationCommand,
  type IntegrationCommandResult,
  type IntegrationHostReceipt,
  type IntegrationHostStatus,
  type IntegrationOperation,
  type IntegrationOptions,
  type IntegrationProvider,
  type IntegrationReceipt,
  type IntegrationReport,
} from "./types.ts";

export const MEKA_MARKETPLACE_NAME = "meka-local";
export const MEKA_PLUGIN_NAME = "meka";

type ResolvedOptions = {
  providers: IntegrationProvider[];
  assetRoot: string;
  receiptPath: string;
  marketplaceName: string;
  pluginName: string;
  executables: Record<IntegrationProvider, string>;
  commandTimeoutMs: number;
  maxOutputBytes: number;
  lockTimeoutMs: number;
  staleLockMs: number;
};

type InspectedHost = {
  marketplaceInstalled: boolean;
  actualSource?: string;
  sourceMatches: boolean;
  pluginInstalled: boolean;
};

export function defaultIntegrationAssetRoot(): string {
  return fileURLToPath(new URL("../../assets/meka-integrations/", import.meta.url));
}

export function defaultIntegrationReceiptPath(): string {
  const configuredStateHome = process.env.XDG_STATE_HOME;
  const stateRoot =
    configuredStateHome && path.isAbsolute(configuredStateHome)
      ? configuredStateHome
      : path.join(os.homedir(), ".local", "state");
  return path.join(stateRoot, "meka", "integrations.json");
}

export function installIntegrations(
  options: IntegrationOptions = {},
): Effect.Effect<IntegrationReport, IntegrationFailure, IntegrationPlatform> {
  return reconcileIntegrations("install", options);
}

export function repairIntegrations(
  options: IntegrationOptions = {},
): Effect.Effect<IntegrationReport, IntegrationFailure, IntegrationPlatform> {
  return reconcileIntegrations("repair", options);
}

export function statusIntegrations(
  options: IntegrationOptions = {},
): Effect.Effect<IntegrationReport, IntegrationFailure, IntegrationPlatform> {
  return Effect.gen(function* () {
    const platform = yield* IntegrationPlatform;
    const resolved = yield* resolveOptionsEffect(options);
    const assetRoot = yield* platform.canonicalPath(resolved.assetRoot);
    const assetFingerprint = yield* platform.fingerprintTree(assetRoot);
    const receipt = yield* readReceipt(platform, resolved.receiptPath);
    const hosts: IntegrationHostStatus[] = [];
    for (const provider of resolved.providers) {
      const owned = receipt?.hosts[provider];
      const expectedSource = owned?.source ?? assetRoot;
      const status = yield* inspectHost(platform, provider, expectedSource, resolved).pipe(
        Effect.map((inspection) =>
          statusFromInspection(
            provider,
            expectedSource,
            assetFingerprint,
            resolved,
            inspection,
            owned,
          ),
        ),
        Effect.catchAll((error) =>
          Effect.succeed(
            unavailableStatus(
              provider,
              expectedSource,
              assetFingerprint,
              resolved,
              error.message,
              owned,
            ),
          ),
        ),
      );
      hosts.push(status);
    }
    return report("status", resolved, assetRoot, hosts);
  });
}

export function uninstallIntegrations(
  options: IntegrationOptions = {},
): Effect.Effect<IntegrationReport, IntegrationFailure, IntegrationPlatform> {
  return Effect.gen(function* () {
    const platform = yield* IntegrationPlatform;
    const resolved = yield* resolveOptionsEffect(options);
    const assetRoot = yield* platform.canonicalPath(resolved.assetRoot);
    const assetFingerprint = yield* platform.fingerprintTree(assetRoot);
    return yield* withMutationLock(platform, resolved, () =>
      Effect.gen(function* () {
        let receipt = yield* readReceipt(platform, resolved.receiptPath);
        const hosts: IntegrationHostStatus[] = [];

        for (const provider of resolved.providers) {
          const owned = receipt?.hosts[provider];
          if (!owned) {
            const observed = yield* inspectHost(platform, provider, assetRoot, resolved).pipe(
              Effect.map((inspection) => ({
                inspection,
                message: "No Meka-owned state was recorded",
              })),
              Effect.catchAll((error) =>
                Effect.succeed({
                  inspection: undefined,
                  message: `No Meka-owned state was recorded; ${error.message}`,
                }),
              ),
            );
            hosts.push(
              observed.inspection
                ? {
                    ...statusFromInspection(
                      provider,
                      assetRoot,
                      assetFingerprint,
                      resolved,
                      observed.inspection,
                      undefined,
                    ),
                    message: observed.message,
                  }
                : unavailableStatus(
                    provider,
                    assetRoot,
                    assetFingerprint,
                    resolved,
                    observed.message,
                    undefined,
                  ),
            );
            continue;
          }

          const inspection = yield* inspectHost(platform, provider, owned.source, resolved);
          const conflict = conflictFailure(provider, owned.source, inspection);
          if (conflict) {
            return yield* Effect.fail(conflict);
          }
          if (owned.pluginOwned && inspection.pluginInstalled) {
            yield* runChecked(
              platform,
              commandFor(provider, "remove-plugin", owned.source, resolved),
              provider,
            );
          }
          if (owned.marketplaceOwned && inspection.marketplaceInstalled) {
            yield* runChecked(
              platform,
              commandFor(provider, "remove-marketplace", owned.source, resolved),
              provider,
            );
          }

          receipt = withoutHost(receipt as IntegrationReceipt, provider, platform.now());
          yield* writeReceipt(platform, resolved.receiptPath, receipt);
          const finalInspection = yield* inspectHost(platform, provider, owned.source, resolved);
          hosts.push({
            ...statusFromInspection(
              provider,
              owned.source,
              assetFingerprint,
              resolved,
              finalInspection,
              undefined,
            ),
            marketplaceOwned: false,
            pluginOwned: false,
          });
        }

        return report("uninstall", resolved, assetRoot, hosts);
      }),
    );
  });
}

function reconcileIntegrations(
  operation: "install" | "repair",
  options: IntegrationOptions,
): Effect.Effect<IntegrationReport, IntegrationFailure, IntegrationPlatform> {
  return Effect.gen(function* () {
    const platform = yield* IntegrationPlatform;
    const resolved = yield* resolveOptionsEffect(options);
    const assetRoot = yield* platform.canonicalPath(resolved.assetRoot);
    const assetFingerprint = yield* platform.fingerprintTree(assetRoot);
    return yield* withMutationLock(platform, resolved, () =>
      Effect.gen(function* () {
        let receipt =
          (yield* readReceipt(platform, resolved.receiptPath)) ??
          emptyReceipt(resolved, platform.now());
        const identityFailure = receiptIdentityFailure(receipt, resolved);
        if (identityFailure) {
          return yield* Effect.fail(identityFailure);
        }
        const hosts: IntegrationHostStatus[] = [];

        for (const provider of resolved.providers) {
          const existingOwned = receipt.hosts[provider];
          if (existingOwned && !samePath(existingOwned.source, assetRoot)) {
            return yield* Effect.fail(
              new IntegrationFailure(
                "conflict",
                `${provider} is owned from ${existingOwned.source}; uninstall it before installing from ${assetRoot}`,
                provider,
              ),
            );
          }
          const reconciled = yield* reconcileHost(
            platform,
            provider,
            assetRoot,
            assetFingerprint,
            resolved,
            existingOwned,
            operation === "repair",
          );
          const updatedReceipt = withHost(receipt, provider, reconciled.receipt, platform.now());
          yield* writeReceipt(platform, resolved.receiptPath, updatedReceipt).pipe(
            Effect.catchAll((error) =>
              rollbackHost(
                platform,
                provider,
                assetRoot,
                resolved,
                reconciled.pluginAdded,
                reconciled.marketplaceAdded,
              ).pipe(Effect.flatMap(() => Effect.fail(error))),
            ),
          );
          receipt = updatedReceipt;
          hosts.push(reconciled.status);
        }

        return report(operation, resolved, assetRoot, hosts);
      }),
    );
  });
}

function withMutationLock<A>(
  platform: IntegrationPlatformService,
  options: ResolvedOptions,
  use: () => Effect.Effect<A, IntegrationFailure>,
): Effect.Effect<A, IntegrationFailure> {
  return Effect.acquireUseRelease(
    platform.acquireLock(`${options.receiptPath}.lock`, {
      timeoutMs: options.lockTimeoutMs,
      staleMs: options.staleLockMs,
    }),
    use,
    (lock) => platform.releaseLock(lock).pipe(Effect.orDie),
  );
}

function reconcileHost(
  platform: IntegrationPlatformService,
  provider: IntegrationProvider,
  expectedSource: string,
  assetFingerprint: string,
  options: ResolvedOptions,
  existingOwned: IntegrationHostReceipt | undefined,
  forceRefresh: boolean,
): Effect.Effect<
  {
    status: IntegrationHostStatus;
    receipt: IntegrationHostReceipt;
    marketplaceAdded: boolean;
    pluginAdded: boolean;
  },
  IntegrationFailure
> {
  let marketplaceAdded = false;
  let pluginAdded = false;
  let pluginRefreshed = false;
  const work = Effect.gen(function* () {
    let inspection = yield* inspectHost(platform, provider, expectedSource, options);
    const initialConflict = conflictFailure(provider, expectedSource, inspection);
    if (initialConflict) {
      return yield* Effect.fail(initialConflict);
    }
    if (!inspection.marketplaceInstalled) {
      yield* runChecked(
        platform,
        commandFor(provider, "add-marketplace", expectedSource, options),
        provider,
      );
      marketplaceAdded = true;
      inspection = yield* inspectHost(platform, provider, expectedSource, options);
      const addedConflict = conflictFailure(provider, expectedSource, inspection);
      if (addedConflict) {
        return yield* Effect.fail(addedConflict);
      }
      if (!inspection.marketplaceInstalled) {
        return yield* Effect.fail(
          new IntegrationFailure(
            "invalid-response",
            `${provider} did not report the Meka marketplace after adding it`,
            provider,
          ),
        );
      }
    }
    if (forceRefresh && existingOwned?.pluginOwned === true && inspection.pluginInstalled) {
      yield* runChecked(
        platform,
        commandFor(provider, "remove-plugin", expectedSource, options),
        provider,
      );
      const removedInspection = yield* inspectHost(platform, provider, expectedSource, options);
      const removedConflict = conflictFailure(provider, expectedSource, removedInspection);
      if (removedConflict) {
        return yield* Effect.fail(removedConflict);
      }
      if (removedInspection.pluginInstalled) {
        return yield* Effect.fail(
          new IntegrationFailure(
            "invalid-response",
            `${provider} still reported ${pluginId(options)} after uninstalling it for refresh`,
            provider,
          ),
        );
      }
      yield* runChecked(
        platform,
        commandFor(provider, "install-plugin", expectedSource, options),
        provider,
      );
      pluginRefreshed = true;
    } else if (!inspection.pluginInstalled) {
      yield* runChecked(
        platform,
        commandFor(provider, "install-plugin", expectedSource, options),
        provider,
      );
      pluginAdded = true;
    }
    const finalInspection = yield* inspectHost(platform, provider, expectedSource, options);
    const finalConflict = conflictFailure(provider, expectedSource, finalInspection);
    if (finalConflict) {
      return yield* Effect.fail(finalConflict);
    }
    if (!finalInspection.pluginInstalled) {
      return yield* Effect.fail(
        new IntegrationFailure(
          "invalid-response",
          `${provider} did not report ${pluginId(options)} after installation`,
          provider,
        ),
      );
    }
    const owned: IntegrationHostReceipt = {
      source: expectedSource,
      marketplaceOwned: existingOwned?.marketplaceOwned === true || marketplaceAdded,
      pluginOwned: existingOwned?.pluginOwned === true || pluginAdded,
      ...((pluginAdded || pluginRefreshed) && {
        assetFingerprint,
      }),
      ...(!pluginAdded && !pluginRefreshed && existingOwned?.assetFingerprint
        ? { assetFingerprint: existingOwned.assetFingerprint }
        : {}),
    };
    return {
      receipt: owned,
      status: statusFromInspection(
        provider,
        expectedSource,
        assetFingerprint,
        options,
        finalInspection,
        owned,
      ),
      marketplaceAdded,
      pluginAdded,
    };
  });

  return work.pipe(
    Effect.catchAll((error) =>
      rollbackHost(platform, provider, expectedSource, options, pluginAdded, marketplaceAdded).pipe(
        Effect.flatMap(() => Effect.fail(error)),
      ),
    ),
  );
}

function rollbackHost(
  platform: IntegrationPlatformService,
  provider: IntegrationProvider,
  source: string,
  options: ResolvedOptions,
  pluginAdded: boolean,
  marketplaceAdded: boolean,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (pluginAdded) {
      yield* runChecked(
        platform,
        commandFor(provider, "remove-plugin", source, options),
        provider,
      ).pipe(Effect.catchAll(() => Effect.void));
    }
    if (marketplaceAdded) {
      yield* runChecked(
        platform,
        commandFor(provider, "remove-marketplace", source, options),
        provider,
      ).pipe(Effect.catchAll(() => Effect.void));
    }
  });
}

function inspectHost(
  platform: IntegrationPlatformService,
  provider: IntegrationProvider,
  expectedSource: string,
  options: ResolvedOptions,
): Effect.Effect<InspectedHost, IntegrationFailure> {
  return Effect.gen(function* () {
    const marketplacesResult = yield* runChecked(
      platform,
      commandFor(provider, "list-marketplaces", expectedSource, options),
      provider,
    );
    const pluginsResult = yield* runChecked(
      platform,
      commandFor(provider, "list-plugins", expectedSource, options),
      provider,
    );
    const marketplaces = yield* decodeMarketplaceEntries(provider, marketplacesResult.stdout);
    const marketplace = marketplaces.find(
      (entry) => stringField(entry, "name") === options.marketplaceName,
    );
    const actualSource = marketplace ? marketplaceSource(marketplace) : undefined;
    const plugins = yield* decodeInstalledPluginEntries(provider, pluginsResult.stdout);
    const installed = plugins.some(
      (entry) =>
        stringField(entry, "pluginId") === pluginId(options) ||
        stringField(entry, "id") === pluginId(options) ||
        (stringField(entry, "name") === options.pluginName &&
          stringField(entry, "marketplaceName") === options.marketplaceName),
    );
    return {
      marketplaceInstalled: marketplace !== undefined,
      ...(actualSource ? { actualSource } : {}),
      sourceMatches: actualSource !== undefined && samePath(actualSource, expectedSource),
      pluginInstalled: installed,
    };
  });
}

function commandFor(
  provider: IntegrationProvider,
  action:
    | "list-marketplaces"
    | "add-marketplace"
    | "remove-marketplace"
    | "list-plugins"
    | "install-plugin"
    | "remove-plugin",
  source: string,
  options: ResolvedOptions,
): IntegrationCommand {
  const executable = options.executables[provider];
  let args: string[];
  if (provider === "codex") {
    switch (action) {
      case "list-marketplaces":
        args = ["plugin", "marketplace", "list", "--json"];
        break;
      case "add-marketplace":
        args = ["plugin", "marketplace", "add", source, "--json"];
        break;
      case "remove-marketplace":
        args = ["plugin", "marketplace", "remove", options.marketplaceName, "--json"];
        break;
      case "list-plugins":
        args = ["plugin", "list", "--json"];
        break;
      case "install-plugin":
        args = ["plugin", "add", pluginId(options), "--json"];
        break;
      case "remove-plugin":
        args = ["plugin", "remove", pluginId(options), "--json"];
        break;
    }
  } else {
    switch (action) {
      case "list-marketplaces":
        args = ["plugin", "marketplace", "list", "--json"];
        break;
      case "add-marketplace":
        args = ["plugin", "marketplace", "add", source, "--scope", "user"];
        break;
      case "remove-marketplace":
        args = ["plugin", "marketplace", "remove", options.marketplaceName];
        break;
      case "list-plugins":
        args = ["plugin", "list", "--json"];
        break;
      case "install-plugin":
        args = ["plugin", "install", pluginId(options), "--scope", "user"];
        break;
      case "remove-plugin":
        args = ["plugin", "uninstall", pluginId(options), "--scope", "user"];
        break;
    }
  }
  return {
    executable,
    args,
    timeoutMs: options.commandTimeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  };
}

function runChecked(
  platform: IntegrationPlatformService,
  command: IntegrationCommand,
  provider: IntegrationProvider,
): Effect.Effect<IntegrationCommandResult, IntegrationFailure> {
  return platform.run(command).pipe(
    Effect.flatMap((result) => {
      if (!result.timedOut && result.exitCode === 0) {
        return Effect.succeed(result);
      }
      const detail = firstLine(result.stderr) ?? firstLine(result.stdout);
      const message = result.timedOut
        ? `${provider} command timed out: ${command.executable} ${command.args.join(" ")}`
        : `${provider} command exited ${String(result.exitCode)}: ${command.executable} ${command.args.join(" ")}${detail ? `: ${detail}` : ""}`;
      return Effect.fail(new IntegrationFailure("command", message, provider));
    }),
  );
}

function statusFromInspection(
  provider: IntegrationProvider,
  expectedSource: string,
  assetFingerprint: string,
  options: ResolvedOptions,
  inspection: InspectedHost,
  owned: IntegrationHostReceipt | undefined,
): IntegrationHostStatus {
  const conflict = inspection.marketplaceInstalled && !inspection.sourceMatches;
  const complete = inspection.sourceMatches && inspection.pluginInstalled;
  const assetsCurrent =
    owned?.pluginOwned === true ? owned.assetFingerprint === assetFingerprint : undefined;
  const drifted = owned !== undefined && (!complete || assetsCurrent === false) && !conflict;
  return {
    provider,
    state: conflict ? "conflict" : drifted ? "drifted" : complete ? "installed" : "not-installed",
    executable: options.executables[provider],
    marketplaceName: options.marketplaceName,
    pluginId: pluginId(options),
    expectedSource,
    ...(inspection.actualSource ? { actualSource: inspection.actualSource } : {}),
    marketplaceInstalled: inspection.marketplaceInstalled,
    pluginInstalled: inspection.pluginInstalled,
    marketplaceOwned: owned?.marketplaceOwned === true,
    pluginOwned: owned?.pluginOwned === true,
    assetFingerprint,
    ...(owned?.assetFingerprint
      ? { installedAssetFingerprint: owned.assetFingerprint }
      : {}),
    ...(assetsCurrent === undefined ? {} : { assetsCurrent }),
    ...(conflict
      ? {
          message: `Marketplace ${options.marketplaceName} points to ${inspection.actualSource ?? "an unknown source"}`,
        }
      : assetsCurrent === false
        ? {
            message:
              "Installed plugin assets differ from this Meka package; run meka integration repair to refresh them",
          }
        : complete && provider === "codex"
        ? {
            message:
              "If these hooks are new or changed, review and trust them from Codex /hooks before expecting events",
          }
        : {}),
  };
}

function unavailableStatus(
  provider: IntegrationProvider,
  expectedSource: string,
  assetFingerprint: string,
  options: ResolvedOptions,
  message: string,
  owned: IntegrationHostReceipt | undefined,
): IntegrationHostStatus {
  return {
    provider,
    state: "unavailable",
    executable: options.executables[provider],
    marketplaceName: options.marketplaceName,
    pluginId: pluginId(options),
    expectedSource,
    marketplaceInstalled: false,
    pluginInstalled: false,
    marketplaceOwned: owned?.marketplaceOwned === true,
    pluginOwned: owned?.pluginOwned === true,
    assetFingerprint,
    ...(owned?.assetFingerprint
      ? { installedAssetFingerprint: owned.assetFingerprint }
      : {}),
    ...(owned?.pluginOwned === true
      ? { assetsCurrent: owned.assetFingerprint === assetFingerprint }
      : {}),
    message,
  };
}

function conflictFailure(
  provider: IntegrationProvider,
  expectedSource: string,
  inspection: InspectedHost,
): IntegrationFailure | undefined {
  if (inspection.marketplaceInstalled && !inspection.sourceMatches) {
    return new IntegrationFailure(
      "conflict",
      `${provider} marketplace ${MEKA_MARKETPLACE_NAME} is already registered from ${inspection.actualSource ?? "an opaque source"}; expected exactly ${expectedSource}`,
      provider,
    );
  }
  return undefined;
}

function resolveOptions(options: IntegrationOptions): ResolvedOptions {
  const providers = [...new Set(options.providers ?? ["codex", "claude"])] as IntegrationProvider[];
  if (providers.length === 0) {
    throw new IntegrationFailure(
      "invalid-response",
      "At least one integration provider is required",
    );
  }
  return {
    providers,
    assetRoot: path.resolve(options.assetRoot ?? defaultIntegrationAssetRoot()),
    receiptPath: path.resolve(options.receiptPath ?? defaultIntegrationReceiptPath()),
    marketplaceName: options.marketplaceName ?? MEKA_MARKETPLACE_NAME,
    pluginName: options.pluginName ?? MEKA_PLUGIN_NAME,
    executables: {
      codex: options.executables?.codex ?? "codex",
      claude: options.executables?.claude ?? "claude",
    },
    commandTimeoutMs: options.commandTimeoutMs ?? 15_000,
    maxOutputBytes: options.maxOutputBytes ?? 128 * 1024,
    lockTimeoutMs: positiveDuration(options.lockTimeoutMs, 15_000, "lockTimeoutMs"),
    staleLockMs: positiveDuration(options.staleLockMs, 60_000, "staleLockMs"),
  };
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new IntegrationFailure(
      "invalid-response",
      `${label} must be a positive integer number of milliseconds`,
    );
  }
  return resolved;
}

function resolveOptionsEffect(
  options: IntegrationOptions,
): Effect.Effect<ResolvedOptions, IntegrationFailure> {
  return Effect.try({
    try: () => resolveOptions(options),
    catch: (cause) =>
      cause instanceof IntegrationFailure
        ? cause
        : new IntegrationFailure("invalid-response", String(cause), undefined, { cause }),
  });
}

function decodeMarketplaceEntries(
  provider: IntegrationProvider,
  text: string,
): Effect.Effect<Record<string, unknown>[], IntegrationFailure> {
  return Effect.try({
    try: () => marketplaceEntries(provider, JSON.parse(text) as unknown),
    catch: (cause) =>
      cause instanceof IntegrationFailure
        ? cause
        : new IntegrationFailure(
            "invalid-response",
            `${provider} returned invalid JSON for marketplace list`,
            provider,
            { cause },
          ),
  });
}

function decodeInstalledPluginEntries(
  provider: IntegrationProvider,
  text: string,
): Effect.Effect<Record<string, unknown>[], IntegrationFailure> {
  return Effect.try({
    try: () => installedPluginEntries(JSON.parse(text) as unknown),
    catch: (cause) =>
      new IntegrationFailure(
        "invalid-response",
        `${provider} returned invalid JSON for plugin list`,
        provider,
        { cause },
      ),
  });
}

function marketplaceEntries(
  provider: IntegrationProvider,
  value: unknown,
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (isRecord(value)) {
    const entries = value.marketplaces;
    if (Array.isArray(entries)) {
      return entries.filter(isRecord);
    }
  }
  throw new IntegrationFailure(
    "invalid-response",
    `${provider} marketplace list returned an unsupported shape`,
    provider,
  );
}

function installedPluginEntries(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (isRecord(value) && Array.isArray(value.installed)) {
    return value.installed.filter(isRecord);
  }
  return [];
}

function marketplaceSource(entry: Record<string, unknown>): string | undefined {
  const nested = entry.marketplaceSource;
  if (isRecord(nested) && typeof nested.source === "string") {
    return nested.source;
  }
  const source = entry.source;
  if (isRecord(source)) {
    if (typeof source.path === "string") {
      return source.path;
    }
    if (typeof source.source === "string" && path.isAbsolute(source.source)) {
      return source.source;
    }
  }
  if (typeof entry.path === "string") {
    return entry.path;
  }
  if (typeof source === "string" && path.isAbsolute(source)) {
    return source;
  }
  if (typeof entry.root === "string") {
    return entry.root;
  }
  return undefined;
}

function readReceipt(
  platform: IntegrationPlatformService,
  receiptPath: string,
): Effect.Effect<IntegrationReceipt | undefined, IntegrationFailure> {
  return platform.readText(receiptPath).pipe(
    Effect.flatMap((text) => {
      if (text === undefined) {
        return Effect.succeed(undefined);
      }
      try {
        const value: unknown = JSON.parse(text);
        if (!isReceipt(value)) {
          return Effect.fail(
            new IntegrationFailure(
              "invalid-receipt",
              `Meka integration receipt is invalid: ${receiptPath}`,
            ),
          );
        }
        return Effect.succeed(value);
      } catch (cause) {
        return Effect.fail(
          new IntegrationFailure(
            "invalid-receipt",
            `Meka integration receipt is invalid: ${receiptPath}`,
            undefined,
            { cause },
          ),
        );
      }
    }),
  );
}

function writeReceipt(
  platform: IntegrationPlatformService,
  receiptPath: string,
  receipt: IntegrationReceipt,
): Effect.Effect<void, IntegrationFailure> {
  return Object.keys(receipt.hosts).length === 0
    ? platform.removeFile(receiptPath)
    : platform.writeTextAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

function emptyReceipt(options: ResolvedOptions, now: string): IntegrationReceipt {
  return {
    schemaVersion: 1,
    marketplaceName: options.marketplaceName,
    pluginName: options.pluginName,
    updatedAt: now,
    hosts: {},
  };
}

function withHost(
  receipt: IntegrationReceipt,
  provider: IntegrationProvider,
  owned: IntegrationHostReceipt,
  now: string,
): IntegrationReceipt {
  return { ...receipt, updatedAt: now, hosts: { ...receipt.hosts, [provider]: owned } };
}

function withoutHost(
  receipt: IntegrationReceipt,
  provider: IntegrationProvider,
  now: string,
): IntegrationReceipt {
  const hosts = { ...receipt.hosts };
  delete hosts[provider];
  return { ...receipt, updatedAt: now, hosts };
}

function receiptIdentityFailure(
  receipt: IntegrationReceipt,
  options: ResolvedOptions,
): IntegrationFailure | undefined {
  if (
    receipt.marketplaceName !== options.marketplaceName ||
    receipt.pluginName !== options.pluginName
  ) {
    return new IntegrationFailure(
      "conflict",
      `Receipt owns ${receipt.pluginName}@${receipt.marketplaceName}, not ${pluginId(options)}`,
    );
  }
  return undefined;
}

function isReceipt(value: unknown): value is IntegrationReceipt {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.marketplaceName !== "string" ||
    typeof value.pluginName !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isRecord(value.hosts)
  ) {
    return false;
  }
  const hosts = value.hosts;
  return (["codex", "claude"] as const).every((provider) => {
    const host = hosts[provider];
    return (
      host === undefined ||
      (isRecord(host) &&
        typeof host.source === "string" &&
        typeof host.marketplaceOwned === "boolean" &&
        typeof host.pluginOwned === "boolean" &&
        (host.assetFingerprint === undefined || typeof host.assetFingerprint === "string"))
    );
  });
}

function report(
  operation: IntegrationOperation,
  options: ResolvedOptions,
  assetRoot: string,
  hosts: IntegrationHostStatus[],
): IntegrationReport {
  const ready =
    operation === "uninstall"
      ? hosts.every((host) => !host.marketplaceOwned && !host.pluginOwned)
      : hosts.every((host) => host.state === "installed");
  return { operation, receiptPath: options.receiptPath, assetRoot, ready, hosts };
}

function pluginId(options: Pick<ResolvedOptions, "pluginName" | "marketplaceName">): string {
  return `${options.pluginName}@${options.marketplaceName}`;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function firstLine(value: string): string | undefined {
  const line = value.trim().split(/\r?\n/, 1)[0];
  return line ? line.slice(0, 1000) : undefined;
}
