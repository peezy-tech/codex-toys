import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probeCodexReadiness, type CodexReadiness } from "@meka/sdk";
import { MekaServer } from "./server.ts";

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export type MekaDoctorCheckId = "node" | "platform" | "runtime" | "codex" | "claude";

export type MekaDoctorCheck = {
  id: MekaDoctorCheckId;
  status: "pass" | "fail";
  detail: string;
};

export type MekaDoctorReport = {
  type: "meka.doctor";
  ready: boolean;
  checks: MekaDoctorCheck[];
  advisories: string[];
};

export type DoctorCommandResult = {
  code: number | null;
  stdout: string;
};

export type MekaDoctorOptions = {
  cwd?: string;
  runtimeRoot?: string;
  /** Overrides global hook state for deterministic probes and tests. */
  stateHome?: string;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  checkRuntime?: (options: { cwd?: string; runtimeRoot?: string; stateHome?: string }) => Promise<void>;
  checkCodex?: () => Promise<CodexReadiness>;
  runCommand?: (command: string, args: string[]) => Promise<DoctorCommandResult>;
};

/**
 * Preflights the local Meka runtime and provider credentials without starting a
 * provider thread or sending a model prompt.
 */
export async function runMekaDoctor(options: MekaDoctorOptions = {}): Promise<MekaDoctorReport> {
  const platform = options.platform ?? process.platform;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const platformCheck: MekaDoctorCheck =
    platform === "win32"
      ? failed("platform", "Meka private sockets are supported on POSIX hosts only")
      : passed("platform", `POSIX host detected (${platform})`);
  const nodeCheck = supportedNodeVersion(nodeVersion)
    ? passed("node", `Node ${nodeVersion} satisfies the required 24.x range`)
    : failed("node", `Node ${nodeVersion} does not satisfy the required 24.x range`);

  const runtimeCheck =
    platform === "win32"
      ? failed("runtime", "Skipped because this host does not support Unix sockets")
      : await checkRuntime(options);
  const [codexCheck, claudeCheck] = await Promise.all([checkCodex(options), checkClaude(options)]);
  const checks = [nodeCheck, platformCheck, runtimeCheck, codexCheck, claudeCheck];
  const baseReady = [nodeCheck, platformCheck, runtimeCheck].every(
    (check) => check.status === "pass",
  );
  const providerReady = [codexCheck, claudeCheck].some((check) => check.status === "pass");

  return {
    type: "meka.doctor",
    ready: baseReady && providerReady,
    checks,
    advisories: [
      "Doctor does not start a provider thread or send a model prompt.",
      "Meka runs use full provider permissions; use an external sandbox for untrusted work.",
    ],
  };
}

async function checkRuntime(options: MekaDoctorOptions): Promise<MekaDoctorCheck> {
  try {
    await (options.checkRuntime ?? probeRuntime)({
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.runtimeRoot ? { runtimeRoot: options.runtimeRoot } : {}),
      ...(options.stateHome ? { stateHome: options.stateHome } : {}),
    });
    return passed("runtime", "Private Unix socket creation and cleanup succeeded");
  } catch {
    return failed("runtime", "Meka could not create and clean up a private Unix socket");
  }
}

async function checkCodex(options: MekaDoctorOptions): Promise<MekaDoctorCheck> {
  try {
    const readiness = await (options.checkCodex ?? probeCodexReadiness)();
    if (!readiness.accountType) {
      return failed(
        "codex",
        "Codex app-server initialized, but no authenticated account is configured",
      );
    }
    return passed(
      "codex",
      `Codex app-server initialized with ${readiness.accountType} authentication`,
    );
  } catch {
    return failed("codex", "Codex app-server could not be initialized or authenticated");
  }
}

async function checkClaude(options: MekaDoctorOptions): Promise<MekaDoctorCheck> {
  try {
    const command = process.env.CLAUDE_CODE_EXECUTABLE ?? "claude";
    const result = await (options.runCommand ?? runCommand)(command, ["auth", "status", "--json"]);
    if (result.code !== 0) {
      return failed("claude", "Claude authentication status could not be read");
    }
    const status = parseClaudeStatus(result.stdout);
    if (!status?.loggedIn) {
      return failed("claude", "Claude is installed, but no authenticated account is configured");
    }
    const authMethod = typeof status.authMethod === "string" ? ` (${status.authMethod})` : "";
    return passed("claude", `Claude authentication is configured${authMethod}`);
  } catch {
    return failed("claude", "Claude authentication status could not be read");
  }
}

async function probeRuntime(options: {
  cwd?: string;
  runtimeRoot?: string;
  stateHome?: string;
}): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "meka-doctor-"));
  const server = new MekaServer({
    ...options,
    stateRoot: path.join(temporary, "state"),
    observeExternalAgents: false,
  });
  try {
    await server.start();
  } finally {
    await server.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

function parseClaudeStatus(
  value: string,
): { loggedIn?: unknown; authMethod?: unknown } | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as { loggedIn?: unknown; authMethod?: unknown };
  } catch {
    return undefined;
  }
}

function supportedNodeVersion(version: string): boolean {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return major === 24;
}

function passed(id: MekaDoctorCheckId, detail: string): MekaDoctorCheck {
  return { id, status: "pass", detail };
}

function failed(id: MekaDoctorCheckId, detail: string): MekaDoctorCheck {
  return { id, status: "fail", detail };
}

function runCommand(command: string, args: string[]): Promise<DoctorCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const stdout = new CappedOutput(MAX_COMMAND_OUTPUT_BYTES);
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      signalTree("SIGTERM");
      killTimer = setTimeout(() => {
        signalTree("SIGKILL");
      }, 1_000);
      killTimer.unref();
    }, COMMAND_TIMEOUT_MS);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve({ code, stdout: stdout.text });
    });

    function signalTree(signal: NodeJS.Signals): void {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process group may already have exited; try the direct child.
        }
      }
      child.kill(signal);
    }
  });
}

class CappedOutput {
  #parts: Buffer[] = [];
  #bytes = 0;

  constructor(readonly maximumBytes: number) {}

  push(chunk: Buffer): void {
    const remaining = this.maximumBytes - this.#bytes;
    if (remaining <= 0) {
      return;
    }
    const value = chunk.subarray(0, remaining);
    this.#parts.push(value);
    this.#bytes += value.length;
  }

  get text(): string {
    return Buffer.concat(this.#parts, this.#bytes).toString("utf8");
  }
}
