import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AutomationStateLocation, AutomationStateOptions } from "./types.ts";
import { AutomationValidationError } from "./errors.ts";

const ROOT_MODE = 0o700;

/**
 * Resolves a stable state directory without creating it. The default is scoped
 * to a canonical workspace path so independent workspaces do not share queue
 * state accidentally.
 */
export function resolveAutomationStateLocation(
  options: AutomationStateOptions = {},
): AutomationStateLocation {
  const requestedCwd = path.resolve(options.cwd ?? process.cwd());
  let cwd = requestedCwd;
  try {
    cwd = realpathSync(requestedCwd);
  } catch {
    // Callers that only resolve a future location still get a deterministic
    // lexical key; runtime opens require the workspace to exist and canonicalize it.
  }
  const workspaceKey = createHash("sha256").update(cwd).digest("hex").slice(0, 32);
  const root = options.stateRoot
    ? path.resolve(options.stateRoot)
    : path.join(resolveStateHome(options.stateHome), "meka", "automation", workspaceKey);
  return {
    root,
    databasePath: path.join(root, "automation.sqlite"),
    spoolPath: path.join(root, "spool"),
    workspaceKey,
  };
}

/** Creates and validates the private state root used by SQLite and the spool. */
export function ensureAutomationStateLocation(
  options: AutomationStateOptions = {},
): AutomationStateLocation {
  const location = resolveAutomationStateLocation(options);
  ensurePrivateDirectory(location.root);
  ensurePrivateDirectory(location.spoolPath);
  return location;
}

export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: ROOT_MODE });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new AutomationValidationError(
      `Automation state path must be a real directory: ${directory}`,
    );
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new AutomationValidationError(
      `Automation state path is not owned by the current user: ${directory}`,
    );
  }
  chmodSync(directory, ROOT_MODE);
}

function resolveStateHome(configured: string | undefined): string {
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new AutomationValidationError("stateHome must be an absolute path");
    }
    return configured;
  }
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && path.isAbsolute(xdg)) {
    return xdg;
  }
  return path.join(os.homedir(), ".local", "state");
}
