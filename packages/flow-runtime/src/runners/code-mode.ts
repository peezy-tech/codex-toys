import { readFile } from "node:fs/promises";
import path from "node:path";
import { CodexAppServerClient } from "@peezy.tech/codex-flows";
import type { FlowProgressSink } from "../client-types.ts";
import { stepScriptPath } from "../manifest.ts";
import { parseFlowResult } from "../result.ts";
import type { FlowEvent, FlowResult, FlowStep, LoadedFlow } from "../types.ts";

export type RunCodeModeStepOptions = {
	flow: LoadedFlow;
	step: FlowStep;
	event: FlowEvent;
	codexCommand?: string;
	codexHome?: string;
	stream?: boolean;
	progress?: FlowProgressSink;
};

export async function runCodeModeStep(options: RunCodeModeStepOptions): Promise<FlowResult> {
	const source = await codeModeSource(options);
	const client = new CodexAppServerClient({
		transportOptions: {
			codexCommand: options.codexCommand,
			args: appServerArgs(),
			env: options.codexHome ? { CODEX_HOME: path.resolve(options.codexHome) } : undefined,
			requestTimeoutMs: options.step.timeoutMs,
		},
		clientName: "codex-flow-runner",
		clientTitle: "Codex Flow Runner",
		clientVersion: "0.1.0",
	});
	const output: string[] = [];
	let threadId = "";
	let resolveTurnCompleted: (value: unknown) => void = () => undefined;
	const turnCompleted = new Promise((resolve) => {
		resolveTurnCompleted = resolve;
	});

	client.on("request", (message) => {
		client.respondError(message.id, -32603, "flow runner does not handle server requests");
	});
	client.on("notification", (message) => {
		if (message.method === "item/commandExecution/outputDelta" || message.method === "item/agentMessage/delta") {
			const delta = stringField(message.params, "delta");
			if (delta) {
				output.push(delta);
				if (options.stream) {
					if (options.progress) {
						options.progress({
							kind: "stdout",
							createdAt: new Date().toISOString(),
							eventId: options.event.id,
							flowName: options.flow.manifest.name,
							stepName: options.step.name,
							runner: options.step.runner,
							text: delta,
						});
					} else {
						process.stdout.write(delta);
					}
				}
			}
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
			cwd: options.step.cwd ? path.resolve(options.flow.root, options.step.cwd) : options.flow.root,
			approvalPolicy: "never",
			sandbox: "danger-full-access",
			ephemeral: false,
			experimentalRawEvents: false,
			persistExtendedHistory: true,
		});
		threadId = started.thread.id;
		options.progress?.({
			kind: "stderr",
			createdAt: new Date().toISOString(),
			eventId: options.event.id,
			flowName: options.flow.manifest.name,
			stepName: options.step.name,
			runner: options.step.runner,
			text: `[flow] thread ${threadId}\n`,
		});
		await client.request("thread/codeMode/execute", {
			threadId,
			source,
		});
		await withTimeout(
			turnCompleted,
			options.step.timeoutMs,
			`timed out waiting for Code Mode flow step ${options.flow.manifest.name}/${options.step.name}`,
		);
		const read = await client.request("thread/read", {
			threadId,
			includeTurns: true,
		});
		return parseFlowResult(allAgentMessageText(read).join("\n") || output.join(""));
	} finally {
		client.close();
	}
}

async function codeModeSource(options: RunCodeModeStepOptions): Promise<string> {
	const body = await readFile(stepScriptPath(options.flow, options.step), "utf8");
	const flow = {
		name: options.flow.manifest.name,
		version: options.flow.manifest.version,
		root: options.flow.root,
		step: options.step.name,
		...(options.flow.manifest.config ? { config: options.flow.manifest.config } : {}),
		event: options.event,
	};
	return [
		`const flow = ${JSON.stringify(flow, null, 2)};`,
		"function result(value) {",
		"  text('\\nFLOW_RESULT ' + JSON.stringify(value) + '\\n');",
		"  exit();",
		"}",
		body,
	].join("\n");
}

function appServerArgs(): string[] {
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
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

function allAgentMessageText(value: unknown): string[] {
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

function recordField(value: unknown, field: string): Record<string, unknown> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	return isRecord(value[field]) ? value[field] : undefined;
}

function stringField(value: unknown, field: string): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const fieldValue = value[field];
	return typeof fieldValue === "string" ? fieldValue : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
