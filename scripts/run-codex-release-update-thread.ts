#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAppServerClient } from "../packages/codex-client/src/index.ts";

type Args = {
	cargoTargetDir: string;
	codexCommand?: string;
	codexHome?: string;
	codexRepo: string;
	ephemeral: boolean;
	force: boolean;
	handledNpmPackage?: string;
	npmRegistry: string;
	releaseTag?: string;
	serviceRepo: string;
	stream: boolean;
	targetBranch: string;
	threadName?: string;
	timeoutMs: number;
	upstreamRemote: string;
	upstreamRepo: string;
};

type ReleaseInfo = {
	tagName: string;
	name?: string;
	publishedAt?: string;
	url?: string;
	body?: string;
	targetCommitish?: string;
};

type HandledNpmRelease = {
	packageName: string;
	registry: string;
	version: string;
};

type CodeModeUpdateResult = {
	status: "blocked" | "completed" | "conflict" | "failed";
	message?: string;
	releaseTag?: string;
	releaseUrl?: string;
	beforeSha?: string;
	afterSha?: string;
	codexHead?: string;
	commands?: unknown[];
};

const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(serviceRoot, "..");
const defaultCodexRepo = path.join(workspaceRoot, "codex");
const defaultCargoTargetDir = "/tmp/codex-fork-workspace-target";
const defaultHandledNpmPackage =
	process.env.CODEX_UPDATE_HANDLED_NPM_PACKAGE ?? "@peezy.tech/codex";
const defaultNpmRegistry =
	process.env.CODEX_UPDATE_NPM_REGISTRY ?? "https://registry.npmjs.org/";

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const release = await latestRelease(args);
	const handledRelease = await latestHandledNpmRelease(args, release);

	if (!args.force && handledRelease) {
		writeJson({
			status: "skipped",
			message: `Release ${release.tagName} is already covered by ${handledRelease.packageName}@${handledRelease.version}.`,
			release,
			handledRelease,
		});
		return;
	}

	await ensureCodexCommandExists(args.codexCommand);
	const result = await runUpdateThread(args, release, handledRelease);

	writeJson(result);
	process.stdout.write(`threadId=${result.threadId}\n`);

	if (result.updateResult?.status === "completed") {
		return;
	}
	if (result.updateResult?.status === "conflict") {
		process.exitCode = 2;
		return;
	}
	process.exitCode = 1;
}

async function latestRelease(args: Args): Promise<ReleaseInfo> {
	const fields = "tagName,name,publishedAt,url,body,targetCommitish";
	try {
		const command = args.releaseTag
			? ["gh", "release", "view", args.releaseTag, "--repo", args.upstreamRepo, "--json", fields]
			: ["gh", "release", "view", "--repo", args.upstreamRepo, "--json", fields];
		const release = await runJson(command);
		return requireReleaseInfo(release);
	} catch (error) {
		throw new Error(`Failed to read ${args.upstreamRepo} release: ${errorMessage(error)}`);
	}
}

async function latestHandledNpmRelease(
	args: Args,
	release: ReleaseInfo,
): Promise<HandledNpmRelease | undefined> {
	if (!args.handledNpmPackage) {
		return undefined;
	}
	const version = releaseVersion(release.tagName);
	if (!version) {
		throw new Error(`Could not normalize release tag to an npm version: ${release.tagName}`);
	}
	const spec = `${args.handledNpmPackage}@${version}`;
	const result = await runCommand(["npm", "view", spec, "version", "--registry", args.npmRegistry, "--json"], {
		allowFailure: true,
	});
	if (result.exitCode !== 0) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(result.stdout) as unknown;
		if (parsed !== version) {
			throw new Error(`expected ${version}, got ${String(parsed)}`);
		}
		return {
			packageName: args.handledNpmPackage,
			registry: args.npmRegistry,
			version,
		};
	} catch (error) {
		throw new Error(
			`Failed to parse npm package version for ${spec}: ${errorMessage(error)}`,
		);
	}
}

