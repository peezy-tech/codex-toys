export type IntegrationProvider = "codex" | "claude";

export type IntegrationOperation = "install" | "status" | "repair" | "uninstall";

export type IntegrationState =
  | "installed"
  | "not-installed"
  | "drifted"
  | "conflict"
  | "unavailable";

export type IntegrationHostStatus = {
  provider: IntegrationProvider;
  state: IntegrationState;
  executable: string;
  marketplaceName: string;
  pluginId: string;
  expectedSource: string;
  actualSource?: string;
  marketplaceInstalled: boolean;
  pluginInstalled: boolean;
  marketplaceOwned: boolean;
  pluginOwned: boolean;
  assetFingerprint: string;
  installedAssetFingerprint?: string;
  assetsCurrent?: boolean;
  message?: string;
};

export type IntegrationReport = {
  operation: IntegrationOperation;
  receiptPath: string;
  assetRoot: string;
  ready: boolean;
  hosts: IntegrationHostStatus[];
};

export type IntegrationHostReceipt = {
  source: string;
  marketplaceOwned: boolean;
  pluginOwned: boolean;
  /** Fingerprint of the asset tree copied into the provider plugin cache. */
  assetFingerprint?: string;
};

export type IntegrationReceipt = {
  schemaVersion: 1;
  marketplaceName: string;
  pluginName: string;
  updatedAt: string;
  hosts: Partial<Record<IntegrationProvider, IntegrationHostReceipt>>;
};

export type IntegrationOptions = {
  providers?: readonly IntegrationProvider[];
  assetRoot?: string;
  receiptPath?: string;
  marketplaceName?: string;
  pluginName?: string;
  executables?: Partial<Record<IntegrationProvider, string>>;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
};

export type IntegrationLock = {
  path: string;
  token: string;
};

export type IntegrationLockOptions = {
  timeoutMs: number;
  staleMs: number;
};

export type IntegrationCommand = {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  input?: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type IntegrationCommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
};

export type IntegrationFailureReason =
  | "command"
  | "conflict"
  | "filesystem"
  | "invalid-receipt"
  | "invalid-response"
  | "lock-timeout";

export class IntegrationFailure extends Error {
  readonly _tag = "IntegrationFailure";

  constructor(
    readonly reason: IntegrationFailureReason,
    message: string,
    readonly provider?: IntegrationProvider,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IntegrationFailure";
  }
}
