import os from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import { defaultIntegrationReceiptPath } from "../src/integrations/manager.ts";

test("ignores a relative XDG_STATE_HOME instead of resolving it against the server cwd", () => {
  const previous = process.env.XDG_STATE_HOME;
  try {
    process.env.XDG_STATE_HOME = "relative-state";
    expect(defaultIntegrationReceiptPath()).toBe(
      path.join(os.homedir(), ".local", "state", "meka", "integrations.json"),
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});
