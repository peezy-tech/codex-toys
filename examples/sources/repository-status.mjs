import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const { stdout } = await run("git", ["status", "--porcelain=v1", "--branch"], {
  encoding: "utf8",
  maxBuffer: 512 * 1024,
});

const lines = stdout.trimEnd().split("\n").filter(Boolean);
process.stdout.write(
  JSON.stringify({
    branch: lines[0]?.replace(/^## /, "") ?? null,
    changes: lines.slice(1),
  }),
);
