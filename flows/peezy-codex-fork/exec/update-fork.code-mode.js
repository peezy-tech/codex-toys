const config = flow.config || {};
const payload = flow.event.payload || {};
const eventType = String(flow.event.type || "");
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

function cfg(name, fallback) {
  const value = config[name];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function enabled(name, fallback) {
  const override = flowFlagOverrides[name];
  if (typeof override === "boolean") {
    return override;
  }
  const value = config[name];
  return typeof value === "boolean" ? value : fallback;
}

function versionFromTag(tag) {
  const match = String(tag).match(/[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?/);
  return match ? match[0] : "";
}

async function env(name) {
  if (!name) {
    return "";
  }
  const result = await tools.exec_command({
    cmd: "printf %s \"${" + name + ":-}\"",
    workdir: flow.root,
    yield_time_ms: 1000,
    max_output_tokens: 2000
  });
  return trim(outputOf(result));
}

async function envFlag(name) {
  const value = (await env(name)).trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

async function run(label, cmd, options = {}) {
  const workdir = options.workdir || codexRepo;
  text("\n### " + label + "\n$ " + cmd + "\n");
  const raw = await tools.exec_command({
    cmd,
    workdir,
    yield_time_ms: options.yield_time_ms || 1000,
    max_output_tokens: options.max_output_tokens || 12000
  });
  const command = {
    label,
    cmd,
    workdir,
    exit_code: exitCodeOf(raw),
    output: outputOf(raw)
  };
  commands.push({ ...command, output: truncate(command.output, 4000) });
  text("exit_code=" + String(command.exit_code) + "\n" + truncate(command.output, options.textLimit || 12000) + "\n");
  return command;
}

function finish(status, message, artifacts = {}) {
  result({
    status,
    message,
    artifacts: {
      eventType,
      operation,
      releaseTag,
      version,
      codexRepo,
      targetBranch,
      upstreamBranch,
      patchPrefix,
      commands,
      ...artifacts
    }
  });
}

async function collectConflictContext(params) {
  const status = await run("patch rebuild conflict status", "git status --short --branch", { max_output_tokens: 12000 });
  const unmerged = await run("unmerged files", "git diff --name-only --diff-filter=U", { max_output_tokens: 12000 });
  const diffStat = await run("conflict diff stat", "git diff --cc --stat", { max_output_tokens: 12000 });
  const conflictDiff = await run("conflict diff", "git diff --cc", { max_output_tokens: 30000, textLimit: 20000 });
  const patchDetails = params.failedPatch
    ? await run(
      "failed patch details",
      "git show --stat --oneline --decorate --no-renames " + q(params.failedPatch.sha),
      { max_output_tokens: 16000, textLimit: 12000 }
    )
    : undefined;
  return {
    beforeSha: params.beforeSha,
    baseRef: params.baseRef,
    baseSha: params.baseSha,
    rebuildOutput: params.rebuildOutput,
    statusOutput: status.output,
    unmergedFiles: unmerged.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    diffStat: diffStat.output,
    conflictDiff: truncate(conflictDiff.output, 20000),
    failedPatch: params.failedPatch,
    patchDetails: patchDetails ? truncate(patchDetails.output, 12000) : undefined,
    applied: params.applied,
    interventionPrompt: [
      "Continue this same Code Mode thread to resolve the paused cherry-pick.",
      "Preserve the fork patch branch semantics: each patch/* branch remains one logical patch commit, main is rebuilt output, and upstream follows upstream/main.",
      "After resolving conflicts, continue the cherry-pick, update main to the rebuilt HEAD, switch back to main, and run the configured verification commands."
    ].join(" ")
  };
}

async function requireCleanWorktree() {
  const status = await run("dirty check", "git status --porcelain=v1", { max_output_tokens: 12000 });
  if (trim(status.output)) {
    finish("blocked", "Codex checkout has local changes before fork maintenance.", {
      dirtyStatus: status.output
    });
  }
}

async function requireNoPausedGitOperation() {
  const cherryPick = await run(
    "check existing cherry-pick state",
    "test -f \"$(git rev-parse --git-path CHERRY_PICK_HEAD)\"",
    { max_output_tokens: 4000 }
  );
  if (cherryPick.exit_code === 0) {
    const context = await collectConflictContext({
      beforeSha: undefined,
      baseRef: undefined,
      baseSha: undefined,
      rebuildOutput: "A cherry-pick was already in progress before this flow started.",
      applied: []
    });
    finish("blocked", "A cherry-pick is already in progress in the Codex checkout.", context);
  }

  const rebase = await run(
    "check existing rebase state",
    "test -d \"$(git rev-parse --git-path rebase-merge)\" -o -d \"$(git rev-parse --git-path rebase-apply)\"",
    { max_output_tokens: 4000 }
  );
  if (rebase.exit_code === 0) {
    finish("blocked", "A rebase is already in progress in the Codex checkout.", {
      statusOutput: (await run("rebase status", "git status --short --branch", { max_output_tokens: 12000 })).output
    });
  }
}

async function ensureUpstreamRemote() {
  const remote = await run(
    "ensure upstream openai/codex remote",
    "git remote get-url " + q(upstreamRemote) + " >/dev/null 2>&1 && git remote set-url " + q(upstreamRemote) + " " + q(upstreamRepoUrl) + " || git remote add " + q(upstreamRemote) + " " + q(upstreamRepoUrl),
    { max_output_tokens: 12000 }
  );
  if (!ok(remote)) {
    finish("failed", "Could not configure upstream remote.", { remoteOutput: remote.output });
  }
}

async function fetchUpstreamMainAndTags() {
  const refspec = "+refs/heads/" + upstreamMainRef + ":refs/remotes/" + upstreamRemote + "/" + upstreamMainRef;
  const fetch = await run(
    "fetch upstream main and tags",
    "git fetch " + q(upstreamRemote) + " --tags --prune " + q(refspec),
    { max_output_tokens: 20000, textLimit: 16000 }
  );
  if (!ok(fetch)) {
    finish("failed", "Could not fetch upstream main and release tags.", { fetchOutput: fetch.output });
  }
  const remoteMain = await run(
    "resolve upstream main",
    "git rev-parse --verify " + q("refs/remotes/" + upstreamRemote + "/" + upstreamMainRef + "^{commit}"),
    { max_output_tokens: 4000 }
  );
  if (!ok(remoteMain)) {
    finish("failed", "Could not resolve fetched upstream main.", { upstreamMainOutput: remoteMain.output });
  }

  const current = await currentBranch();
  if (current === upstreamBranch) {
    const switched = await run("switch away from upstream branch", "git switch " + q(targetBranch), {
      max_output_tokens: 12000
    });
    if (!ok(switched)) {
      const detached = await run("detach from upstream branch", "git switch --detach", { max_output_tokens: 12000 });
      if (!ok(detached)) {
        finish("failed", "Could not leave the upstream branch before updating it.", {
          switchOutput: switched.output,
          detachOutput: detached.output
        });
      }
    }
  }

  const update = await run(
    "update local upstream branch",
    "git update-ref " + q("refs/heads/" + upstreamBranch) + " " + q(trim(remoteMain.output)),
    { max_output_tokens: 12000 }
  );
  if (!ok(update)) {
    finish("failed", "Could not update local upstream branch.", { updateOutput: update.output });
  }
  return trim(remoteMain.output);
}

async function resolveReleaseBase() {
  const release = await run(
    "resolve release tag",
    "git rev-parse --verify " + q("refs/tags/" + releaseTag + "^{commit}"),
    { max_output_tokens: 4000 }
  );
  if (!ok(release)) {
    finish("failed", "Could not resolve upstream release tag after fetch.", {
      releaseTag,
      resolveOutput: release.output
    });
  }
  return trim(release.output);
}

async function currentBranch() {
  const branch = await run("current branch", "git rev-parse --abbrev-ref HEAD", { max_output_tokens: 4000 });
  return ok(branch) ? trim(branch.output) : "";
}

async function resolveCommit(ref) {
  const result = await run(
    "resolve " + ref,
    "git rev-parse --verify " + q(ref + "^{commit}"),
    { max_output_tokens: 4000 }
  );
  return ok(result) ? trim(result.output) : "";
}

async function resolveTree(ref) {
  const result = await run(
    "resolve tree " + ref,
    "git rev-parse --verify " + q(ref + "^{tree}"),
    { max_output_tokens: 4000 }
  );
  return ok(result) ? trim(result.output) : "";
}

async function listPatchBranches() {
  const refRoot = "refs/heads/" + patchPrefix.replace(/\/+$/, "");
  const result = await run(
    "list patch branches",
    "git for-each-ref --format='%(refname:short)%09%(objectname)%09%(contents:subject)' " + q(refRoot),
    { max_output_tokens: 20000, textLimit: 16000 }
  );
  if (!ok(result)) {
    finish("failed", "Could not list patch branches.", { patchListOutput: result.output });
  }
  const patches = trim(result.output)
    .split(/\r?\n/)
    .map((line) => {
      const parts = line.split("\t");
      return {
        name: parts[0] || "",
        sha: parts[1] || "",
        subject: parts[2] || ""
      };
    })
    .filter((patch) => patch.name.startsWith(patchPrefix) && patch.sha)
    .sort((left, right) => left.name.localeCompare(right.name));
  if (patches.length === 0) {
    finish("blocked", "No patch branches were found for prefix " + patchPrefix + ".");
  }
  return patches;
}

async function rebuildMainFromBase(baseRef, baseSha, beforeSha) {
  const beforeTree = beforeSha ? await resolveTree(targetBranch) : "";
  const patches = await listPatchBranches();
  const detach = await run("checkout rebuild base", "git switch --detach " + q(baseSha), {
    max_output_tokens: 12000
  });
  if (!ok(detach)) {
    finish("failed", "Could not switch to the rebuild base.", { checkoutOutput: detach.output });
  }

  const applied = [];
  for (const patch of patches) {
    const pick = await run("apply " + patch.name, "git cherry-pick " + q(patch.sha), {
      max_output_tokens: 30000,
      textLimit: 20000
    });
    if (!ok(pick)) {
      const context = await collectConflictContext({
        beforeSha,
        baseRef,
        baseSha,
        rebuildOutput: pick.output,
        failedPatch: patch,
        applied
      });
      finish("needs_intervention", "Patch workspace rebuild paused on " + patch.name + ".", context);
    }
    applied.push(patch);
  }

  const afterHead = await run("rebuilt head", "git rev-parse HEAD", { max_output_tokens: 4000 });
  const afterSha = trim(afterHead.output);
  const afterTree = await resolveTree("HEAD");

  if (beforeTree && afterTree && beforeTree === afterTree) {
    const restore = await run("restore target branch", "git switch " + q(targetBranch), { max_output_tokens: 12000 });
    if (!ok(restore)) {
      finish("failed", "Rebuilt tree matched target, but switching back failed.", { restoreOutput: restore.output });
    }
    return {
      changed: false,
      beforeSha,
      afterSha: beforeSha,
      rebuiltSha: afterSha,
      applied
    };
  }

  const update = await run("update target branch", "git branch -f " + q(targetBranch) + " " + q(afterSha), {
    max_output_tokens: 12000
  });
  if (!ok(update)) {
    finish("failed", "Could not update target branch after rebuild.", { updateOutput: update.output });
  }
  const target = await run("switch target branch", "git switch " + q(targetBranch), { max_output_tokens: 12000 });
  if (!ok(target)) {
    finish("failed", "Could not switch to target branch after rebuild.", { switchOutput: target.output });
  }

  return {
    changed: beforeSha !== afterSha,
    beforeSha,
    afterSha,
    rebuiltSha: afterSha,
    applied
  };
}

async function verifyBranchUpdateCandidate(rebuild) {
  const diffCheck = await run("codex diff whitespace check", "git diff --check", { max_output_tokens: 12000 });
  if (!ok(diffCheck)) {
    finish("failed", "Codex git diff --check failed after branch update.", {
      beforeSha: rebuild.beforeSha,
      afterSha: rebuild.afterSha,
      diffCheckOutput: diffCheck.output
    });
  }

  const cargoCheck = await run(
    "cargo check code mode packages",
    "CARGO_TARGET_DIR=" + q(cargoTargetDir) + " cargo check -p codex-app-server -p codex-core -p codex-app-server-protocol",
    { workdir: codexRustDir, max_output_tokens: 30000, textLimit: 20000 }
  );
  if (!ok(cargoCheck)) {
    finish("failed", "Cargo check failed after branch update.", {
      beforeSha: rebuild.beforeSha,
      afterSha: rebuild.afterSha,
      cargoCheckOutput: cargoCheck.output
    });
  }
}

async function verifyReleaseCandidate(rebuild) {
  const cargoVersion = await run(
    "validate Cargo.toml version",
    "grep -m1 '^version' " + q(codexRustDir + "/Cargo.toml") + " | sed -E 's/version *= *\"([^\"]+)\".*/\\1/'",
    { max_output_tokens: 4000 }
  );
  if (!ok(cargoVersion) || trim(cargoVersion.output) !== version) {
    finish("failed", "Release tag does not match codex-rs/Cargo.toml version.", {
      releaseTag,
      version,
      cargoVersion: trim(cargoVersion.output)
    });
  }

  const build = await run(
    "build fork binary",
    "CARGO_TARGET_DIR=" + q(cargoTargetDir) + " cargo build -p codex-cli --bin codex",
    { workdir: codexRustDir, max_output_tokens: 30000, textLimit: 20000 }
  );
  if (!ok(build)) {
    finish("failed", "Fork binary build failed.", {
      beforeSha: rebuild.beforeSha,
      afterSha: rebuild.afterSha,
      buildOutput: build.output
    });
  }

  const versionCheck = await run("verify fork binary", q(codexBinary) + " --version", { max_output_tokens: 4000 });
  if (!ok(versionCheck)) {
    finish("failed", "Built fork binary did not run.", {
      beforeSha: rebuild.beforeSha,
      afterSha: rebuild.afterSha,
      versionOutput: versionCheck.output
    });
  }

  const cargoCheck = await run(
    "cargo check code mode packages",
    "CARGO_TARGET_DIR=" + q(cargoTargetDir) + " cargo check -p codex-app-server -p codex-core -p codex-app-server-protocol",
    { workdir: codexRustDir, max_output_tokens: 30000, textLimit: 20000 }
  );
  if (!ok(cargoCheck)) {
    finish("failed", "Cargo check failed after release rebuild.", {
      beforeSha: rebuild.beforeSha,
      afterSha: rebuild.afterSha,
      cargoCheckOutput: cargoCheck.output
    });
  }

  const protocolTest = await run(
    "protocol code mode execute test",
    "CARGO_TARGET_DIR=" + q(cargoTargetDir) + " cargo test -p codex-app-server-protocol thread_code_mode_execute -- --nocapture",
    { workdir: codexRustDir, max_output_tokens: 30000, textLimit: 20000 }
  );
  if (!ok(protocolTest)) {
    finish("failed", "Protocol Code Mode API test failed after release rebuild.", {
      beforeSha: rebuild.beforeSha,
      afterSha: rebuild.afterSha,
      protocolTestOutput: protocolTest.output
    });
  }

  const fmt = await run("cargo fmt check", "cargo fmt --check", {
    workdir: codexRustDir,
    max_output_tokens: 20000
  });
  if (!ok(fmt)) {
    finish("failed", "Cargo fmt --check failed after release rebuild.", {
      beforeSha: rebuild.beforeSha,
      afterSha: rebuild.afterSha,
      fmtOutput: fmt.output
    });
  }

  const diffCheck = await run("codex diff whitespace check", "git diff --check", { max_output_tokens: 12000 });
  if (!ok(diffCheck)) {
    finish("failed", "Codex git diff --check failed after release rebuild.", {
      beforeSha: rebuild.beforeSha,
      afterSha: rebuild.afterSha,
      diffCheckOutput: diffCheck.output
    });
  }

  const artifacts = {
    codexBinary,
    codexVersion: trim(versionCheck.output)
  };
  if (enabled("stage_npm_wrapper", true)) {
    Object.assign(artifacts, await stageLocalNpmWrapper());
  }
  return artifacts;
}

async function detectLocalTargetTriple() {
  const target = await run(
    "detect local npm target triple",
    [
      "case \"$(uname -s):$(uname -m)\" in",
      "  Linux:x86_64) printf x86_64-unknown-linux-musl ;;",
      "  Linux:aarch64|Linux:arm64) printf aarch64-unknown-linux-musl ;;",
      "  Darwin:x86_64) printf x86_64-apple-darwin ;;",
      "  Darwin:arm64) printf aarch64-apple-darwin ;;",
      "  *) exit 1 ;;",
      "esac"
    ].join("\n"),
    { max_output_tokens: 4000 }
  );
  if (!ok(target) || !trim(target.output)) {
    finish("failed", "Could not infer local target triple for npm wrapper staging.", {
      targetOutput: target.output
    });
  }
  return trim(target.output);
}

async function stageLocalNpmWrapper() {
  const targetTriple = await detectLocalTargetTriple();
  const binaryName = targetTriple.includes("windows") ? "codex.exe" : "codex";
  const stage = await run(
    "stage local npm wrapper",
    [
      "set -euo pipefail",
      "stage_root=$(mktemp -d /tmp/peezy-codex-npm-stage.XXXXXX)",
      "package_dir=\"$stage_root/package\"",
      "python3 " + q(codexRepo + "/codex-cli/scripts/build_npm_package.py") + " --package codex --version " + q(version) + " --staging-dir \"$package_dir\"",
      "mkdir -p \"$package_dir/vendor/" + targetTriple + "/codex\"",
      "cp " + q(codexBinary) + " \"$package_dir/vendor/" + targetTriple + "/codex/" + binaryName + "\"",
      "chmod 0755 \"$package_dir/vendor/" + targetTriple + "/codex/" + binaryName + "\"",
      "node \"$package_dir/bin/codex.js\" --version",
      "printf '\\nSTAGED_PACKAGE=%s\\n' \"$package_dir\""
    ].join("\n"),
    { max_output_tokens: 20000, textLimit: 16000 }
  );
  if (!ok(stage)) {
    finish("failed", "Local npm wrapper staging failed.", { stageOutput: stage.output });
  }
  const match = stage.output.match(/STAGED_PACKAGE=(.+)/);
  const stagedPackage = match ? trim(match[1]) : "";
  if (enabled("link_local_package", false) && stagedPackage) {
    const link = await run("link local npm wrapper with Bun", "bun pm link", {
      workdir: stagedPackage,
      max_output_tokens: 12000
    });
    if (!ok(link)) {
      finish("failed", "Bun link of local Codex package failed.", { linkOutput: link.output, stagedPackage });
    }
  }
  return {
    targetTriple,
    stagedPackage,
    linked: enabled("link_local_package", false)
  };
}

async function maybePushTargetBranch(afterSha) {
  if (!enabled("push", false)) {
    return false;
  }
  const push = await run("push fork branch", "git push origin HEAD:" + q(targetBranch) + " --force-with-lease", {
    max_output_tokens: 20000
  });
  if (!ok(push)) {
    finish("failed", "Could not push rebuilt fork branch.", { pushOutput: push.output });
  }
  return true;
}

async function maybePublishReleaseTag() {
  if (!enabled("publish", false)) {
    return false;
  }
  const tagName = "rust-v" + version;
  const existing = await run("check release tag", "git rev-parse --verify " + q("refs/tags/" + tagName), {
    max_output_tokens: 4000
  });
  if (existing.exit_code !== 0) {
    const tag = await run("create release tag", "git tag -a " + q(tagName) + " -m " + q("Release " + version), {
      max_output_tokens: 12000
    });
    if (!ok(tag)) {
      finish("failed", "Could not create release tag.", { tagOutput: tag.output });
    }
  }
  const pushTag = await run("push release tag", "git push origin " + q(tagName), {
    max_output_tokens: 20000
  });
  if (!ok(pushTag)) {
    finish("failed", "Could not push release tag.", { pushTagOutput: pushTag.output });
  }
  return true;
}

function candidateRef(afterSha, pushed) {
  return {
    kind: "branch",
    repo: "peezy-tech/codex",
    remote: pushed ? "origin" : "local",
    ref: "refs/heads/" + targetBranch,
    sha: afterSha,
    pushed
  };
}

const flowFlagOverrides = {
  force: await envFlag("CODEX_FLOW_FORCE"),
  push: await envFlag("CODEX_FLOW_PUSH"),
  publish: await envFlag("CODEX_FLOW_PUBLISH"),
  stage_npm_wrapper: await envFlag("CODEX_FLOW_STAGE_NPM_WRAPPER"),
  link_local_package: await envFlag("CODEX_FLOW_LINK_LOCAL_PACKAGE")
};
const releaseTag = eventType === "upstream.release" ? String(payload.tag || "") : "";
const version = releaseTag ? versionFromTag(releaseTag) : "";
const operation = eventType === "upstream.release" ? "release-cycle" : "main-branch-update";
const packageName = cfg("package_name", "@peezy.tech/codex");
const targetBranch = (await env(cfg("target_branch_env", ""))) || cfg("target_branch", "main");
const upstreamBranch = cfg("upstream_branch", "upstream");
const patchPrefix = cfg("patch_prefix", "patch/");
const upstreamRemote = cfg("upstream_remote", "upstream");
const upstreamMainRef = cfg("upstream_main_ref", "main");
const upstreamRepoUrl = cfg("upstream_repo_url", "https://github.com/openai/codex.git");
const cargoTargetDir = (await env(cfg("cargo_target_dir_env", ""))) || cfg("cargo_target_dir", "/tmp/peezy-codex-flow-target");
const codexRepo = (await env(cfg("codex_repo_env", ""))) || cfg("codex_repo", "");
const codexRustDir = codexRepo + "/codex-rs";
const codexBinary = cargoTargetDir + "/debug/codex";

if (eventType !== "upstream.release" && eventType !== "upstream.branch_update") {
  finish("failed", "Unsupported event type " + eventType + ".");
}
if (String(payload.repo || "") !== "openai/codex") {
  finish("skipped", "Ignoring upstream event for " + String(payload.repo || "unknown") + ".");
}
if (eventType === "upstream.release" && !releaseTag) {
  finish("failed", "Release payload is missing tag.");
}
if (eventType === "upstream.release" && !version) {
  finish("failed", "Could not infer semantic version from release tag " + releaseTag + ".");
}
if (!codexRepo) {
  finish("blocked", "No Codex fork checkout configured. Set codex_repo or codex_repo_env in flow.toml.");
}

text([
  "Peezy Codex fork update flow",
  "",
  "Event type: " + eventType,
  "Operation: " + operation,
  releaseTag ? "Release: " + releaseTag : "Upstream ref: " + String(payload.ref || "refs/heads/" + upstreamMainRef),
  version ? "Version: " + version : undefined,
  "Target branch: " + targetBranch,
  "Upstream branch: " + upstreamBranch,
  "Patch prefix: " + patchPrefix,
  "Codex repo: " + codexRepo,
  "Upstream remote: " + upstreamRemote + " -> " + upstreamRepoUrl,
  "Cargo target dir: " + cargoTargetDir
].filter(Boolean).join("\n") + "\n");

if (eventType === "upstream.release") {
  const published = await run("published fork package check", "npm view " + q(packageName + "@" + version) + " version --json", {
    max_output_tokens: 4000
  });
  if (ok(published) && !enabled("force", false)) {
    finish("skipped", packageName + "@" + version + " is already published.");
  }
}

const repoCheck = await run("verify codex repo", "git rev-parse --show-toplevel");
if (!ok(repoCheck)) {
  finish("failed", "Codex repo is not a git checkout.", { repoCheck: repoCheck.output });
}

const rustWorkspaceCheck = await run("verify codex Rust workspace", "test -f " + q(codexRustDir + "/Cargo.toml"), {
  max_output_tokens: 4000
});
if (!ok(rustWorkspaceCheck)) {
  finish("failed", "Codex Rust workspace was not found at the expected codex-rs path.", {
    codexRustDir,
    rustWorkspaceCheck: rustWorkspaceCheck.output
  });
}

await run("codex status before update", "git status --short --branch", { max_output_tokens: 12000 });
await requireCleanWorktree();
await requireNoPausedGitOperation();
await ensureUpstreamRemote();
const upstreamMainSha = await fetchUpstreamMainAndTags();
const baseSha = eventType === "upstream.release" ? await resolveReleaseBase() : upstreamMainSha;
const baseRef = eventType === "upstream.release" ? releaseTag : upstreamBranch;
const beforeSha = await resolveCommit(targetBranch);
const rebuild = await rebuildMainFromBase(baseRef, baseSha, beforeSha);

const verificationArtifacts = eventType === "upstream.release"
  ? await verifyReleaseCandidate(rebuild)
  : await verifyBranchUpdateCandidate(rebuild).then(() => ({}));
const pushed = await maybePushTargetBranch(rebuild.afterSha);
const published = eventType === "upstream.release" ? await maybePublishReleaseTag() : false;
const finalStatus = await run("final codex status", "git status --short --branch", { max_output_tokens: 12000 });
const status = rebuild.changed ? "changed" : "completed";
finish(
  status,
  eventType === "upstream.release"
    ? "Peezy Codex fork rebuilt from upstream release and verified."
    : "Peezy Codex fork main rebuilt from upstream/main and verified.",
  {
    beforeSha: rebuild.beforeSha,
    afterSha: rebuild.afterSha,
    rebuiltSha: rebuild.rebuiltSha,
    baseRef,
    baseSha,
    upstreamMainSha,
    applied: rebuild.applied,
    finalStatus: finalStatus.output,
    pushed,
    published,
    candidateRefs: [candidateRef(rebuild.afterSha, pushed)],
    ...verificationArtifacts
  }
);
