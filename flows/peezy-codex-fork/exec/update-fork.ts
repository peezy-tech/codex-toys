import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

type FlowContext = {
  flow: {
    name?: string;
    root?: string;
    step?: string;
    config?: Record<string, unknown>;
    event: {
      id?: string;
      type: string;
      payload?: Record<string, unknown>;
    };
  };
  runtime?: {
    workspaceBackendUrl?: string;
  };
};

type FlowResult = {
  status: "skipped" | "completed" | "changed" | "needs_intervention" | "blocked" | "failed";
  message?: string;
  artifacts?: Record<string, unknown>;
};

type CommandRecord = {
  label: string;
  cmd: string;
  workdir: string;
  exit_code: number;
  output: string;
};

class FlowStop extends Error {
  constructor(readonly value: FlowResult) {
    super(value.message ?? value.status);
  }
}

let config: Record<string, unknown> = {};
let payload: Record<string, unknown> = {};
let eventType = "";
let commands: CommandRecord[] = [];
let operation = "";
let releaseTag = "";
let version = "";
let packageName = "";
let targetBranch = "";
let upstreamBranch = "";
let patchPrefix = "";
let upstreamRemote = "";
let upstreamMainRef = "";
let upstreamRepoUrl = "";
let cargoTargetDir = "";
let codexRepo = "";
let codexRustDir = "";
let codexBinary = "";
let flowFlagOverrides: Record<string, boolean | undefined> = {};
let flowContext: FlowContext;

export default async function updateFork(context: FlowContext): Promise<FlowResult> {
  flowContext = context;
  config = context.flow.config ?? {};
  payload = context.flow.event.payload ?? {};
  eventType = String(context.flow.event.type || "");
  commands = [];

  try {
    return await runFlow();
  } catch (error) {
    if (error instanceof FlowStop) {
      return error.value;
    }
    return {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
      artifacts: { commands },
    };
  }
}

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

export function upstreamReleaseTagRef(tagName: string) {
  return "refs/codex-flow/upstream-release-tags/" + tagName;
}

export function parseRemoteTagRef(output: string, tagName: string) {
  const tagRef = "refs/tags/" + tagName;
  let objectSha = "";
  let commitSha = "";
  for (const line of String(output || "").split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) {
      continue;
    }
    if (ref === tagRef) {
      objectSha = sha;
      if (!commitSha) {
        commitSha = sha;
      }
    } else if (ref === tagRef + "^{}") {
      commitSha = sha;
    }
  }
  return objectSha ? { objectSha, commitSha } : undefined;
}

async function env(name) {
  return name ? trim(process.env[name] ?? "") : "";
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
  process.stderr.write("\n### " + label + "\n$ " + cmd + "\n");
  const proc = spawn("bash", ["-lc", cmd], {
    cwd: workdir,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    collectText(proc.stdout),
    collectText(proc.stderr),
    exitCodeFor(proc)
  ]);
  const output = stdout + stderr;
  const command = {
    label,
    cmd,
    workdir,
    exit_code: exitCode,
    output
  };
  commands.push({ ...command, output: truncate(command.output, 4000) });
  process.stderr.write("exit_code=" + String(command.exit_code) + "\n" + truncate(command.output, options.textLimit || 12000) + "\n");
  return command;
}

