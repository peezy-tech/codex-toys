import { createHash } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";

/**
 * Hashes the executable local module graph without executing it. Bare package
 * imports stay external; relative/static TypeScript, JavaScript, and JSON
 * dependencies are bundled into the revision fingerprint.
 */
export async function hashWorkflowRevision(filePath: string): Promise<string> {
  const entry = path.resolve(filePath);
  const result = await build({
    entryPoints: [entry],
    absWorkingDir: path.dirname(entry),
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "external",
    treeShaking: false,
    legalComments: "none",
    logLevel: "silent",
  });
  const digest = createHash("sha256");
  for (const output of [...result.outputFiles].sort((left, right) => left.path.localeCompare(right.path))) {
    digest.update(output.path);
    digest.update("\0");
    digest.update(output.contents);
    digest.update("\0");
  }
  return digest.digest("hex");
}
