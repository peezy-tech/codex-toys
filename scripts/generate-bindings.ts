import { spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "packages/sdk/src/providers/codex/app-server/generated");
const codexCommand = process.env.CODEX_APP_SERVER_CODEX_COMMAND ?? "codex";
const args = ["app-server", "generate-ts", "--experimental", "--out", outDir];

const child = spawn(codexCommand, args, {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

child.once("exit", (code, signal) => {
  if (code === 0) {
    void addEsmExtensions(outDir).catch((error: unknown) => {
      process.stderr.write(`failed to normalize generated imports: ${String(error)}\n`);
      process.exitCode = 1;
    });
    return;
  }
  process.exitCode = typeof code === "number" ? code : 1;
  if (signal) {
    process.stderr.write(`codex app-server generate-ts exited with ${signal}\n`);
  }
});

async function addEsmExtensions(directory: string): Promise<void> {
  const entries = await readdir(directory, { recursive: true });
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".ts"))
      .map(async (entry) => {
        const file = path.join(directory, entry);
        const input = await readFile(file, "utf8");
        const output = input.replace(
          /(\bfrom\s+["'])(\.\.?\/[^"']+)(["'])/g,
          (match, prefix: string, specifier: string, quote: string) =>
            path.extname(specifier) ? match : `${prefix}${specifier}.js${quote}`,
        );
        if (output !== input) {
          await writeFile(file, output);
        }
      }),
  );
}
