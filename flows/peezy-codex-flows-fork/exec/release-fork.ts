import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type FlowContext = {
  flow: {
    config?: Record<string, unknown>;
    event: {
      id: string;
      payload?: Record<string, unknown>;
    };
  };
};

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const context = JSON.parse(await Bun.stdin.text()) as FlowContext;
const config = context.flow.config ?? {};
const payload = context.flow.event.payload ?? {};

function finish(value: Record<string, unknown>): never {
  process.stdout.write(`FLOW_RESULT ${JSON.stringify(value)}\n`);
  process.exit(0);
}

try {
  const sourcePackage = stringValue(payload.packageName);
  const sourceVersion = stringValue(payload.version);
  const packageName = stringConfig("package_name", "@peezy.tech/codex-flows");
  const codexPackageName = stringConfig("codex_package_name", "@peezy.tech/codex");

  if (!sourcePackage || !sourceVersion) {
    finish({ status: "failed", message: "downstream.release requires packageName and version." });
  }
  if (sourcePackage !== packageName && sourcePackage !== codexPackageName) {
    finish({ status: "skipped", message: `Ignoring downstream release for ${sourcePackage}.` });
  }

  const repoRoot = path.resolve(envConfig(stringConfig("codex_flows_repo_env", "")) || stringConfig("codex_flows_repo", process.cwd()));
  const sourceBranch = stringConfig("source_branch", "main");
  const forkBranch = stringConfig("fork_branch", "fork");
  const worktreeDir = path.resolve(repoRoot, stringConfig("worktree_dir", ".codex/flow-artifacts/codex-flows-fork-worktree"));
  const artifactDir = path.resolve(repoRoot, stringConfig("artifact_dir", ".codex/flow-artifacts/codex-flows-fork-release"));
  const fetchEnabled = enabled("fetch", true);
  const commitEnabled = enabled("commit", true);
  const pushEnabled = enabled("push", false);
  const publishEnabled = enabled("publish", false);
  const linkLocalPackage = enabled("link_local_package", false);

  await requireCleanRepo(repoRoot);
  if (fetchEnabled) {
    await runChecked("fetch source branch", ["git", "fetch", "origin", sourceBranch, "--prune"], repoRoot);
  }

  const baseVersion = sourcePackage === packageName
    ? sourceVersion
    : await readPackageVersion(path.join(repoRoot, "packages/codex-client/package.json"));
  const codexVersion = sourcePackage === codexPackageName
    ? sourceVersion
    : envConfig(stringConfig("codex_version_env", "")) || await npmPackageVersion(codexPackageName);
  const forkVersion = forkPackageVersion(baseVersion, codexVersion);
  const baseSha = (await runChecked("resolve source branch", ["git", "rev-parse", "--verify", `${sourceBranch}^{commit}`], repoRoot)).stdout.trim();

  await prepareWorktree(repoRoot, worktreeDir, forkBranch, sourceBranch);
  await applyForkOverlay({
    worktreeDir,
    packageName,
    codexPackageName,
    codexVersion,
    forkVersion,
  });

  await runChecked("install fork package dependency", ["bun", "install"], worktreeDir);
  await runChecked("fork release check", ["bun", "run", "--filter", packageName, "release:check"], worktreeDir);

  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  const pack = await runChecked(
    "pack fork release",
    ["npm", "pack", "--pack-destination", artifactDir],
    path.join(worktreeDir, "packages/codex-client"),
  );
  const tarball = pack.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  const tarballPath = tarball ? path.join(artifactDir, tarball) : undefined;

  if (linkLocalPackage) {
    await runChecked("link fork release package", ["bun", "pm", "link"], path.join(worktreeDir, "packages/codex-client"));
  }

  const status = await runChecked("read fork diff", ["git", "status", "--porcelain"], worktreeDir);
  let commitSha = "";
  if (commitEnabled && status.stdout.trim()) {
    await runChecked("stage fork release changes", [
      "git",
      "add",
      "--",
      "bun.lock",
      "packages/codex-client/package.json",
      "packages/codex-client/src/mode.ts",
      "packages/codex-client/src/app-server/stdio-transport.ts",
      "packages/codex-client/test/stdio-transport.test.ts",
    ], worktreeDir);
    await runChecked("commit fork release", [
      "git",
      "commit",
      "-m",
      `release: codex-flows fork ${forkVersion}`,
    ], worktreeDir);
    commitSha = (await runChecked("read fork commit", ["git", "rev-parse", "HEAD"], worktreeDir)).stdout.trim();
  } else {
    commitSha = (await runChecked("read fork head", ["git", "rev-parse", "HEAD"], worktreeDir)).stdout.trim();
  }

  let pushed = false;
  if (pushEnabled) {
    await runChecked("push fork branch", ["git", "push", "origin", `HEAD:refs/heads/${forkBranch}`, "--force-with-lease"], worktreeDir);
    pushed = true;
  }

  let published = false;
  if (publishEnabled && tarballPath) {
    await runChecked("publish fork package", [
      "npm",
      "publish",
      tarballPath,
      "--access",
      "public",
      "--tag",
      stringConfig("fork_dist_tag", "fork"),
    ], worktreeDir);
    published = true;
  }

  finish({
    status: "changed",
    message: `Prepared ${packageName} fork ${forkVersion} from ${sourcePackage}@${sourceVersion}.`,
    artifacts: {
      sourcePackage,
      sourceVersion,
      packageName,
      baseVersion,
      codexPackageName,
      codexVersion,
      forkVersion,
      sourceBranch,
      forkBranch,
      baseSha,
      commitSha,
      worktreeDir,
      tarballPath,
      linked: linkLocalPackage,
      pushed,
      published,
      candidateRefs: [{
        kind: "branch",
        repo: "peezy-tech/codex-flows",
        ref: `refs/heads/${forkBranch}`,
        sha: commitSha,
        pushed,
      }],
    },
  });
} catch (error) {
  finish({
    status: "failed",
    message: error instanceof Error ? error.message : String(error),
  });
}