async function runUpdateThread(
	args: Args,
	release: ReleaseInfo,
	handledRelease: HandledNpmRelease | undefined,
) {
	const threadName =
		args.threadName ??
		`Codex upstream update: ${release.tagName} -> ${args.targetBranch}`;
	const source = await updateCodeModeSource(args, release);
	const client = new CodexAppServerClient({
		transportOptions: {
			codexCommand: args.codexCommand,
			args: appServerArgs(),
			cwd: args.codexRepo,
			env: args.codexHome
				? { CODEX_HOME: path.resolve(args.codexHome) }
				: undefined,
			requestTimeoutMs: args.timeoutMs,
		},
		clientName: "codex-update-thread",
		clientTitle: "Codex Update Thread",
		clientVersion: "0.1.0",
	});

	const output: string[] = [];
	let threadId = "";
	let completedItem: unknown;
	let resolveTurnCompleted: (value: unknown) => void = () => undefined;
	const turnCompleted = new Promise((resolve) => {
		resolveTurnCompleted = resolve;
	});

	client.on("request", (message) => {
		client.respondError(
			message.id,
			-32603,
			"codex update launcher does not handle server requests",
		);
	});
	client.on("notification", (message) => {
		if (message.method === "item/commandExecution/outputDelta") {
			const delta = stringField(message.params, "delta");
			if (delta) {
				output.push(delta);
				if (args.stream) {
					process.stdout.write(delta);
				}
			}
		}
		if (message.method === "item/agentMessage/delta") {
			const delta = stringField(message.params, "delta");
			if (delta) {
				output.push(delta);
				if (args.stream) {
					process.stdout.write(delta);
				}
			}
		}
		if (message.method === "item/completed") {
			completedItem = recordField(message.params, "item") ?? completedItem;
		}
		if (
			message.method === "turn/completed" &&
			(!threadId || stringField(message.params, "threadId") === threadId)
		) {
			resolveTurnCompleted(message.params);
		}
	});

	try {
		await client.connect();
		const started = await client.startThread({
			cwd: args.codexRepo,
			approvalPolicy: "never",
			sandbox: "danger-full-access",
			ephemeral: args.ephemeral,
			experimentalRawEvents: false,
			persistExtendedHistory: true,
		});
		threadId = started.thread.id;
		await client.request("thread/name/set", {
			threadId,
			name: threadName,
		});
		await injectAssistantText(
			client,
			threadId,
			updateContextText(args, release, handledRelease, source),
		);
		await client.request("thread/codeMode/execute", {
			threadId,
			source,
		});
		const completed = await withTimeout(
			turnCompleted,
			args.timeoutMs,
			"timed out waiting for Codex update Code Mode completion",
		);
		const read = await client.request("thread/read", {
			threadId,
			includeTurns: true,
		});
		const agentText = allAgentMessageText(read).join("\n");
		const replayOutput = agentText || output.join("");
		const updateResult = parseUpdateResult(replayOutput);
		return {
			status: updateResult?.status ?? "unknown",
			threadId,
			threadName,
			release,
			handledRelease,
			codexRepo: args.codexRepo,
			serviceRepo: args.serviceRepo,
			updateResult,
			output: replayOutput,
			completed,
			completedItem,
		};
	} finally {
		client.close();
	}
}

async function updateCodeModeSource(args: Args, release: ReleaseInfo): Promise<string> {
	const config = {
		cargoTargetDir: args.cargoTargetDir,
		codexBinary: path.join(args.cargoTargetDir, "debug", "codex"),
		codexRepo: args.codexRepo,
		codexRustDir: path.join(args.codexRepo, "codex-rs"),
		generatedDir: path.join(
			args.serviceRepo,
			"packages",
			"codex-client",
			"src",
			"app-server",
			"generated",
		),
		release,
		serviceRepo: args.serviceRepo,
		targetBranch: args.targetBranch,
		upstreamRemote: args.upstreamRemote,
		upstreamRepoUrl: `https://github.com/${args.upstreamRepo}.git`,
	};
	const configSource = `const config = ${JSON.stringify(config, null, 2)};\n`;
	const bodySource = await readFile(
		path.join(serviceRoot, "scripts", "codex-release-update.code-mode.js"),
		"utf8",
	);
	return configSource + bodySource;
}

