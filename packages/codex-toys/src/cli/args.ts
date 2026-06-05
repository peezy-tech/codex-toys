import { validateMethodName } from "./actions.ts";
import { parseFeedMode, type FeedItemStatus, type FeedModeInput } from "@codex-toys/feed";
import { parseMode, type DeferredRunIntentStatus, type DeferredReasoningEffort, type WorkbenchModeInput } from "@codex-toys/workbench";
import type { MemoryTransplantDirection } from "./memories.ts";

export type ParsedRemoteOptions = {
	sshTarget?: string;
	cwd?: string;
	remotePathPrepend?: string;
	toyboxCommand?: string;
	remoteCodexCommand?: string;
	remoteCodexArgs?: string[];
};

export type RemoteTurnApprovalPolicy =
	| "never"
	| "on-failure"
	| "on-request"
	| "untrusted";

export type RemoteTurnSandbox =
	| "danger-full-access"
	| "read-only"
	| "workspace-write";

export type DelegationReturnMode =
	| "detached"
	| "record_only"
	| "wake_on_done"
	| "wake_on_group"
	| "manual";

type ParsedCliBase =
	| { type: "help" }
	| {
			type: "mcp-serve";
			timeoutMs: number;
	  }
	| {
			type: "fetch";
			appUrl: string;
			workbenchUrl: string;
			timeoutMs: number;
			color: boolean;
			json: boolean;
	  }
	| {
			type: "remote-preflight";
			cwd?: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "host-overview";
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "toybox-serve";
			cwd?: string;
			timeoutMs: number;
	  }
	| {
			type: "workflow-run";
			target?: string;
			scriptPath?: string;
			scriptStdin: boolean;
			eventPath?: string;
			prompt?: string;
			workbenchRoot?: string;
			cwd?: string;
			via: "workbench" | "app";
			appUrl: string;
			workbenchUrl: string;
			timeoutMs: number;
			sandbox?: RemoteTurnSandbox;
			approvalPolicy?: RemoteTurnApprovalPolicy;
			permissions?: string;
			model?: string;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workflow-list";
			workbenchRoot?: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| { type: "app-actions" }
	| {
			type: "turn-run";
			prompt: string;
			threadId?: string;
			cwd?: string;
			appUrl: string;
			workbenchUrl: string;
			timeoutMs: number;
			wait: boolean;
			sandbox?: RemoteTurnSandbox;
			approvalPolicy?: RemoteTurnApprovalPolicy;
			permissions?: string;
			model?: string;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "app-call";
			method: string;
			paramsText?: string;
			paramsFile?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "functions-list";
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "functions-describe";
			name: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "functions-call";
			name: string;
			paramsText?: string;
			paramsFile?: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "feed-doctor";
			mode?: FeedModeInput;
			feedRoot?: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "feed-source-list";
			mode?: FeedModeInput;
			feedRoot?: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "feed-poll";
			mode?: FeedModeInput;
			feedRoot?: string;
			sourceId?: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "feed-item-list";
			mode?: FeedModeInput;
			feedRoot?: string;
			sourceId?: string;
			status?: FeedItemStatus;
			limit?: number;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "feed-item-read";
			itemId: string;
			mode?: FeedModeInput;
			feedRoot?: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "feed-collect";
			mode?: FeedModeInput;
			feedRoot?: string;
			cursor?: string;
			sourceId?: string;
			status?: FeedItemStatus;
			limit?: number;
			advance: boolean;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "feed-cursor-advance";
			mode?: FeedModeInput;
			feedRoot?: string;
			cursor?: string;
			itemId: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "feed-dispatch";
			mode?: FeedModeInput;
			feedRoot?: string;
			cursor?: string;
			sourceId: string;
			target: string;
			limit?: number;
			poll: boolean;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "feed-prune";
			mode?: FeedModeInput;
			feedRoot?: string;
			olderThanDays: number;
			dryRun: boolean;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| { type: "workbench-methods"; url: string; timeoutMs: number; pretty: boolean }
	| {
			type: "workbench-overview";
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workbench-delegate-list";
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workbench-delegate-start";
			targetCwd: string;
			prompt?: string;
			title?: string;
			groupId?: string;
			returnMode?: DelegationReturnMode;
			wait: boolean;
			allowAbsoluteCwd: boolean;
			url: string;
			timeoutMs: number;
			sandbox?: RemoteTurnSandbox;
			approvalPolicy?: RemoteTurnApprovalPolicy;
			permissions?: string;
			model?: string;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workbench-doctor";
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			appUrl: string;
			workbenchUrl: string;
			timeoutMs: number;
			color: boolean;
			json: boolean;
	  }
	| {
			type: "workbench-tick";
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-run";
			taskId: string;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-deferred-create";
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			paramsText?: string;
			paramsFile?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-deferred-list";
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workbench-deferred-read";
			intentId: string;
			includeOutput: boolean;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workbench-deferred-collect";
			cursor?: string;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workbench-deferred-cancel";
			intentId: string;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-deferred-retry";
			intentId: string;
			runAt?: string;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-deferred-run-due";
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-deferred-prune";
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			olderThanDays: number;
			dryRun: boolean;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-prompt-enqueue";
			prompt: string;
			title?: string;
			queue?: string;
			labels: string[];
			runAt?: string;
			afterIntentId?: string;
			afterStatus?: "completed" | "failed" | "canceled" | "terminal";
			threadId?: string;
			cwd?: string;
			model?: string;
			serviceTier?: string;
			effort?: DeferredReasoningEffort;
			sandbox?: RemoteTurnSandbox;
			approvalPolicy?: RemoteTurnApprovalPolicy;
			permissions?: string;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-prompt-list";
			status?: DeferredRunIntentStatus;
			queue?: string;
			limit?: number;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workbench-prompt-read";
			intentId: string;
			includeOutput: boolean;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workbench-prompt-collect";
			cursor?: string;
			queue?: string;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workbench-prompt-cancel";
			intentId: string;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-prompt-retry";
			intentId: string;
			runAt?: string;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-prompt-run-due";
			queue?: string;
			limit?: number;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-handoff-enqueue";
			prompt: string;
			title?: string;
			queue?: string;
			labels: string[];
			runAt?: string;
			afterIntentId?: string;
			afterStatus?: "completed" | "failed" | "canceled" | "terminal";
			targetHost?: string;
			requiredCapabilities: string[];
			requesterHost?: string;
			requesterThreadId?: string;
			threadId?: string;
			cwd?: string;
			model?: string;
			serviceTier?: string;
			effort?: DeferredReasoningEffort;
			sandbox?: RemoteTurnSandbox;
			approvalPolicy?: RemoteTurnApprovalPolicy;
			permissions?: string;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-handoff-list";
			status?: DeferredRunIntentStatus;
			queue?: string;
			targetHost?: string;
			capabilities: string[];
			limit?: number;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workbench-handoff-read";
			intentId: string;
			includeOutput: boolean;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workbench-handoff-collect";
			cursor?: string;
			queue?: string;
			targetHost?: string;
			capabilities: string[];
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "workbench-handoff-cancel";
			intentId: string;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-handoff-retry";
			intentId: string;
			runAt?: string;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-handoff-drain";
			queue?: string;
			hostId?: string;
			capabilities: string[];
			limit?: number;
			materialize: boolean;
			promptQueue?: string;
			mode?: WorkbenchModeInput;
			workbenchRoot?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-init-actions";
			workbenchRoot?: string;
			forgejo: boolean;
			github: boolean;
			runnerImage?: string | null;
			overwrite: boolean;
			pretty: boolean;
	  }
	| {
			type: "workbench-call";
			method: string;
			paramsText?: string;
			paramsFile?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "workbench-app-call";
			method: string;
			paramsText?: string;
			paramsFile?: string;
			url: string;
			timeoutMs: number;
			pretty: boolean;
	  }
	| {
			type: "actions-prepare-auth";
			workbenchRoot?: string;
			pretty: boolean;
	  }
	| {
			type: "actions-cleanup";
			workbenchRoot?: string;
			pretty: boolean;
	  }
	| {
			type: "memories-transplant";
			direction: MemoryTransplantDirection;
			workbenchRoot?: string;
			globalCodexHome?: string;
			workbenchCodexHome?: string;
			apply: boolean;
			overwrite: boolean;
			merge?: "codex";
			backup: boolean;
			json: boolean;
	  }
	| {
			type: "threads-locate";
			threadId: string;
			codexHome?: string;
			json: boolean;
	  }
	| {
			type: "threads-inspect";
			threadIdOrPath: string;
			json: boolean;
			codexHome?: string;
	  }
	| {
			type: "threads-install-rollout";
			rolloutPath: string;
			codexHome?: string;
			replace: boolean;
			cwd?: string;
			preserveCwd: boolean;
			json: boolean;
	  }
	| {
			type: "threads-transplant";
			threadId: string;
			fromCodexHome?: string;
			toCodexHome?: string;
			replace: boolean;
			cwd?: string;
			preserveCwd: boolean;
			json: boolean;
	  }
	| {
			type: "kit-inspect";
			source: string;
			ref?: string;
			json: boolean;
	  }
	| {
			type: "kit-add";
			source: string;
			ref?: string;
			workbenchRoot?: string;
			apply: boolean;
			overwrite: boolean;
			include: string[];
			exclude: string[];
			json: boolean;
	  }
	| {
			type: "kit-setup";
			source: string;
			ref?: string;
			workbenchRoot?: string;
			overwrite: boolean;
			prompt?: string;
			appUrl: string;
			workbenchUrl: string;
			timeoutMs: number;
			wait: boolean;
			sandbox?: RemoteTurnSandbox;
			approvalPolicy?: RemoteTurnApprovalPolicy;
			permissions?: string;
			model?: string;
			json: boolean;
			pretty: boolean;
	  }
	| {
			type: "kit-doctor";
			workbenchRoot?: string;
			json: boolean;
	  }
	| {
			type: "kit-list";
			workbenchRoot?: string;
			json: boolean;
	  };

export type ParsedCli = ParsedCliBase & ParsedRemoteOptions;

export const LOCAL_TOYBOX_URL = "toybox://local";
export const SSH_TOYBOX_URL = "ssh://toybox";
const defaultTimeoutMs = 90_000;
const defaultLongRunningTurnTimeoutMs = 30 * 60 * 1000;

export function parseArgs(
	argv: string[],
	env: Record<string, string | undefined> = process.env,
): ParsedCli {
	const positionals: string[] = [];
	let appUrl = LOCAL_TOYBOX_URL;
	let workbenchUrl = LOCAL_TOYBOX_URL;
	let timeoutMs = defaultTimeoutMs;
	let pretty = true;
	let color = true;
	let json = false;
	let eventPath: string | undefined;
	let scriptPath: string | undefined;
	let scriptStdin = false;
	let mode: WorkbenchModeInput | undefined;
	let feedMode: FeedModeInput | undefined;
	let workbenchRoot: string | undefined;
	let feedRoot: string | undefined;
	let globalCodexHome: string | undefined;
	let workbenchCodexHome: string | undefined;
	let codexHome: string | undefined;
	let fromCodexHome: string | undefined;
	let toCodexHome: string | undefined;
	let apply = false;
	let overwrite = false;
	let replace = false;
	let preserveCwd = false;
	let merge: "codex" | undefined;
	let backup = true;
	let ref: string | undefined;
	let forgejo = false;
	let github = false;
	let runnerImage: string | null | undefined;
	let prompt: string | undefined;
	let title: string | undefined;
	let groupId: string | undefined;
	let returnMode: DelegationReturnMode | undefined;
	let targetCwd: string | undefined;
	let threadId: string | undefined;
	let wait = false;
	let allowAbsoluteCwd = false;
	let dryRun = false;
	let includeOutput = false;
	let olderThanDays: number | undefined;
	let cursor: string | undefined;
	let runAt: string | undefined;
	let model: string | undefined;
	let serviceTier: string | undefined;
	let effort: DeferredReasoningEffort | undefined;
	let queue: string | undefined;
	let promptQueue: string | undefined;
	let afterIntentId: string | undefined;
	let afterStatus: "completed" | "failed" | "canceled" | "terminal" | undefined;
	let status: DeferredRunIntentStatus | undefined;
	let feedStatus: FeedItemStatus | undefined;
	let sourceId: string | undefined;
	let limit: number | undefined;
	let itemId: string | undefined;
	let targetHost: string | undefined;
	let hostId: string | undefined;
	let requesterHost: string | undefined;
	let requesterThreadId: string | undefined;
	let materialize = false;
	let all = false;
	let advance = true;
	let poll = true;
	let dispatchTarget: string | undefined;
	let paramsJson: string | undefined;
	let paramsFile: string | undefined;
	let cwd: string | undefined = env.CODEX_TOYS_REMOTE_CWD;
	let explicitCwd: string | undefined;
	let via: "workbench" | "app" = "workbench";
	let sshTarget: string | undefined = env.CODEX_TOYS_REMOTE_SSH_TARGET;
	let remotePathPrepend: string | undefined = env.CODEX_TOYS_REMOTE_PATH_PREPEND;
	let toyboxCommand: string | undefined = env.CODEX_TOYS_TOYBOX_COMMAND;
	let remoteCodexCommand: string | undefined;
	const remoteCodexArgs: string[] = [];
	let sandbox: RemoteTurnSandbox | undefined;
	let approvalPolicy: RemoteTurnApprovalPolicy | undefined;
	let permissions: string | undefined;
	const include: string[] = [];
	const exclude: string[] = [];
	const labels: string[] = [];
	const capabilities: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) {
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			return { type: "help" };
		}
		if (arg === "--timeout-ms") {
			timeoutMs = positiveInteger(required(argv, ++index, arg), arg);
			continue;
		}
		if (arg.startsWith("--timeout-ms=")) {
			timeoutMs = positiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
			continue;
		}
		if (arg === "--compact") {
			pretty = false;
			continue;
		}
		if (arg === "--pretty") {
			pretty = true;
			continue;
		}
		if (arg === "--no-color") {
			color = false;
			continue;
		}
		if (arg === "--color") {
			color = true;
			continue;
		}
			if (arg === "--json") {
				json = true;
				continue;
			}
			if (arg === "--params-json") {
				paramsJson = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--params-json=")) {
				paramsJson = arg.slice("--params-json=".length);
				continue;
			}
			if (arg === "--params-file") {
				paramsFile = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--params-file=")) {
				paramsFile = arg.slice("--params-file=".length);
				continue;
			}
			if (arg === "--mode") {
				const value = required(argv, ++index, arg);
				mode = parseMode(value);
				feedMode = parseFeedMode(value);
				continue;
			}
		if (arg.startsWith("--mode=")) {
			const value = arg.slice("--mode=".length);
			mode = parseMode(value);
			feedMode = parseFeedMode(value);
			continue;
		}
		if (arg === "--workbench-root") {
			workbenchRoot = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--workbench-root=")) {
			workbenchRoot = arg.slice("--workbench-root=".length);
			continue;
		}
		if (arg === "--feed-root") {
			feedRoot = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--feed-root=")) {
			feedRoot = arg.slice("--feed-root=".length);
			continue;
		}
		if (arg === "--cwd") {
			cwd = required(argv, ++index, arg);
			explicitCwd = cwd;
			continue;
		}
		if (arg.startsWith("--cwd=")) {
			cwd = arg.slice("--cwd=".length);
			explicitCwd = cwd;
			continue;
		}
		if (arg === "--target-cwd") {
			targetCwd = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--target-cwd=")) {
			targetCwd = arg.slice("--target-cwd=".length);
			continue;
		}
		if (arg === "--global-codex-home") {
			globalCodexHome = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--global-codex-home=")) {
			globalCodexHome = arg.slice("--global-codex-home=".length);
			continue;
		}
		if (arg === "--workbench-codex-home") {
			workbenchCodexHome = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--workbench-codex-home=")) {
			workbenchCodexHome = arg.slice("--workbench-codex-home=".length);
			continue;
		}
		if (arg === "--codex-home") {
			codexHome = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--codex-home=")) {
			codexHome = arg.slice("--codex-home=".length);
			continue;
		}
		if (arg === "--from-codex-home") {
			fromCodexHome = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--from-codex-home=")) {
			fromCodexHome = arg.slice("--from-codex-home=".length);
			continue;
		}
		if (arg === "--to-codex-home") {
			toCodexHome = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--to-codex-home=")) {
			toCodexHome = arg.slice("--to-codex-home=".length);
			continue;
		}
		if (arg === "--apply") {
			apply = true;
			continue;
		}
		if (arg === "--overwrite") {
			overwrite = true;
			continue;
		}
		if (arg === "--replace") {
			replace = true;
			continue;
		}
		if (arg === "--preserve-cwd") {
			preserveCwd = true;
			continue;
		}
		if (arg === "--ref") {
			ref = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--ref=")) {
			ref = arg.slice("--ref=".length);
			continue;
		}
		if (arg === "--include") {
			include.push(required(argv, ++index, arg));
			continue;
		}
		if (arg.startsWith("--include=")) {
			include.push(arg.slice("--include=".length));
			continue;
		}
		if (arg === "--exclude") {
			exclude.push(required(argv, ++index, arg));
			continue;
		}
		if (arg.startsWith("--exclude=")) {
			exclude.push(arg.slice("--exclude=".length));
			continue;
		}
		if (arg === "--merge") {
			const value = required(argv, ++index, arg);
			if (value !== "codex") {
				throw new Error("--merge currently supports only codex");
			}
			merge = "codex";
			continue;
		}
		if (arg.startsWith("--merge=")) {
			const value = arg.slice("--merge=".length);
			if (value !== "codex") {
				throw new Error("--merge currently supports only codex");
			}
			merge = "codex";
			continue;
		}
		if (arg === "--backup") {
			backup = true;
			continue;
		}
		if (arg === "--no-backup") {
			backup = false;
			continue;
		}
		if (arg === "--event") {
			eventPath = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--event=")) {
			eventPath = arg.slice("--event=".length);
			continue;
		}
		if (arg === "--script") {
			scriptPath = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--script=")) {
			scriptPath = arg.slice("--script=".length);
			continue;
		}
		if (arg === "--script-stdin") {
			scriptStdin = true;
			continue;
		}
		if (arg === "--forgejo") {
			forgejo = true;
			continue;
		}
		if (arg === "--github") {
			github = true;
			continue;
		}
		if (arg === "--image") {
			const value = argv[index + 1];
			if (value && !value.startsWith("--")) {
				runnerImage = value;
				index += 1;
			} else {
				runnerImage = undefined;
			}
			continue;
		}
		if (arg.startsWith("--image=")) {
			runnerImage = arg.slice("--image=".length);
			if (!runnerImage) {
				throw new Error("--image requires a non-empty value");
			}
			continue;
		}
		if (arg === "--no-image") {
			runnerImage = null;
			continue;
		}
			if (arg === "--prompt") {
				prompt = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--prompt=")) {
				prompt = arg.slice("--prompt=".length);
				continue;
			}
			if (arg === "--title") {
				title = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--title=")) {
				title = arg.slice("--title=".length);
				continue;
			}
			if (arg === "--group-id") {
				groupId = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--group-id=")) {
				groupId = arg.slice("--group-id=".length);
				continue;
			}
			if (arg === "--return-mode") {
				returnMode = parseDelegationReturnMode(required(argv, ++index, arg));
				continue;
			}
			if (arg.startsWith("--return-mode=")) {
				returnMode = parseDelegationReturnMode(arg.slice("--return-mode=".length));
				continue;
			}
			if (arg === "--thread-id") {
				threadId = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--thread-id=")) {
				threadId = arg.slice("--thread-id=".length);
				continue;
			}
			if (arg === "--wait") {
				wait = true;
				continue;
			}
			if (arg === "--dry-run") {
				dryRun = true;
				continue;
			}
			if (arg === "--include-output" || arg === "--with-output") {
				includeOutput = true;
				continue;
			}
			if (arg === "--older-than-days") {
				olderThanDays = positiveInteger(required(argv, ++index, arg), arg);
				continue;
			}
			if (arg.startsWith("--older-than-days=")) {
				olderThanDays = positiveInteger(arg.slice("--older-than-days=".length), "--older-than-days");
				continue;
			}
			if (arg === "--cursor") {
				cursor = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--cursor=")) {
				cursor = arg.slice("--cursor=".length);
				continue;
			}
			if (arg === "--run-at") {
				runAt = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--run-at=")) {
				runAt = arg.slice("--run-at=".length);
				continue;
			}
			if (arg === "--queue") {
				queue = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--queue=")) {
				queue = arg.slice("--queue=".length);
				continue;
			}
			if (arg === "--prompt-queue") {
				promptQueue = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--prompt-queue=")) {
				promptQueue = arg.slice("--prompt-queue=".length);
				continue;
			}
			if (arg === "--label") {
				labels.push(required(argv, ++index, arg));
				continue;
			}
			if (arg.startsWith("--label=")) {
				labels.push(arg.slice("--label=".length));
				continue;
			}
			if (arg === "--capability" || arg === "--required-capability") {
				capabilities.push(required(argv, ++index, arg));
				continue;
			}
			if (arg.startsWith("--capability=")) {
				capabilities.push(arg.slice("--capability=".length));
				continue;
			}
			if (arg.startsWith("--required-capability=")) {
				capabilities.push(arg.slice("--required-capability=".length));
				continue;
			}
			if (arg === "--target-host") {
				targetHost = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--target-host=")) {
				targetHost = arg.slice("--target-host=".length);
				continue;
			}
			if (arg === "--host-id") {
				hostId = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--host-id=")) {
				hostId = arg.slice("--host-id=".length);
				continue;
			}
			if (arg === "--requester-host") {
				requesterHost = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--requester-host=")) {
				requesterHost = arg.slice("--requester-host=".length);
				continue;
			}
			if (arg === "--requester-thread-id") {
				requesterThreadId = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--requester-thread-id=")) {
				requesterThreadId = arg.slice("--requester-thread-id=".length);
				continue;
			}
			if (arg === "--materialize") {
				materialize = true;
				continue;
			}
			if (arg === "--after") {
				afterIntentId = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--after=")) {
				afterIntentId = arg.slice("--after=".length);
				continue;
			}
			if (arg === "--after-status") {
				afterStatus = parseDeferredDependencyStatus(required(argv, ++index, arg));
				continue;
			}
			if (arg.startsWith("--after-status=")) {
				afterStatus = parseDeferredDependencyStatus(arg.slice("--after-status=".length));
				continue;
			}
			if (arg === "--status") {
				const value = required(argv, ++index, arg);
				status = parseDeferredRunStatusMaybe(value);
				feedStatus = parseFeedItemStatusMaybe(value);
				continue;
			}
			if (arg.startsWith("--status=")) {
				const value = arg.slice("--status=".length);
				status = parseDeferredRunStatusMaybe(value);
				feedStatus = parseFeedItemStatusMaybe(value);
				continue;
			}
			if (arg === "--source") {
				sourceId = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--source=")) {
				sourceId = arg.slice("--source=".length);
				continue;
			}
			if (arg === "--item") {
				itemId = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--item=")) {
				itemId = arg.slice("--item=".length);
				continue;
			}
			if (arg === "--target") {
				dispatchTarget = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--target=")) {
				dispatchTarget = arg.slice("--target=".length);
				continue;
			}
			if (arg === "--all") {
				all = true;
				continue;
			}
			if (arg === "--no-advance") {
				advance = false;
				continue;
			}
			if (arg === "--no-poll") {
				poll = false;
				continue;
			}
			if (arg === "--limit") {
				limit = positiveInteger(required(argv, ++index, arg), arg);
				continue;
			}
			if (arg.startsWith("--limit=")) {
				limit = positiveInteger(arg.slice("--limit=".length), "--limit");
				continue;
			}
			if (arg === "--allow-absolute-cwd") {
				allowAbsoluteCwd = true;
				continue;
			}
			if (arg === "--model") {
				model = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--model=")) {
				model = arg.slice("--model=".length);
				continue;
			}
			if (arg === "--service-tier") {
				serviceTier = required(argv, ++index, arg);
				continue;
			}
			if (arg.startsWith("--service-tier=")) {
				serviceTier = arg.slice("--service-tier=".length);
				continue;
			}
			if (arg === "--effort") {
				effort = parseReasoningEffort(required(argv, ++index, arg));
				continue;
			}
			if (arg.startsWith("--effort=")) {
				effort = parseReasoningEffort(arg.slice("--effort=".length));
				continue;
			}
			if (arg === "--via") {
				via = parseRemoteVia(required(argv, ++index, arg));
				continue;
			}
		if (arg.startsWith("--via=")) {
			via = parseRemoteVia(arg.slice("--via=".length));
			continue;
		}
		if (arg === "--sandbox") {
			sandbox = parseRemoteTurnSandbox(required(argv, ++index, arg));
			continue;
		}
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseRemoteTurnSandbox(arg.slice("--sandbox=".length));
			continue;
		}
		if (arg === "--approval-policy") {
			approvalPolicy = parseRemoteTurnApprovalPolicy(required(argv, ++index, arg));
			continue;
		}
		if (arg.startsWith("--approval-policy=")) {
			approvalPolicy = parseRemoteTurnApprovalPolicy(
				arg.slice("--approval-policy=".length),
			);
			continue;
		}
		if (arg === "--permissions") {
			permissions = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--permissions=")) {
			permissions = arg.slice("--permissions=".length);
			continue;
		}
		if (arg === "--ssh" || arg === "--ssh-target") {
			sshTarget = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--ssh=")) {
			sshTarget = arg.slice("--ssh=".length);
			continue;
		}
		if (arg.startsWith("--ssh-target=")) {
			sshTarget = arg.slice("--ssh-target=".length);
			continue;
		}
		if (arg === "--remote-path-prepend") {
			remotePathPrepend = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--remote-path-prepend=")) {
			remotePathPrepend = arg.slice("--remote-path-prepend=".length);
			continue;
		}
		if (arg === "--toybox-command") {
			toyboxCommand = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--toybox-command=")) {
			toyboxCommand = arg.slice("--toybox-command=".length);
			continue;
		}
		if (arg === "--codex-command" || arg === "--remote-codex-command") {
			remoteCodexCommand = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--codex-command=")) {
			remoteCodexCommand = arg.slice("--codex-command=".length);
			continue;
		}
		if (arg.startsWith("--remote-codex-command=")) {
			remoteCodexCommand = arg.slice("--remote-codex-command=".length);
			continue;
		}
		if (arg === "--codex-arg" || arg === "--remote-codex-arg") {
			remoteCodexArgs.push(required(argv, ++index, arg));
			continue;
		}
		if (arg.startsWith("--codex-arg=")) {
			remoteCodexArgs.push(arg.slice("--codex-arg=".length));
			continue;
		}
		if (arg.startsWith("--remote-codex-arg=")) {
			remoteCodexArgs.push(arg.slice("--remote-codex-arg=".length));
			continue;
		}
		if (arg === "--") {
			positionals.push(...argv.slice(index + 1));
			break;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		}
		positionals.push(arg);
	}

	const remoteFields = (): ParsedRemoteOptions => {
		const fields: ParsedRemoteOptions = {};
		if (sshTarget) {
			fields.sshTarget = sshTarget;
			if (cwd) {
				fields.cwd = cwd;
			}
		}
		if (remotePathPrepend !== undefined) {
			fields.remotePathPrepend = remotePathPrepend;
		}
		if (toyboxCommand !== undefined) {
			fields.toyboxCommand = toyboxCommand;
		}
		if (remoteCodexCommand !== undefined) {
			fields.remoteCodexCommand = remoteCodexCommand;
		}
		if (remoteCodexArgs.length > 0) {
			fields.remoteCodexArgs = remoteCodexArgs;
		}
		return fields;
	};

	const command = positionals[0];
	if (!command || command === "help") {
		return { type: "help" };
	}
	if (command === "mcp") {
		const subcommand = positionals[1] ?? "serve";
		if (subcommand !== "serve") {
			throw new Error("mcp currently supports only serve");
		}
		return {
			type: "mcp-serve",
			timeoutMs,
		};
	}
	if (command === "fetch" || command === "neofetch") {
		return {
			type: "fetch",
			appUrl,
			workbenchUrl,
			timeoutMs: timeoutMs === defaultTimeoutMs && !sshTarget ? 1_500 : timeoutMs,
			color,
			json,
			...remoteFields(),
		};
	}
	if (command === "toybox") {
		const subcommand = requiredPositional(positionals, 1, "toybox requires serve");
		if (subcommand !== "serve") {
			throw new Error("toybox currently supports only serve");
		}
		return {
			type: "toybox-serve",
			cwd,
			timeoutMs,
			...remoteFields(),
		};
	}
	if (command === "remote") {
			const subcommand = positionals[1];
			if (subcommand === "preflight") {
				return {
					type: "remote-preflight",
					cwd,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			if (subcommand === "host-overview" || subcommand === "host") {
				return {
					type: "host-overview",
					url: workbenchUrl,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			throw new Error("remote supports only preflight or host-overview; use --ssh with fetch, app, workbench, workflow, functions, or turn run");
		}
	if (command === "host") {
		const subcommand = positionals[1];
		if (subcommand !== "overview") {
			throw new Error("host requires overview");
		}
		return {
			type: "host-overview",
			url: workbenchUrl,
			timeoutMs,
			json,
			pretty,
			...remoteFields(),
		};
	}
	if (command === "turn") {
			const subcommand = positionals[1];
			if (subcommand !== "run") {
				throw new Error("turn requires run");
			}
			if (sshTarget && !wait) {
				throw new Error(
					"SSH turn run requires --wait. Fire-and-forget turns over SSH are not durable because the remote toybox is closed when the command exits; use --wait or workbench delegate start for supervised background work.",
				);
			}
			return {
				type: "turn-run",
				prompt: prompt ?? requiredPositional(
					positionals,
					2,
					"turn run requires <prompt> or --prompt <text>",
				),
				threadId,
				cwd,
				appUrl,
				workbenchUrl,
				timeoutMs: wait ? turnWaitTimeoutMs(timeoutMs) : timeoutMs,
				wait,
				sandbox,
				approvalPolicy,
				permissions,
				model,
				json,
				pretty,
				...remoteFields(),
			};
		}
	if (command === "workflow") {
		const subcommand = positionals[1];
		if (subcommand === "list" || subcommand === "ls") {
			return {
				type: "workflow-list",
				workbenchRoot,
				timeoutMs,
				json,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand !== "run") {
			throw new Error("workflow requires run or list");
		}
		const workflowTarget = positionals[2];
		const sources = [
			workflowTarget ? "target" : undefined,
			scriptPath ? "script" : undefined,
			scriptStdin ? "script-stdin" : undefined,
		].filter(Boolean);
		if (sources.length !== 1) {
			throw new Error("workflow run requires exactly one of <name>, --script <path>, or --script-stdin");
		}
		return {
			type: "workflow-run",
			target: workflowTarget,
			scriptPath,
			scriptStdin,
			eventPath,
			prompt,
			workbenchRoot,
			cwd,
			via,
			appUrl,
			workbenchUrl,
			timeoutMs: workflowRunTimeoutMs(timeoutMs),
			sandbox,
			approvalPolicy,
			permissions,
			model,
			json,
			pretty,
			...remoteFields(),
		};
	}
	if (command === "app") {
		const subcommand = positionals[1];
		if (!subcommand || subcommand === "actions") {
			return { type: "app-actions" };
		}
		const method = subcommand === "call"
			? requiredPositional(positionals, 2, "app call requires <method>")
			: subcommand;
		const params = subcommand === "call" ? positionals.slice(3) : positionals.slice(2);
		return {
			type: "app-call",
			method: validateMethodName(method, "app method"),
			...paramsSource(params, paramsJson, paramsFile),
			url: appUrl,
			timeoutMs,
			pretty,
			...remoteFields(),
		};
	}
	if (command === "functions" || command === "function") {
		const subcommand = positionals[1];
		if (subcommand === "list" || subcommand === "ls") {
			return {
				type: "functions-list",
				url: workbenchUrl,
				timeoutMs,
				json,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "describe" || subcommand === "show") {
			return {
				type: "functions-describe",
				name: requiredPositional(positionals, 2, "functions describe requires <name>"),
				url: workbenchUrl,
				timeoutMs,
				json,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "call" || subcommand === "run") {
			return {
				type: "functions-call",
				name: requiredPositional(positionals, 2, "functions call requires <name>"),
				...paramsSource(positionals.slice(3), paramsJson, paramsFile),
				url: workbenchUrl,
				timeoutMs,
				json,
				pretty,
				...remoteFields(),
			};
		}
		throw new Error("functions requires list, describe, or call");
	}
	if (command === "feed") {
		const subcommand = positionals[1] ?? "doctor";
		if (subcommand === "doctor") {
			return {
				type: "feed-doctor",
				mode: feedMode,
				feedRoot,
				url: workbenchUrl,
				timeoutMs: timeoutMs === defaultTimeoutMs ? 1_500 : timeoutMs,
				json,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "source" || subcommand === "sources") {
			const action = positionals[2] ?? "list";
			if (action !== "list" && action !== "ls") {
				throw new Error("feed source requires list");
			}
			return {
				type: "feed-source-list",
				mode: feedMode,
				feedRoot,
				url: workbenchUrl,
				timeoutMs,
				json,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "poll") {
			return {
				type: "feed-poll",
				mode: feedMode,
				feedRoot,
				sourceId: sourceId ?? (all ? undefined : positionals[2]),
				url: workbenchUrl,
				timeoutMs,
				json,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "item" || subcommand === "items") {
			const action = positionals[2] ?? "list";
			if (action === "list" || action === "ls") {
				return {
					type: "feed-item-list",
					mode: feedMode,
					feedRoot,
					sourceId,
					status: feedStatus,
					limit,
					url: workbenchUrl,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "read" || action === "show") {
				return {
					type: "feed-item-read",
					itemId: requiredPositional(positionals, 3, `feed item ${action} requires <item-id>`),
					mode: feedMode,
					feedRoot,
					url: workbenchUrl,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			throw new Error("feed item requires list or read");
		}
		if (subcommand === "collect") {
			return {
				type: "feed-collect",
				mode: feedMode,
				feedRoot,
				cursor,
				sourceId,
				status: feedStatus,
				limit,
				advance,
				url: workbenchUrl,
				timeoutMs,
				json,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "cursor") {
			const action = positionals[2];
			if (action === "advance") {
				return {
					type: "feed-cursor-advance",
					mode: feedMode,
					feedRoot,
					cursor,
					itemId: itemId ?? requiredPositional(positionals, 3, "feed cursor advance requires --item <item-id>"),
					url: workbenchUrl,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			throw new Error("feed cursor requires advance");
		}
		if (subcommand === "dispatch") {
			return {
				type: "feed-dispatch",
				mode: feedMode,
				feedRoot,
				cursor,
				sourceId: sourceId ?? requiredPositional(positionals, 2, "feed dispatch requires --source <source-id>"),
				target: dispatchTarget ?? requiredPositional(positionals, 3, "feed dispatch requires --target <target>"),
				limit,
				poll,
				url: workbenchUrl,
				timeoutMs,
				json,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "prune") {
			if (olderThanDays === undefined) {
				throw new Error("feed prune requires --older-than-days");
			}
			return {
				type: "feed-prune",
				mode: feedMode,
				feedRoot,
				olderThanDays,
				dryRun,
				url: workbenchUrl,
				timeoutMs,
				pretty,
				...remoteFields(),
			};
		}
		throw new Error("feed requires doctor, source list, poll, item list, item read, collect, cursor advance, dispatch, or prune");
	}
	if (command === "workbench") {
		const subcommand = positionals[1];
		if (!subcommand || subcommand === "methods") {
			return {
				type: "workbench-methods",
				url: workbenchUrl,
				timeoutMs,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "doctor") {
			return {
				type: "workbench-doctor",
				mode,
				workbenchRoot,
				appUrl,
				workbenchUrl,
				timeoutMs: timeoutMs === defaultTimeoutMs ? 1_500 : timeoutMs,
				color,
				json,
				...remoteFields(),
			};
		}
		if (subcommand === "overview") {
			return {
				type: "workbench-overview",
				mode,
				workbenchRoot,
				url: workbenchUrl,
				timeoutMs: timeoutMs === defaultTimeoutMs ? 5_000 : timeoutMs,
				json,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "delegate" || subcommand === "delegation") {
			const action = positionals[2] ?? "list";
			if (action === "list" || action === "ls") {
				return {
					type: "workbench-delegate-list",
					url: workbenchUrl,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "start") {
				const resolvedTargetCwd = targetCwd ?? (!sshTarget ? cwd : undefined) ??
					requiredPositional(
						positionals,
						3,
						"workbench delegate start requires --cwd <target> or --target-cwd <target>",
					);
				const promptPosition = (targetCwd ?? (!sshTarget ? cwd : undefined)) ? 3 : 4;
				const positionalPrompt = positionals.slice(promptPosition).join(" ");
				return {
					...remoteFields(),
					type: "workbench-delegate-start",
					targetCwd: resolvedTargetCwd,
					prompt: prompt ?? (positionalPrompt || undefined),
					title,
					groupId,
					returnMode,
					wait,
					allowAbsoluteCwd,
					url: workbenchUrl,
					timeoutMs: wait ? turnWaitTimeoutMs(timeoutMs) : timeoutMs,
					sandbox,
					approvalPolicy,
					permissions,
					model,
					json,
					pretty,
				};
			}
			throw new Error("workbench delegate requires list or start");
		}
		if (subcommand === "tick") {
			return {
				type: "workbench-tick",
				mode,
				workbenchRoot,
				url: workbenchUrl,
				timeoutMs,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "prompt" || subcommand === "prompts" || subcommand === "prompt-queue") {
			const action = positionals[2] ?? "list";
			if (action === "enqueue" || action === "queue" || action === "add" || action === "create") {
				const positionalPrompt = positionals.slice(3).join(" ");
				return {
					type: "workbench-prompt-enqueue",
					prompt: prompt ?? (positionalPrompt || requiredPositional(
						positionals,
						3,
						"workbench prompt enqueue requires <prompt> or --prompt <text>",
					)),
					title,
					queue,
					labels,
					runAt,
					afterIntentId,
					afterStatus,
					threadId,
					cwd: targetCwd ?? (!sshTarget ? cwd : undefined),
					model,
					serviceTier,
					effort,
					sandbox,
					approvalPolicy,
					permissions,
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "list" || action === "ls") {
				return {
					type: "workbench-prompt-list",
					status,
					queue,
					limit,
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "read" || action === "show" || action === "pull") {
				return {
					type: "workbench-prompt-read",
					intentId: requiredPositional(positionals, 3, `workbench prompt ${action} requires <intent-id>`),
					includeOutput: includeOutput || action === "pull",
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "collect") {
				return {
					type: "workbench-prompt-collect",
					cursor,
					queue,
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "cancel") {
				return {
					type: "workbench-prompt-cancel",
					intentId: requiredPositional(positionals, 3, "workbench prompt cancel requires <intent-id>"),
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "retry" || action === "requeue") {
				return {
					type: "workbench-prompt-retry",
					intentId: requiredPositional(positionals, 3, `workbench prompt ${action} requires <intent-id>`),
					runAt,
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "run-due" || action === "run") {
				return {
					type: "workbench-prompt-run-due",
					queue,
					limit,
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					pretty,
					...remoteFields(),
				};
			}
			throw new Error("workbench prompt requires enqueue, list, read, collect, cancel, retry, or run-due");
		}
		if (subcommand === "handoff" || subcommand === "handoffs" || subcommand === "local-handoff") {
			const action = positionals[2] ?? "list";
			if (action === "enqueue" || action === "queue" || action === "add" || action === "create") {
				const positionalPrompt = positionals.slice(3).join(" ");
				return {
					type: "workbench-handoff-enqueue",
					prompt: prompt ?? (positionalPrompt || requiredPositional(
						positionals,
						3,
						"workbench handoff enqueue requires <prompt> or --prompt <text>",
					)),
					title,
					queue,
					labels,
					runAt,
					afterIntentId,
					afterStatus,
					targetHost,
					requiredCapabilities: capabilities,
					requesterHost,
					requesterThreadId,
					threadId,
					cwd: targetCwd ?? (!sshTarget ? cwd : undefined),
					model,
					serviceTier,
					effort,
					sandbox,
					approvalPolicy,
					permissions,
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "list" || action === "ls") {
				return {
					type: "workbench-handoff-list",
					status,
					queue,
					targetHost,
					capabilities,
					limit,
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "read" || action === "show" || action === "pull") {
				return {
					type: "workbench-handoff-read",
					intentId: requiredPositional(positionals, 3, `workbench handoff ${action} requires <intent-id>`),
					includeOutput: includeOutput || action === "pull",
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "collect") {
				return {
					type: "workbench-handoff-collect",
					cursor,
					queue,
					targetHost,
					capabilities,
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "cancel") {
				return {
					type: "workbench-handoff-cancel",
					intentId: requiredPositional(positionals, 3, "workbench handoff cancel requires <intent-id>"),
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "retry" || action === "requeue") {
				return {
					type: "workbench-handoff-retry",
					intentId: requiredPositional(positionals, 3, `workbench handoff ${action} requires <intent-id>`),
					runAt,
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "drain" || action === "run-due" || action === "run") {
				return {
					type: "workbench-handoff-drain",
					queue,
					hostId,
					capabilities,
					limit,
					materialize,
					promptQueue,
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					pretty,
					...remoteFields(),
				};
			}
			throw new Error("workbench handoff requires enqueue, list, read, collect, cancel, retry, or drain");
		}
		if (subcommand === "deferred" || subcommand === "defer") {
			const action = positionals[2] ?? "list";
			if (action === "create" || action === "add") {
				return {
					type: "workbench-deferred-create",
					mode,
					workbenchRoot,
					...paramsSource(positionals.slice(3), paramsJson, paramsFile),
					url: workbenchUrl,
					timeoutMs,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "list" || action === "ls") {
				return {
					type: "workbench-deferred-list",
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "read" || action === "show" || action === "pull") {
				return {
					type: "workbench-deferred-read",
					intentId: requiredPositional(positionals, 3, `workbench deferred ${action} requires <intent-id>`),
					includeOutput: includeOutput || action === "pull",
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "collect") {
				return {
					type: "workbench-deferred-collect",
					cursor,
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					json,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "cancel") {
				return {
					type: "workbench-deferred-cancel",
					intentId: requiredPositional(positionals, 3, "workbench deferred cancel requires <intent-id>"),
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "retry" || action === "requeue") {
				return {
					type: "workbench-deferred-retry",
					intentId: requiredPositional(positionals, 3, `workbench deferred ${action} requires <intent-id>`),
					runAt,
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "run-due" || action === "run") {
				return {
					type: "workbench-deferred-run-due",
					mode,
					workbenchRoot,
					url: workbenchUrl,
					timeoutMs,
					pretty,
					...remoteFields(),
				};
			}
			if (action === "prune") {
				if (olderThanDays === undefined) {
					throw new Error("workbench deferred prune requires --older-than-days");
				}
				return {
					type: "workbench-deferred-prune",
					mode,
					workbenchRoot,
					olderThanDays,
					dryRun,
					url: workbenchUrl,
					timeoutMs,
					pretty,
					...remoteFields(),
				};
			}
			throw new Error("workbench deferred requires create, list, read, collect, cancel, retry, run-due, or prune");
		}
		if (subcommand === "run") {
			return {
				type: "workbench-run",
				taskId: requiredPositional(positionals, 2, "workbench run requires <task-id>"),
				mode,
				workbenchRoot,
				url: workbenchUrl,
				timeoutMs,
				pretty,
				...remoteFields(),
			};
		}
		if (subcommand === "init") {
			const target = requiredPositional(positionals, 2, "workbench init requires actions");
			if (target !== "actions") {
				throw new Error("workbench init currently supports only actions");
			}
			return {
				type: "workbench-init-actions",
				workbenchRoot,
				forgejo,
				github,
				runnerImage,
				overwrite,
				pretty,
			};
		}
		if (subcommand === "backend") {
			throw new Error("toybox service commands have been removed; use codex-toys toybox serve or codex-toys-proxy serve");
		}
		if (subcommand === "app") {
			const method = requiredPositional(
				positionals,
				2,
				"workbench app requires <method>",
			);
			return {
				type: "workbench-app-call",
				method: validateMethodName(method, "app method"),
				...paramsSource(positionals.slice(3), paramsJson, paramsFile),
				url: workbenchUrl,
				timeoutMs,
				pretty,
				...remoteFields(),
			};
		}
		const method = subcommand === "call"
			? requiredPositional(positionals, 2, "workbench call requires <method>")
			: subcommand;
		const params = subcommand === "call" ? positionals.slice(3) : positionals.slice(2);
		return {
			type: "workbench-call",
			method: validateMethodName(method, "workbench method"),
			...paramsSource(params, paramsJson, paramsFile),
			url: workbenchUrl,
			timeoutMs,
			pretty,
			...remoteFields(),
		};
	}
	if (command === "actions") {
		const subcommand = positionals[1];
		if (subcommand === "prepare-auth") {
			return { type: "actions-prepare-auth", workbenchRoot, pretty };
		}
		if (subcommand === "cleanup") {
			return { type: "actions-cleanup", workbenchRoot, pretty };
		}
		throw new Error("actions requires prepare-auth or cleanup");
	}
	if (command === "memories") {
		const subcommand = positionals[1];
		if (subcommand !== "transplant") {
			throw new Error("memories requires transplant");
		}
		const direction = requiredPositional(positionals, 2, "memories transplant requires a direction");
		if (direction !== "global-to-workbench" && direction !== "workbench-to-global") {
			throw new Error(`Invalid memories transplant direction: ${direction}`);
		}
		return {
			type: "memories-transplant",
			direction,
			workbenchRoot,
			globalCodexHome,
			workbenchCodexHome,
			apply,
			overwrite,
			merge,
			backup,
			json,
		};
	}
	if (command === "threads") {
		const subcommand = positionals[1];
		if (subcommand === "locate") {
			return {
				type: "threads-locate",
				threadId: requiredPositional(positionals, 2, "threads locate requires <thread-id>"),
				codexHome,
				json,
			};
		}
		if (subcommand === "inspect") {
			return {
				type: "threads-inspect",
				threadIdOrPath: requiredPositional(
					positionals,
					2,
					"threads inspect requires <thread-id-or-rollout-path>",
				),
				codexHome,
				json,
			};
		}
		if (subcommand === "install-rollout") {
			return {
				type: "threads-install-rollout",
				rolloutPath: requiredPositional(
					positionals,
					2,
					"threads install-rollout requires <rollout.jsonl>",
				),
				codexHome,
				replace,
				...(explicitCwd !== undefined ? { cwd: explicitCwd } : {}),
				preserveCwd,
				json,
			};
		}
		if (subcommand === "transplant") {
			return {
				type: "threads-transplant",
				threadId: requiredPositional(positionals, 2, "threads transplant requires <thread-id>"),
				fromCodexHome,
				toCodexHome: toCodexHome ?? requiredPositional(
					positionals,
					3,
					"threads transplant requires --to-codex-home <home>",
				),
				replace,
				...(explicitCwd !== undefined ? { cwd: explicitCwd } : {}),
				preserveCwd,
				json,
			};
		}
		throw new Error("threads requires locate, inspect, install-rollout, or transplant");
	}
	if (command === "kit") {
		const subcommand = positionals[1];
		if (subcommand === "inspect") {
			return {
				type: "kit-inspect",
				source: requiredPositional(positionals, 2, "kit inspect requires <source>"),
				ref,
				json,
			};
		}
		if (subcommand === "add") {
			return {
				type: "kit-add",
				source: requiredPositional(positionals, 2, "kit add requires <source>"),
				ref,
				workbenchRoot,
				apply,
				overwrite,
				include,
				exclude,
				json,
			};
		}
		if (subcommand === "setup") {
			if (sshTarget) {
				throw new Error("kit setup currently supports local workbenches only; run kit add on the target host and open Codex there for plain setup.");
			}
			if (include.length > 0 || exclude.length > 0) {
				throw new Error("kit setup installs the whole kit and does not support --include or --exclude.");
			}
			return {
				type: "kit-setup",
				source: requiredPositional(positionals, 2, "kit setup requires <source>"),
				ref,
				workbenchRoot,
				overwrite,
				prompt,
				appUrl,
				workbenchUrl,
				timeoutMs: wait ? turnWaitTimeoutMs(timeoutMs) : timeoutMs,
				wait,
				sandbox,
				approvalPolicy,
				permissions,
				model,
				json,
				pretty,
			};
		}
		if (subcommand === "doctor") {
			return {
				type: "kit-doctor",
				workbenchRoot,
				json,
			};
		}
		if (subcommand === "list") {
			return {
				type: "kit-list",
				workbenchRoot,
				json,
			};
		}
		throw new Error("kit requires inspect, add, setup, doctor, or list");
	}
	throw new Error(`Unknown command: ${command}`);
}

function paramsText(values: string[]): string | undefined {
	return values.length > 0 ? values.join(" ") : undefined;
}

function paramsSource(
	values: string[],
	paramsJson: string | undefined,
	paramsFile: string | undefined,
): { paramsText?: string; paramsFile?: string } {
	const positional = paramsText(values);
	if (paramsJson !== undefined && paramsFile !== undefined) {
		throw new Error("--params-json cannot be combined with --params-file");
	}
	if (positional !== undefined && (paramsJson !== undefined || paramsFile !== undefined)) {
		throw new Error("inline JSON params cannot be combined with --params-json or --params-file");
	}
	if (paramsJson !== undefined) {
		return { paramsText: paramsJson };
	}
	if (paramsFile !== undefined) {
		return { paramsFile };
	}
	return positional === undefined ? {} : { paramsText: positional };
}

function parseRemoteVia(value: string): "workbench" | "app" {
	if (value === "workbench" || value === "app") {
		return value;
	}
	throw new Error("--via must be workbench or app");
}

function parseRemoteTurnSandbox(value: string): RemoteTurnSandbox {
	if (
		value === "danger-full-access" ||
		value === "read-only" ||
		value === "workspace-write"
	) {
		return value;
	}
	throw new Error("--sandbox must be danger-full-access, workspace-write, or read-only");
}

function parseRemoteTurnApprovalPolicy(value: string): RemoteTurnApprovalPolicy {
	if (
		value === "never" ||
		value === "on-failure" ||
		value === "on-request" ||
		value === "untrusted"
	) {
		return value;
	}
	throw new Error("--approval-policy must be never, on-failure, on-request, or untrusted");
}

function parseReasoningEffort(value: string): DeferredReasoningEffort {
	if (
		value === "none" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	) {
		return value;
	}
	throw new Error("--effort must be none, minimal, low, medium, high, or xhigh");
}

function parseDeferredDependencyStatus(value: string): "completed" | "failed" | "canceled" | "terminal" {
	if (
		value === "completed" ||
		value === "failed" ||
		value === "canceled" ||
		value === "terminal"
	) {
		return value;
	}
	throw new Error("--after-status must be completed, failed, canceled, or terminal");
}

function parseDeferredRunStatus(value: string): DeferredRunIntentStatus {
	if (
		value === "pending" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "canceled"
	) {
		return value;
	}
	throw new Error("--status must be pending, running, completed, failed, or canceled");
}

function parseDeferredRunStatusMaybe(value: string): DeferredRunIntentStatus | undefined {
	if (
		value === "pending" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "canceled"
	) {
		return value;
	}
	if (value === "new") {
		return undefined;
	}
	throw new Error("--status must be pending, running, completed, failed, canceled, or new");
}

function parseFeedItemStatusMaybe(value: string): FeedItemStatus | undefined {
	if (value === "new") {
		return value;
	}
	if (
		value === "pending" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "canceled"
	) {
		return undefined;
	}
	throw new Error("--status must be pending, running, completed, failed, canceled, or new");
}

function parseDelegationReturnMode(value: string): DelegationReturnMode {
	if (
		value === "detached" ||
		value === "record_only" ||
		value === "wake_on_done" ||
		value === "wake_on_group" ||
		value === "manual"
	) {
		return value;
	}
	throw new Error("--return-mode must be detached, record_only, wake_on_done, wake_on_group, or manual");
}

function turnWaitTimeoutMs(timeoutMs: number): number {
	return timeoutMs === defaultTimeoutMs ? defaultLongRunningTurnTimeoutMs : timeoutMs;
}

function workflowRunTimeoutMs(timeoutMs: number): number {
	return timeoutMs === defaultTimeoutMs ? defaultLongRunningTurnTimeoutMs : timeoutMs;
}

function required(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function requiredPositional(args: string[], index: number, message: string): string {
	const value = args[index];
	if (!value) {
		throw new Error(message);
	}
	return value;
}

function positiveInteger(value: string, flag: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${flag} must be a positive integer`);
	}
	return parsed;
}