async function requireCleanRepo(repoRoot: string): Promise<void> {
  const status = await runChecked("read repository status", ["git", "status", "--porcelain"], repoRoot);
  const relevant = status.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .filter((line) => !line.includes(".codex/flow-artifacts/"));
  if (relevant.length > 0) {
    finish({
      status: "blocked",
      message: "codex-flows checkout has local changes before fork release preparation.",
      artifacts: { status: relevant.join("\n") },
    });
  }
}

async function prepareWorktree(
  repoRoot: string,
  worktreeDir: string,
  forkBranch: string,
  sourceBranch: string,
): Promise<void> {
  if (existsSync(worktreeDir)) {
    await run("remove old fork worktree", ["git", "worktree", "remove", "--force", worktreeDir], repoRoot);
    await rm(worktreeDir, { recursive: true, force: true });
  }
  await run("prune worktrees", ["git", "worktree", "prune"], repoRoot);
  await runChecked("create fork worktree", ["git", "worktree", "add", "--force", "-B", forkBranch, worktreeDir, sourceBranch], repoRoot);
}

async function applyForkOverlay(input: {
  worktreeDir: string;
  packageName: string;
  codexPackageName: string;
  codexVersion: string;
  forkVersion: string;
}): Promise<void> {
  const packageJsonPath = path.join(input.worktreeDir, "packages/codex-client/package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  packageJson.version = input.forkVersion;
  packageJson.dependencies = sortRecord({
    ...(recordValue(packageJson.dependencies)),
    [input.codexPackageName]: input.codexVersion,
  });
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, "\t")}\n`, "utf8");

  const modePath = path.join(input.worktreeDir, "packages/codex-client/src/mode.ts");
  let modeText = await readFile(modePath, "utf8");
  if (!modeText.includes("CODEX_FLOWS_FORK_DEFAULT_CODE_MODE")) {
    modeText = modeText.replace(
      `export const DEFAULT_CODE_MODE_CODEX_PACKAGE = "${input.codexPackageName}";\n`,
      `export const DEFAULT_CODE_MODE_CODEX_PACKAGE = "${input.codexPackageName}";\nexport const CODEX_FLOWS_FORK_DEFAULT_CODE_MODE = true;\n`,
    );
  }
  modeText = modeText.replace(
    "return booleanEnv(env.CODEX_FLOWS_ENABLE_CODE_MODE) || codexFlowsMode(env) === CODEX_FLOWS_CODE_MODE;",
    [
      "if (booleanEnv(env.CODEX_FLOWS_DISABLE_CODE_MODE)) {",
      "\t\treturn false;",
      "\t}",
      "\treturn CODEX_FLOWS_FORK_DEFAULT_CODE_MODE || booleanEnv(env.CODEX_FLOWS_ENABLE_CODE_MODE) || codexFlowsMode(env) === CODEX_FLOWS_CODE_MODE;",
    ].join("\n\t"),
  );
  await writeFile(modePath, modeText, "utf8");

  const transportPath = path.join(input.worktreeDir, "packages/codex-client/src/app-server/stdio-transport.ts");
  let transportText = await readFile(transportPath, "utf8");
  transportText = transportText.replace(
    "return { command: DEFAULT_CODEX_COMMAND, args };",
    [
      "return {",
      "\t\tcommand: env.CODEX_APP_SERVER_BUNX_COMMAND?.trim() || \"bunx\",",
      "\t\targs: [DEFAULT_CODE_MODE_CODEX_PACKAGE, ...args],",
      "\t};",
    ].join("\n"),
  );
  await writeFile(transportPath, transportText, "utf8");

  const testPath = path.join(input.worktreeDir, "packages/codex-client/test/stdio-transport.test.ts");
  let testText = await readFile(testPath, "utf8");
  testText = testText.replace(
    [
      "expect(resolveCodexStdioCommand({}, {})).toEqual({",
      "\t\tcommand: \"codex\",",
      "\t\targs: [\"app-server\", \"--listen\", \"stdio://\", \"--enable\", \"apps\", \"--enable\", \"hooks\"],",
      "\t});",
    ].join("\n\t"),
    [
      "expect(resolveCodexStdioCommand({}, {})).toEqual({",
      "\t\tcommand: \"bunx\",",
      "\t\targs: [",
      "\t\t\tDEFAULT_CODEX_NPM_PACKAGE,",
      "\t\t\t\"app-server\",",
      "\t\t\t\"--listen\",",
      "\t\t\t\"stdio://\",",
      "\t\t\t\"--enable\",",
      "\t\t\t\"apps\",",
      "\t\t\t\"--enable\",",
      "\t\t\t\"hooks\",",
      "\t\t],",
      "\t});",
    ].join("\n\t"),
  );
  testText = testText.replace(
    [
      "expect(resolveCodexStdioCommand({}, { CODEX_FLOWS_ENABLE_CODE_MODE: \"1\" })).toEqual({",
      "\t\tcommand: \"codex\",",
      "\t\targs: [\"app-server\", \"--listen\", \"stdio://\", \"--enable\", \"apps\", \"--enable\", \"hooks\"],",
      "\t});",
    ].join("\n\t"),
    [
      "expect(resolveCodexStdioCommand({}, { CODEX_FLOWS_ENABLE_CODE_MODE: \"1\" })).toEqual({",
      "\t\tcommand: \"bunx\",",
      "\t\targs: [",
      "\t\t\tDEFAULT_CODEX_NPM_PACKAGE,",
      "\t\t\t\"app-server\",",
      "\t\t\t\"--listen\",",
      "\t\t\t\"stdio://\",",
      "\t\t\t\"--enable\",",
      "\t\t\t\"apps\",",
      "\t\t\t\"--enable\",",
      "\t\t\t\"hooks\",",
      "\t\t],",
      "\t});",
    ].join("\n\t"),
  );
  await writeFile(testPath, testText, "utf8");
}

function forkPackageVersion(baseVersion: string, codexVersion: string): string {
  const prefix = sanitizePrerelease(stringConfig("fork_version_prefix", "peezy"));
  const codex = sanitizePrerelease(codexVersion);
  return baseVersion.includes("-")
    ? `${baseVersion}.${prefix}.${codex}`
    : `${baseVersion}-${prefix}.${codex}`;
}

function sanitizePrerelease(value: string): string {
  return value
    .replace(/^v/, "")
    .replace(/[^0-9A-Za-z]+/g, ".")
    .split(".")
    .filter(Boolean)
    .join(".") || "0";
}

async function readPackageVersion(packageJsonPath: string): Promise<string> {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: string };
  if (!packageJson.version) {
    throw new Error(`Could not read package version from ${packageJsonPath}`);
  }
  return packageJson.version;
}

async function npmPackageVersion(packageName: string): Promise<string> {
  const result = await runChecked("read latest Codex fork package version", ["npm", "view", packageName, "version", "--json"], process.cwd());
  return JSON.parse(result.stdout) as string;
}

async function runChecked(label: string, command: string[], cwd: string): Promise<CommandResult> {
  const result = await run(label, command, cwd);
  if (result.code !== 0) {
    throw new Error(`${label} failed with exit ${result.code}:\n${result.stderr || result.stdout}`);
  }
  return result;
}

async function run(label: string, command: string[], cwd: string): Promise<CommandResult> {
  process.stderr.write(`+ ${label}: ${command.join(" ")}\n`);
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (stdout) process.stderr.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return { code, stdout, stderr };
}

function enabled(name: string, fallback: boolean): boolean {
  const envName = `CODEX_FLOW_${name.toUpperCase()}`;
  const envValue = process.env[envName];
  if (envValue !== undefined) {
    return booleanValue(envValue);
  }
  const value = config[name];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return booleanValue(value);
  return fallback;
}

function stringConfig(name: string, fallback: string): string {
  const value = config[name];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function envConfig(name: string): string | undefined {
  return name ? process.env[name]?.trim() || undefined : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sortRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function booleanValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