function updateContextText(
	args: Args,
	release: ReleaseInfo,
	handledRelease: HandledNpmRelease | undefined,
	source: string,
) {
	return [
		"Codex upstream update job context",
		"",
		"Purpose: update the local codex fork branch from the latest openai/codex GitHub release through native Code Mode.",
		"",
		"Release:",
		formatJson(release),
		"",
		"Paths:",
		"- codex repo: " + args.codexRepo,
		"- codex-flows repo: " + args.serviceRepo,
		"- cargo target dir: " + args.cargoTargetDir,
		"- app-server command for this thread: " +
			(args.codexCommand ?? "vp dlx @peezy.tech/codex"),
		args.handledNpmPackage
			? "- handled npm package: " + args.handledNpmPackage
			: "- handled npm package: disabled",
		"- npm registry: " + args.npmRegistry,
		"",
		"Policy:",
		"- Do not run a global Codex install.",
		"- Rebase " + args.targetBranch + " onto the upstream release tag from " + args.upstreamRepo + ".",
		"- If rebase conflicts occur, preserve the paused rebase state and continue this same thread for intervention.",
		"- Treat the published npm package version as the durable handled-release marker; do not write local hidden version state.",
		"",
		"Handled npm package version:",
		handledRelease ? formatJson(handledRelease) : "unavailable or disabled",
		"",
		"Generated Code Mode source:",
		truncateText(source, 50_000),
	].join("\n");
}

function appServerArgs() {
	return [
		"app-server",
		"--listen",
		"stdio://",
		"--enable",
		"apps",
		"--enable",
		"hooks",
		"--enable",
		"code_mode",
		"--enable",
		"code_mode_only",
	];
}

async function injectAssistantText(
	client: CodexAppServerClient,
	threadId: string,
	text: string,
) {
	await client.request("thread/inject_items", {
		threadId,
		items: [
			{
				type: "message",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text,
					},
				],
			},
		],
	});
}

function parseUpdateResult(output: string): CodeModeUpdateResult | undefined {
	for (const line of output.split(/\r?\n/).reverse()) {
		const prefix = "CODEX_UPDATE_RESULT ";
		const index = line.indexOf(prefix);
		if (index === -1) {
			continue;
		}
		const text = line.slice(index + prefix.length).trim();
		try {
			const parsed = JSON.parse(text) as unknown;
			if (
				isRecord(parsed) &&
				(parsed.status === "completed" ||
					parsed.status === "conflict" ||
					parsed.status === "blocked" ||
					parsed.status === "failed")
			) {
				return parsed as CodeModeUpdateResult;
			}
		} catch {
			return undefined;
		}
	}
	return undefined;
}

async function ensureCodexCommandExists(codexCommand: string | undefined) {
	if (!codexCommand) {
		return;
	}
	if (!path.isAbsolute(codexCommand)) {
		throw new Error(
			`Codex command must be an explicit local fork binary path, not a PATH lookup: ${codexCommand}`,
		);
	}
	if (!(await fileExists(codexCommand))) {
		throw new Error(
			`Codex command does not exist: ${codexCommand}. Build the fork binary first or pass --codex-command.`,
		);
	}
}

type LocalCommandResult = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
};

async function runJson(command: string[]): Promise<unknown> {
	const result = await runCommand(command);
	try {
		return JSON.parse(result.stdout) as unknown;
	} catch (error) {
		throw new Error(`Failed to parse JSON from ${command.join(" ")}: ${errorMessage(error)}`);
	}
}

