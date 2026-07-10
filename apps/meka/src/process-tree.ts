import type { ChildProcess } from "node:child_process";

/**
 * A spawned worker owns a process group on POSIX so the runtime can terminate
 * every descendant, including children that outlive or detach from the direct
 * process while retaining inherited descriptors.
 */
export const USES_PROCESS_GROUPS = process.platform !== "win32";

/** Best-effort, immediate cleanup of a spawned process and its POSIX group. */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (USES_PROCESS_GROUPS && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already be gone. Try the direct child below.
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
}
