const release = config.release;
const commands = [];

function q(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

function trim(value) {
  return String(value || "").trim();
}

function truncate(value, max) {
  const textValue = String(value || "");
  if (textValue.length <= max) {
    return textValue;
  }
  return textValue.slice(0, max) + "\n...[truncated " + String(textValue.length - max) + " chars]";
}

function outputOf(result) {
  if (typeof result?.output === "string") {
    return result.output;
  }
  return JSON.stringify(result ?? {});
}

function exitCodeOf(result) {
  if (typeof result?.exit_code === "number") {
    return result.exit_code;
  }
  if (typeof result?.exitCode === "number") {
    return result.exitCode;
  }
  return null;
}

function ok(result) {
  return result.exit_code === 0;
}

async function run(label, cmd, options = {}) {
  const workdir = options.workdir || config.codexRepo;
  text("\n### " + label + "\n$ " + cmd + "\n");
  const raw = await tools.exec_command({
    cmd,
    workdir,
    yield_time_ms: options.yield_time_ms || 1000,
    max_output_tokens: options.max_output_tokens || 12000
  });
  const result = {
    label,
    cmd,
    workdir,
    exit_code: exitCodeOf(raw),
    output: outputOf(raw)
  };
  commands.push({
    ...result,
    output: truncate(result.output, 4000)
  });
  text("exit_code=" + String(result.exit_code) + "\n" + truncate(result.output, options.textLimit || 12000) + "\n");
  return result;
}

function finish(status, message, extra = {}) {
  const summary = {
    status,
    message,
    releaseTag: release.tagName,
    releaseUrl: release.url,
    targetCommitish: release.targetCommitish,
    ...extra,
    commands
  };
  text("\nCODEX_UPDATE_RESULT " + JSON.stringify(summary) + "\n");
  exit();
}

async function collectRebaseContext(rebaseOutput, beforeSha) {
  const status = await run("rebase conflict status", "git status --short --branch", { max_output_tokens: 12000 });
  const unmerged = await run("unmerged files", "git diff --name-only --diff-filter=U", { max_output_tokens: 12000 });
  const diffStat = await run("conflict diff stat", "git diff --cc --stat", { max_output_tokens: 12000 });
  const conflictDiff = await run("conflict diff", "git diff --cc", { max_output_tokens: 30000, textLimit: 20000 });
  const currentPatch = await run("current rebase patch", "git rebase --show-current-patch", { max_output_tokens: 20000, textLimit: 12000 });
  return {
    beforeSha,
    rebaseOutput,
    statusOutput: status.output,
    unmergedFiles: unmerged.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    diffStat: diffStat.output,
    conflictDiff: truncate(conflictDiff.output, 20000),
    currentPatch: truncate(currentPatch.output, 12000),
    interventionPrompt: "Continue this same thread to resolve the paused rebase. Preserve the native Code Mode replay/app-server changes, do not abort or reset unless explicitly instructed, then run the configured verification commands."
  };
}

text([
  "Codex upstream update job",
  "",
  "Release: " + release.tagName + (release.url ? " (" + release.url + ")" : ""),
  "Target branch: " + config.targetBranch,
  "Codex repo: " + config.codexRepo,
  "Codex Rust workspace: " + config.codexRustDir,
  "Service repo: " + config.serviceRepo,
  "Upstream remote: " + config.upstreamRemote + " -> " + config.upstreamRepoUrl,
  "Cargo target dir: " + config.cargoTargetDir
].join("\n") + "\n");

const repoCheck = await run("verify codex repo", "git rev-parse --show-toplevel");
if (!ok(repoCheck)) {
  finish("failed", "codex repo is not a git checkout", { repoCheck: repoCheck.output });
}

const rustWorkspaceCheck = await run(
  "verify codex Rust workspace",
  "test -f " + q(config.codexRustDir + "/Cargo.toml"),
  { max_output_tokens: 4000 }
);
if (!ok(rustWorkspaceCheck)) {
  finish("failed", "codex Rust workspace was not found at the expected codex-rs path", {
    codexRustDir: config.codexRustDir,
    rustWorkspaceCheck: rustWorkspaceCheck.output
  });
}

const existingRebase = await run(
  "check existing rebase state",
  "test -d \"$(git rev-parse --git-path rebase-merge)\" -o -d \"$(git rev-parse --git-path rebase-apply)\"",
  { max_output_tokens: 4000 }
);
if (existingRebase.exit_code === 0) {
  const context = await collectRebaseContext("A rebase was already in progress before this job started.", undefined);
  finish("blocked", "A rebase is already in progress in the codex checkout.", context);
}

await run("codex status before update", "git status --short --branch", { max_output_tokens: 12000 });
const branch = await run("current branch", "git rev-parse --abbrev-ref HEAD", { max_output_tokens: 4000 });
if (!ok(branch)) {
  finish("failed", "could not read current branch", { branchOutput: branch.output });
}

if (trim(branch.output) !== config.targetBranch) {
  const dirtyBeforeSwitch = await run("dirty check before branch switch", "git status --porcelain=v1", { max_output_tokens: 12000 });
  if (trim(dirtyBeforeSwitch.output)) {
    finish("blocked", "codex checkout has local changes before switching branches.", {
      dirtyStatus: dirtyBeforeSwitch.output
    });
  }
  const switched = await run("switch target branch", "git switch " + q(config.targetBranch), { max_output_tokens: 12000 });
  if (!ok(switched)) {
    finish("failed", "could not switch to target branch", { switchOutput: switched.output });
  }
}

const dirty = await run("dirty check on target branch", "git status --porcelain=v1", { max_output_tokens: 12000 });
if (trim(dirty.output)) {
  finish("blocked", "codex target branch has local changes. Resolve or stash them before updating.", {
    dirtyStatus: dirty.output
  });
}

const remote = await run(
  "ensure upstream openai/codex remote",
  "git remote get-url " + q(config.upstreamRemote) + " >/dev/null 2>&1 && git remote set-url " + q(config.upstreamRemote) + " " + q(config.upstreamRepoUrl) + " || git remote add " + q(config.upstreamRemote) + " " + q(config.upstreamRepoUrl),
  { max_output_tokens: 12000 }
);
if (!ok(remote)) {
  finish("failed", "could not configure upstream remote", { remoteOutput: remote.output });
}

const fetch = await run("fetch upstream tags", "git fetch " + q(config.upstreamRemote) + " --tags --prune", { max_output_tokens: 20000 });
if (!ok(fetch)) {
  finish("failed", "could not fetch upstream release tags", { fetchOutput: fetch.output });
}

const releaseCommit = await run(
  "resolve release tag",
  "git rev-parse --verify " + q("refs/tags/" + release.tagName + "^{commit}"),
  { max_output_tokens: 4000 }
);
if (!ok(releaseCommit)) {
  finish("failed", "could not resolve upstream release tag after fetch", {
    releaseTag: release.tagName,
    resolveOutput: releaseCommit.output
  });
}

const beforeHead = await run("codex head before rebase", "git rev-parse HEAD", { max_output_tokens: 4000 });
const rebase = await run("rebase target branch onto upstream release", "git rebase " + q(release.tagName), { max_output_tokens: 30000, textLimit: 20000 });
if (!ok(rebase)) {
  const context = await collectRebaseContext(rebase.output, trim(beforeHead.output));
  finish("conflict", "Rebase paused with conflicts.", context);
}

const afterHead = await run("codex head after rebase", "git rev-parse HEAD", { max_output_tokens: 4000 });
await run("codex status after rebase", "git status --short --branch", { max_output_tokens: 12000 });

const build = await run(
  "build explicit fork binary",
  "CARGO_TARGET_DIR=" + q(config.cargoTargetDir) + " cargo build -p codex-cli --bin codex",
  { workdir: config.codexRustDir, max_output_tokens: 30000, textLimit: 20000 }
);
if (!ok(build)) {
  finish("failed", "fork binary build failed", {
    beforeSha: trim(beforeHead.output),
    afterSha: trim(afterHead.output),
    buildOutput: build.output
  });
}

const version = await run("verify explicit fork binary", q(config.codexBinary) + " --version", { max_output_tokens: 4000 });
if (!ok(version)) {
  finish("failed", "built fork binary did not run", {
    beforeSha: trim(beforeHead.output),
    afterSha: trim(afterHead.output),
    versionOutput: version.output
  });
}

const cargoCheck = await run(
  "cargo check replay packages",
  "CARGO_TARGET_DIR=" + q(config.cargoTargetDir) + " cargo check -p codex-app-server -p codex-core -p codex-app-server-protocol",
  { workdir: config.codexRustDir, max_output_tokens: 30000, textLimit: 20000 }
);
if (!ok(cargoCheck)) {
  finish("failed", "cargo check failed after rebase", {
    beforeSha: trim(beforeHead.output),
    afterSha: trim(afterHead.output),
    cargoCheckOutput: cargoCheck.output
  });
}

const protocolTest = await run(
  "protocol code mode execute test",
  "CARGO_TARGET_DIR=" + q(config.cargoTargetDir) + " cargo test -p codex-app-server-protocol thread_code_mode_execute -- --nocapture",
  { workdir: config.codexRustDir, max_output_tokens: 30000, textLimit: 20000 }
);
if (!ok(protocolTest)) {
  finish("failed", "protocol replay API test failed after rebase", {
    beforeSha: trim(beforeHead.output),
    afterSha: trim(afterHead.output),
    protocolTestOutput: protocolTest.output
  });
}

const fmt = await run("cargo fmt check", "cargo fmt --check", {
  workdir: config.codexRustDir,
  max_output_tokens: 20000
});
if (!ok(fmt)) {
  finish("failed", "cargo fmt --check failed after rebase", {
    beforeSha: trim(beforeHead.output),
    afterSha: trim(afterHead.output),
    fmtOutput: fmt.output
  });
}

const codexDiffCheck = await run("codex diff whitespace check", "git diff --check", { max_output_tokens: 12000 });
if (!ok(codexDiffCheck)) {
  finish("failed", "codex git diff --check failed after rebase", {
    beforeSha: trim(beforeHead.output),
    afterSha: trim(afterHead.output),
    diffCheckOutput: codexDiffCheck.output
  });
}

const generate = await run(
  "regenerate codex-flows app-server TypeScript bindings",
  q(config.codexBinary) + " app-server generate-ts --experimental --out " + q(config.generatedDir),
  { workdir: config.serviceRepo, max_output_tokens: 30000, textLimit: 20000 }
);
if (!ok(generate)) {
  finish("failed", "failed to regenerate codex-flows TypeScript bindings from fork binary", {
    beforeSha: trim(beforeHead.output),
    afterSha: trim(afterHead.output),
    generateOutput: generate.output
  });
}

const generatedStatus = await run(
  "generated TypeScript binding status",
  "git status --short -- packages/codex-client/src/app-server/generated",
  { workdir: config.serviceRepo, max_output_tokens: 12000 }
);

const dependencyInstall = await run("refresh service dependencies", "vp install --frozen-lockfile", {
  workdir: config.serviceRepo,
  max_output_tokens: 20000
});
if (!ok(dependencyInstall)) {
  finish("failed", "vp install --frozen-lockfile failed in codex-flows", {
    beforeSha: trim(beforeHead.output),
    afterSha: trim(afterHead.output),
    dependencyInstallOutput: dependencyInstall.output
  });
}

const serviceTypes = await run("service typecheck", "vp run check:types", {
  workdir: config.serviceRepo,
  max_output_tokens: 30000,
  textLimit: 20000
});
if (!ok(serviceTypes)) {
  finish("failed", "codex-flows typecheck failed after generated binding update", {
    beforeSha: trim(beforeHead.output),
    afterSha: trim(afterHead.output),
    serviceTypesOutput: serviceTypes.output
  });
}

const serviceTests = await run("service tests", "vp run test", {
  workdir: config.serviceRepo,
  max_output_tokens: 30000,
  textLimit: 20000
});
if (!ok(serviceTests)) {
  finish("failed", "codex-flows tests failed after generated binding update", {
    beforeSha: trim(beforeHead.output),
    afterSha: trim(afterHead.output),
    serviceTestsOutput: serviceTests.output
  });
}

const serviceDiffCheck = await run("service diff whitespace check", "git diff --check", {
  workdir: config.serviceRepo,
  max_output_tokens: 12000
});
if (!ok(serviceDiffCheck)) {
  finish("failed", "codex-flows git diff --check failed", {
    beforeSha: trim(beforeHead.output),
    afterSha: trim(afterHead.output),
    serviceDiffCheckOutput: serviceDiffCheck.output
  });
}

const codexStatus = await run("final codex status", "git status --short --branch", { max_output_tokens: 12000 });
const serviceStatus = await run("final service status", "git status --short --branch", {
  workdir: config.serviceRepo,
  max_output_tokens: 12000
});

finish("completed", "Codex fork rebased onto upstream release and verified. Review diffs, push explicitly, and publish @peezy.tech/codex to npm when ready.", {
  beforeSha: trim(beforeHead.output),
  afterSha: trim(afterHead.output),
  codexHead: trim(afterHead.output),
  codexBinary: config.codexBinary,
  codexVersion: trim(version.output),
  generatedStatus: generatedStatus.output,
  codexStatus: codexStatus.output,
  serviceStatus: serviceStatus.output
});