async function runCommand(
	command: string[],
	options: { allowFailure?: boolean } = {},
): Promise<LocalCommandResult> {
	const child = spawn(command[0] ?? "", command.slice(1), {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		collectText(child.stdout),
		collectText(child.stderr),
		exitCodeFor(child),
	]);
	if (exitCode !== 0 && !options.allowFailure) {
		throw new Error(`${command.join(" ")} failed with exit ${exitCode}:\n${stderr || stdout}`);
	}
	return { exitCode, stdout, stderr };
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

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

function allAgentMessageText(value: unknown) {
	const thread = recordField(value, "thread");
	const turns = Array.isArray(thread?.turns) ? thread.turns : [];
	const texts: string[] = [];
	for (const turn of turns) {
		const turnRecord = isRecord(turn) ? turn : undefined;
		const items = Array.isArray(turnRecord?.items) ? turnRecord.items : [];
		for (const item of items) {
			if (!isRecord(item) || stringField(item, "type") !== "agentMessage") {
				continue;
			}
			const text = stringField(item, "text");
			if (text !== undefined) {
				texts.push(text);
			}
		}
	}
	return texts;
}

function requireReleaseInfo(value: unknown): ReleaseInfo {
	if (!isRecord(value) || typeof value.tagName !== "string" || !value.tagName.trim()) {
		throw new Error("GitHub release response did not include tagName");
	}
	return {
		tagName: value.tagName,
		...(typeof value.name === "string" ? { name: value.name } : {}),
		...(typeof value.publishedAt === "string"
			? { publishedAt: value.publishedAt }
			: {}),
		...(typeof value.url === "string" ? { url: value.url } : {}),
		...(typeof value.body === "string" ? { body: value.body } : {}),
		...(typeof value.targetCommitish === "string"
			? { targetCommitish: value.targetCommitish }
			: {}),
	};
}

function releaseVersion(tagName: string) {
	return tagName.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

function parseArgs(argv: string[]): Args {
	let cargoTargetDir = process.env.CARGO_TARGET_DIR ?? defaultCargoTargetDir;
	let codexCommand = process.env.CODEX_APP_SERVER_CODEX_COMMAND;
	let codexHome: string | undefined;
	let codexRepo = defaultCodexRepo;
	let ephemeral = false;
	let force = false;
	let handledNpmPackage: string | undefined = defaultHandledNpmPackage;
	let npmRegistry = defaultNpmRegistry;
	let releaseTag: string | undefined;
	let serviceRepo = serviceRoot;
	let stream = true;
	let targetBranch = "code-mode-exec-hooks";
	let threadName: string | undefined;
	let timeoutMs = 1_800_000;
	let upstreamRemote = "upstream";
	let upstreamRepo = "openai/codex";

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) {
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			printHelp();
			process.exit(0);
		}
		if (arg === "--cargo-target-dir") {
			cargoTargetDir = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--cargo-target-dir=")) {
			cargoTargetDir = arg.slice("--cargo-target-dir=".length);
			continue;
		}
		if (arg === "--codex-command") {
			codexCommand = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--codex-command=")) {
			codexCommand = arg.slice("--codex-command=".length);
			continue;
		}
		if (arg === "--codex-home") {
			codexHome = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--codex-home=")) {
			codexHome = arg.slice("--codex-home=".length);
			continue;
		}
		if (arg === "--codex-repo") {
			codexRepo = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--codex-repo=")) {
			codexRepo = arg.slice("--codex-repo=".length);
			continue;
		}
		if (arg === "--ephemeral") {
			ephemeral = true;
			continue;
		}
		if (arg === "--force") {
			force = true;
			continue;
		}
		if (arg === "--handled-npm-package") {
			handledNpmPackage = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--handled-npm-package=")) {
			handledNpmPackage = arg.slice("--handled-npm-package=".length);
			continue;
		}
		if (arg === "--no-handled-npm-check" || arg === "--no-handled-release-check") {
			handledNpmPackage = undefined;
			continue;
		}
		if (arg === "--npm-registry") {
			npmRegistry = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--npm-registry=")) {
			npmRegistry = arg.slice("--npm-registry=".length);
			continue;
		}
		if (arg === "--release-tag") {
			releaseTag = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--release-tag=")) {
			releaseTag = arg.slice("--release-tag=".length);
			continue;
		}
		if (arg === "--service-repo") {
			serviceRepo = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--service-repo=")) {
			serviceRepo = arg.slice("--service-repo=".length);
			continue;
		}
		if (arg === "--no-stream") {
			stream = false;
			continue;
		}
		if (arg === "--target-branch") {
			targetBranch = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--target-branch=")) {
			targetBranch = arg.slice("--target-branch=".length);
			continue;
		}
		if (arg === "--name") {
			threadName = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--name=")) {
			threadName = arg.slice("--name=".length);
			continue;
		}
		if (arg === "--timeout-ms") {
			timeoutMs = parsePositiveInteger(requiredValue(argv, ++index, arg), arg);
			continue;
		}
		if (arg.startsWith("--timeout-ms=")) {
			timeoutMs = parsePositiveInteger(arg.slice("--timeout-ms=".length), "--timeout-ms");
			continue;
		}
		if (arg === "--upstream-remote") {
			upstreamRemote = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--upstream-remote=")) {
			upstreamRemote = arg.slice("--upstream-remote=".length);
			continue;
		}
		if (arg === "--upstream-repo") {
			upstreamRepo = requiredValue(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--upstream-repo=")) {
			upstreamRepo = arg.slice("--upstream-repo=".length);
			continue;
		}
		throw new Error("unknown argument: " + arg);
	}

	cargoTargetDir = path.resolve(cargoTargetDir);
	codexCommand = codexCommand ? resolveCommand(codexCommand) : undefined;
	codexRepo = path.resolve(codexRepo);
	serviceRepo = path.resolve(serviceRepo);

	return {
		cargoTargetDir,
		codexCommand,
		codexHome,
		codexRepo,
		ephemeral,
		force,
		handledNpmPackage,
		npmRegistry,
		releaseTag,
		serviceRepo,
		stream,
		targetBranch,
		threadName,
		timeoutMs,
		upstreamRemote,
		upstreamRepo,
	};
}

function requiredValue(argv: string[], index: number, flag: string) {
	const value = argv[index];
	if (!value) {
		throw new Error(flag + " requires a value");
	}
	return value;
}

function parsePositiveInteger(value: string, flag: string) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`invalid ${flag} value: ${value}`);
	}
	return parsed;
}