function finish(status, message, artifacts = {}) {
  throw new FlowStop({
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
  const context = {
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
  return {
    ...context,
    interventionTurn: await maybeRunInterventionTurn(context)
  };
}

async function maybeRunInterventionTurn(conflictContext) {
  if (!enabled("intervention_turn", true)) {
    return undefined;
  }
  try {
    const runCodexAgentTurnFromFlow = await loadRunCodexAgentTurnFromFlow();
    const threadJson = cfg("intervention_thread_json", ".codex/flow-artifacts/peezy-codex-fork-intervention-thread.json");
    const prompt = interventionPrompt(conflictContext);
    const turn = await runCodexAgentTurnFromFlow(
      {
        flow: {
          name: flowContext.flow.name ?? "peezy-codex-fork",
          root: flowContext.flow.root ?? codexRepo,
          step: flowContext.flow.step ?? operation,
          event: flowContext.flow.event,
        },
        runtime: flowContext.runtime,
      },
      {
        prompt,
        cwd: codexRepo,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        appServerUrl: process.env.CODEX_APP_SERVER_URL,
        requestTimeoutMs: numberConfig("intervention_request_timeout_ms", 900000),
        wait: {
          timeoutMs: numberConfig("intervention_wait_timeout_ms", 900000),
          throwOnFailure: false,
        },
        exportThreadJson: threadJson || false,
      },
    ) as {
      artifacts?: Record<string, unknown>;
      threadId?: string;
      turnId?: string;
      threadJsonPath?: string;
    };
    return {
      threadId: turn.threadId,
      turnId: turn.turnId,
      threadJsonPath: turn.threadJsonPath,
      ...(turn.artifacts ?? {}),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function interventionPrompt(conflictContext) {
  const failedPatch = conflictContext.failedPatch?.name;
  const failedPatchLabel = failedPatch ?? "the failed patch branch";
  const branchRefresh = failedPatch
    ? "After resolving this cherry-pick, run `git cherry-pick --continue`, update the failed patch branch to the new commit with `git branch -f " + failedPatch + " HEAD`, then continue applying any remaining ordered patch/* branches."
    : "After resolving this cherry-pick, run `git cherry-pick --continue`, identify the corresponding patch/* branch, update it to the new commit, then continue applying any remaining ordered patch/* branches.";
  const unmerged = Array.isArray(conflictContext.unmergedFiles) && conflictContext.unmergedFiles.length
    ? conflictContext.unmergedFiles.map((file) => "- " + file).join("\n")
    : "- none recorded";
  return [
    "The peezy-codex-fork release flow stopped during a Git patch-stack rebuild.",
    "",
    "Repository:",
    codexRepo,
    "",
    "Release event:",
    releaseTag ? "openai/codex " + releaseTag : "openai/codex upstream branch update",
    "",
    "Paused operation:",
    "A cherry-pick of " + failedPatchLabel + " is in progress and needs conflict resolution.",
    "",
    "Unmerged files:",
    unmerged,
    "",
    "Required outcome:",
    "Resolve the cherry-pick in this checkout without aborting it.",
    "Preserve the patch-stack model: each patch/* branch remains one logical patch commit, and main is rebuilt from the upstream release/base plus the ordered patch branches.",
    branchRefresh,
    "When all patch commits are applied, update `main` to the rebuilt HEAD and switch back to `main`.",
    "Run the configured verification checks for this release flow before finishing.",
    "",
    "Important constraints:",
    "Do not push, publish, delete unrelated branches, or revert unrelated user changes.",
    "If you cannot complete the rebuild safely, leave the repository in its current paused state and explain the blocker.",
    "",
    "Conflict context:",
    conflictContext.statusOutput || "",
    "",
    "Conflict diff:",
    conflictContext.conflictDiff || "",
  ].join("\n");
}

async function loadRunCodexAgentTurnFromFlow() {
  const candidates = [
    "@peezy.tech/codex-flows/flows",
    flowContext.flow.root
      ? pathToFileURL(path.resolve(flowContext.flow.root, "../..", "packages/codex-client/src/app-server/flows.ts")).href
      : undefined,
  ].filter(Boolean);
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const module = await import(String(candidate)) as { runCodexAgentTurnFromFlow?: unknown };
      if (typeof module.runCodexAgentTurnFromFlow === "function") {
        return module.runCodexAgentTurnFromFlow as (context: unknown, options: Record<string, unknown>) => Promise<unknown>;
      }
      errors.push(String(candidate) + ": runCodexAgentTurnFromFlow is not exported");
    } catch (error) {
      errors.push(String(candidate) + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  throw new Error("Could not load codex-flows follow-up turn helper:\n" + errors.join("\n"));
}

function numberConfig(name, fallback) {
  const envName = "CODEX_FLOW_" + name.toUpperCase();
  const envValue = process.env[envName];
  const raw = envValue !== undefined ? envValue : config[name];
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : fallback;
  return Number.isFinite(value) ? value : fallback;
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
    const failedPatch = await currentCherryPickPatchBranch();
    const context = await collectConflictContext({
      beforeSha: undefined,
      baseRef: undefined,
      baseSha: undefined,
      rebuildOutput: "A cherry-pick was already in progress before this flow started.",
      failedPatch,
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

async function currentCherryPickPatchBranch() {
  const head = await run("resolve paused cherry-pick commit", "git rev-parse --verify CHERRY_PICK_HEAD", {
    max_output_tokens: 4000
  });
  if (!ok(head)) {
    return undefined;
  }
  const sha = trim(head.output);
  const patches = await listPatchBranches();
  return patches.find((patch) => patch.sha === sha);
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
  const tagRefspec = releaseTag ? " " + q("+refs/tags/" + releaseTag + ":" + upstreamReleaseTagRef(releaseTag)) : "";
  const fetch = await run(
    releaseTag ? "fetch upstream main and release tag" : "fetch upstream main",
    "git fetch " + q(upstreamRemote) + " --no-tags --prune " + q(refspec) + tagRefspec,
    { max_output_tokens: 20000, textLimit: 16000 }
  );
  if (!ok(fetch)) {
    finish("failed", releaseTag ? "Could not fetch upstream main and release tag." : "Could not fetch upstream main.", { fetchOutput: fetch.output });
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
  const releaseRef = upstreamReleaseTagRef(releaseTag);
  const release = await run(
    "resolve release tag",
    "git rev-parse --verify " + q(releaseRef + "^{commit}"),
    { max_output_tokens: 4000 }
  );
  if (!ok(release)) {
    finish("failed", "Could not resolve upstream release tag after fetch.", {
      releaseTag,
      releaseRef,
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
      const resolved = await rebuildResultFromIntervention({
        beforeSha,
        patches,
        context
      });
      if (resolved) {
        return resolved;
      }
      finish("needs_intervention", "Patch workspace rebuild paused on " + patch.name + ".", context);
    }
    const appliedSha = await run("resolve rebuilt " + patch.name, "git rev-parse --verify HEAD", {
      max_output_tokens: 4000
    });
    if (!ok(appliedSha)) {
      finish("failed", "Could not resolve rebuilt patch commit for " + patch.name + ".", {
        patch,
        appliedShaOutput: appliedSha.output
      });
    }
    const refreshed = await run("refresh patch branch " + patch.name, "git branch -f " + q(patch.name) + " HEAD", {
      max_output_tokens: 12000
    });
    if (!ok(refreshed)) {
      finish("failed", "Could not refresh patch branch " + patch.name + " after cherry-pick.", {
        patch,
        refreshOutput: refreshed.output
      });
    }
    applied.push({ ...patch, sha: trim(appliedSha.output) });
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

async function rebuildResultFromIntervention(input) {
  const turn = input.context.interventionTurn;
  if (!turn || turn.error) {
    return undefined;
  }

  if (turn.turnStatus && turn.turnStatus !== "completed") {
    return undefined;
  }

  const cherryPick = await run(
    "post-intervention cherry-pick state",
    "test -f \"$(git rev-parse --git-path CHERRY_PICK_HEAD)\"",
    { max_output_tokens: 4000 }
  );
  if (cherryPick.exit_code === 0) {
    return undefined;
  }

  const rebase = await run(
    "post-intervention rebase state",
    "test -d \"$(git rev-parse --git-path rebase-merge)\" -o -d \"$(git rev-parse --git-path rebase-apply)\"",
    { max_output_tokens: 4000 }
  );
  if (rebase.exit_code === 0) {
    return undefined;
  }

  const branch = await currentBranch();
  if (branch !== targetBranch) {
    const switched = await run("post-intervention switch target branch", "git switch " + q(targetBranch), {
      max_output_tokens: 12000
    });
    if (!ok(switched)) {
      return undefined;
    }
  }

  const dirty = await run("post-intervention dirty check", "git status --porcelain=v1", {
    max_output_tokens: 12000
  });
  if (trim(dirty.output)) {
    return undefined;
  }

  const afterHead = await run("post-intervention target head", "git rev-parse --verify " + q(targetBranch + "^{commit}"), {
    max_output_tokens: 4000
  });
  const afterSha = trim(afterHead.output);
  if (!ok(afterHead) || !afterSha) {
    return undefined;
  }

  return {
    changed: input.beforeSha !== afterSha,
    beforeSha: input.beforeSha,
    afterSha,
    rebuiltSha: afterSha,
    applied: await listPatchBranches(),
    interventionTurn: turn
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
    const link = await run("link local npm wrapper", "pnpm link --global", {
      workdir: stagedPackage,
      max_output_tokens: 12000
    });
    if (!ok(link)) {
      finish("failed", "Local Codex package link failed.", { linkOutput: link.output, stagedPackage });
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

async function maybePublishReleaseTag(afterSha) {
  if (!enabled("publish", false)) {
    return undefined;
  }
  const tagName = "rust-v" + version;
  const remote = await run("check remote release tag", "git ls-remote --tags origin " + q("refs/tags/" + tagName), {
    max_output_tokens: 12000
  });
  if (!ok(remote)) {
    finish("failed", "Could not check remote release tag.", { remoteTagOutput: remote.output });
  }
  const remoteTag = parseRemoteTagRef(remote.output, tagName);
  if (remoteTag && remoteTag.commitSha !== afterSha) {
    process.stderr.write(
      "Release tag " + tagName + " currently points at " + remoteTag.commitSha +
      " on origin; updating it to rebuilt fork commit " + afterSha + ".\n"
    );
  }

  const tag = await run(
    "create release tag",
    "git tag -f -a " + q(tagName) + " " + q(afterSha) + " -m " + q("Release " + version),
    { max_output_tokens: 12000 }
  );
  if (!ok(tag)) {
    finish("failed", "Could not create release tag.", { tagOutput: tag.output });
  }

  const pushCommand = remoteTag
    ? "git push origin --force-with-lease=" + q("refs/tags/" + tagName + ":" + remoteTag.objectSha) + " " + q("refs/tags/" + tagName + ":refs/tags/" + tagName)
    : "git push origin " + q("refs/tags/" + tagName + ":refs/tags/" + tagName);
  const pushTag = await run("push release tag", pushCommand, {
    max_output_tokens: 20000
  });
  if (!ok(pushTag)) {
    finish("failed", "Could not push release tag.", {
      tagName,
      afterSha,
      remoteTag,
      pushTagOutput: pushTag.output
    });
  }
  return {
    tagName,
    ref: "refs/tags/" + tagName,
    sha: afterSha,
    pushed: true,
    previousRemoteSha: remoteTag?.commitSha,
    previousRemoteObjectSha: remoteTag?.objectSha
  };
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

function releaseCandidateRef(tagPublish) {
  return {
    kind: "tag",
    repo: "peezy-tech/codex",
    remote: tagPublish.pushed ? "origin" : "local",
    ref: tagPublish.ref,
    sha: tagPublish.sha,
    pushed: tagPublish.pushed
  };
}

async function collectText(stream: NodeJS.ReadableStream | null): Promise<string> {
  let output = "";
  if (!stream) {
    return output;
  }
  for await (const chunk of stream) {
    output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  }
  return output;
}

function exitCodeFor(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

async function runFlow(): Promise<FlowResult> {
  flowFlagOverrides = {
    force: await envFlag("CODEX_FLOW_FORCE"),
    push: await envFlag("CODEX_FLOW_PUSH"),
    publish: await envFlag("CODEX_FLOW_PUBLISH"),
    stage_npm_wrapper: await envFlag("CODEX_FLOW_STAGE_NPM_WRAPPER"),
    link_local_package: await envFlag("CODEX_FLOW_LINK_LOCAL_PACKAGE")
  };
  releaseTag = eventType === "upstream.release" ? String(payload.tag || "") : "";
  version = releaseTag ? versionFromTag(releaseTag) : "";
  operation = eventType === "upstream.release" ? "release-cycle" : "main-branch-update";
  packageName = cfg("package_name", "@peezy.tech/codex");
  targetBranch = (await env(cfg("target_branch_env", ""))) || cfg("target_branch", "main");
  upstreamBranch = cfg("upstream_branch", "upstream");
  patchPrefix = cfg("patch_prefix", "patch/");
  upstreamRemote = cfg("upstream_remote", "upstream");
  upstreamMainRef = cfg("upstream_main_ref", "main");
  upstreamRepoUrl = cfg("upstream_repo_url", "https://github.com/openai/codex.git");
  cargoTargetDir = (await env(cfg("cargo_target_dir_env", ""))) || cfg("cargo_target_dir", "/tmp/peezy-codex-flow-target");
  codexRepo = (await env(cfg("codex_repo_env", ""))) || cfg("codex_repo", "");
  codexRustDir = codexRepo + "/codex-rs";
  codexBinary = cargoTargetDir + "/debug/codex";

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

  process.stderr.write([
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
  const tagPublish = eventType === "upstream.release" ? await maybePublishReleaseTag(rebuild.afterSha) : undefined;
  const published = Boolean(tagPublish);
  const candidateRefs = [candidateRef(rebuild.afterSha, pushed)];
  if (tagPublish) {
    candidateRefs.push(releaseCandidateRef(tagPublish));
  }
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
      releaseTagPublish: tagPublish,
      candidateRefs,
      ...verificationArtifacts
    }
  );
}