function resolveCommand(command: string) {
	if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
		return path.resolve(command);
	}
	return command;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

function writeJson(value: unknown) {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatJson(value: unknown) {
	return JSON.stringify(value, null, 2);
}

function truncateText(value: string, limit: number) {
	if (value.length <= limit) {
		return value;
	}
	return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(value: unknown, field: string) {
	if (!isRecord(value)) {
		return undefined;
	}
	const nested = value[field];
	return isRecord(nested) ? nested : undefined;
}

function stringField(value: unknown, field: string) {
	if (!isRecord(value)) {
		return undefined;
	}
	const fieldValue = value[field];
	return typeof fieldValue === "string" ? fieldValue : undefined;
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function printHelp() {
	process.stdout.write(
		[
			"Run the openai/codex release update flow inside a native Code Mode thread.",
			"",
			"Usage:",
			"  tsx scripts/run-codex-release-update-thread.ts [options]",
			"",
			"Options:",
			"  --release-tag <tag>          Use a specific openai/codex release tag instead of latest.",
			"  --force                      Run even when the handled npm package version exists.",
			"  --handled-npm-package <pkg>  Durable handled npm package. Defaults to " +
				defaultHandledNpmPackage,
			"  --npm-registry <url>         npm registry URL. Defaults to " +
				defaultNpmRegistry,
			"  --no-handled-npm-check       Do not compare against a handled npm package.",
			"  --no-handled-release-check   Alias for --no-handled-npm-check.",
			"  --codex-repo <dir>           Local codex fork checkout. Defaults to " + defaultCodexRepo,
			"  --service-repo <dir>         codex-flows checkout. Defaults to " + serviceRoot,
			"  --target-branch <branch>     Fork branch to rebase. Defaults to code-mode-exec-hooks.",
			"  --upstream-repo <owner/repo> GitHub release source. Defaults to openai/codex.",
			"  --upstream-remote <name>     Local remote name for upstream. Defaults to upstream.",
			"  --cargo-target-dir <dir>     Cargo target dir. Defaults to " + defaultCargoTargetDir,
			"  --codex-command <path>       Explicit fork Codex binary used to start app-server.",
			"                               Defaults to CODEX_APP_SERVER_CODEX_COMMAND.",
			"                               With CODEX_FLOWS_MODE=code-mode, falls back to",
			"                               vp dlx @peezy.tech/codex.",
			"  --codex-home <dir>           CODEX_HOME for the spawned app-server.",
			"  --timeout-ms <ms>            App-server request and flow timeout. Defaults to 1800000.",
			"  --name <text>                Thread name.",
			"  --ephemeral                  Create an ephemeral thread.",
			"  --no-stream                  Do not stream Code Mode output.",
			"  -h, --help                   Show this help.",
			"",
			"Exit codes:",
			"  0 completed or skipped",
			"  1 failed or blocked",
			"  2 rebase conflict, with rebase state intentionally left paused",
			"",
		].join("\n"),
	);
}

await main().catch((error) => {
	process.stderr.write(`${errorMessage(error)}\n`);
	process.exitCode = 1;
});
