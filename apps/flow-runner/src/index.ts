#!/usr/bin/env bun
import path from "node:path";
import {
	discoverFlows,
	createLocalFlowClient,
	runFlowStep,
	type FlowEvent,
	type FlowRunRuntimeInput,
	type LoadedFlow,
	type FlowStep,
} from "@peezy.tech/codex-flows/flow-runtime";

type Cli =
	| { kind: "help" }
	| { kind: "list"; cwd: string }
	| { kind: "fire"; cwd: string; eventPath: string }
	| {
			kind: "run";
			cwd: string;
			flow: string;
			step: string;
			eventPath: string;
			runtime: FlowRunRuntimeInput;
	  };

await main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});

async function main(): Promise<void> {
	const cli = parseArgs(Bun.argv.slice(2));
	if (cli.kind === "help") {
		process.stdout.write(helpText());
		return;
	}
	const flows = await discoverFlows({ cwd: cli.cwd });
	if (cli.kind === "list") {
		for (const flow of flows) {
			process.stdout.write(`${flow.manifest.name}\t${flow.root}\n`);
		}
		return;
	}
	const event = await readEvent(cli.eventPath);
	if (cli.kind === "fire") {
		const client = createLocalFlowClient({
			cwd: cli.cwd,
			env: process.env,
			codex: {
				command: process.env.CODEX_APP_SERVER_CODEX_COMMAND,
				codexHome: process.env.CODEX_HOME,
				stream: true,
			},
		});
		const dispatch = await client.dispatchEvent(event);
		const results = dispatch.runs.map((run) => {
			if (!run.resultPayload && run.error) {
				throw new Error(run.error);
			}
			return {
				flow: run.flowName,
				step: run.stepName,
				result: run.resultPayload,
			};
		});
		process.stdout.write(`${JSON.stringify({ eventId: event.id, results }, null, 2)}\n`);
		return;
	}
	const flow = requireFlow(flows, cli.flow);
	const step = requireStep(flow, cli.step);
	const result = await runAndReport(flow, step, event, cli.runtime);
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runAndReport(
	flow: LoadedFlow,
	step: FlowStep,
	event: FlowEvent,
	runtime: FlowRunRuntimeInput,
): Promise<Record<string, unknown>> {
	const result = await runFlowStep({
		flow,
		step,
		event,
		env: process.env,
		runtime: {
			eventId: event.id,
			...runtime,
		},
		codeMode: {
			codexCommand: process.env.CODEX_APP_SERVER_CODEX_COMMAND,
			codexHome: process.env.CODEX_HOME,
			stream: true,
		},
	});
	return {
		flow: flow.manifest.name,
		step: step.name,
		result,
	};
}

async function readEvent(eventPath: string): Promise<FlowEvent> {
	const parsed = JSON.parse(await Bun.file(path.resolve(eventPath)).text()) as unknown;
	if (!isRecord(parsed) || typeof parsed.id !== "string" || typeof parsed.type !== "string") {
		throw new Error("event file must contain at least string id and type");
	}
	return {
		receivedAt: new Date().toISOString(),
		payload: {},
		...parsed,
	} as FlowEvent;
}

function requireFlow(flows: LoadedFlow[], name: string): LoadedFlow {
	const flow = flows.find((entry) => entry.manifest.name === name);
	if (!flow) {
		throw new Error(`Unknown flow: ${name}`);
	}
	return flow;
}

function requireStep(flow: LoadedFlow, name: string): FlowStep {
	const step = flow.manifest.steps.find((entry) => entry.name === name);
	if (!step) {
		throw new Error(`Unknown step ${name} in flow ${flow.manifest.name}`);
	}
	return step;
}

function parseArgs(argv: string[]): Cli {
	let cwd = process.cwd();
	const runtime: FlowRunRuntimeInput = {};
	const args: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) {
			continue;
		}
		if (arg === "--cwd") {
			cwd = path.resolve(required(argv, ++index, arg));
			continue;
		}
		if (arg.startsWith("--cwd=")) {
			cwd = path.resolve(arg.slice("--cwd=".length));
			continue;
		}
		if (arg === "--run-id") {
			runtime.runId = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--run-id=")) {
			runtime.runId = arg.slice("--run-id=".length);
			continue;
		}
		if (arg === "--attempt-id") {
			runtime.attemptId = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--attempt-id=")) {
			runtime.attemptId = arg.slice("--attempt-id=".length);
			continue;
		}
		if (arg === "--replay") {
			runtime.replay = true;
			continue;
		}
		if (arg === "--workspace-backend-url") {
			runtime.workspaceBackendUrl = required(argv, ++index, arg);
			continue;
		}
		if (arg.startsWith("--workspace-backend-url=")) {
			runtime.workspaceBackendUrl = arg.slice("--workspace-backend-url=".length);
			continue;
		}
		args.push(arg);
	}

	const command = args[0];
	if (!command || command === "-h" || command === "--help" || command === "help") {
		return { kind: "help" };
	}
	if (command === "list") {
		return { kind: "list", cwd };
	}
	if (command === "fire") {
		return { kind: "fire", cwd, eventPath: eventPathArg(args, 1) };
	}
	if (command === "run") {
		const flow = args[1];
		const step = args[2];
		if (!flow || !step) {
			throw new Error("run requires <flow> <step>");
		}
		return { kind: "run", cwd, flow, step, eventPath: eventPathArg(args, 3), runtime };
	}
	throw new Error(`Unknown command: ${command}`);
}

function eventPathArg(args: string[], start: number): string {
	for (let index = start; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--event") {
			return required(args, index + 1, "--event");
		}
		if (arg?.startsWith("--event=")) {
			return arg.slice("--event=".length);
		}
	}
	throw new Error("missing --event <path>");
}

function required(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function helpText(): string {
	return [
		"Usage:",
		"  codex-flow-runner [--cwd <dir>] list",
		"  codex-flow-runner [--cwd <dir>] fire --event <event.json>",
		"  codex-flow-runner [--cwd <dir>] run <flow> <step> --event <event.json> [--run-id <id>] [--attempt-id <id>] [--replay] [--workspace-backend-url <ws-url>]",
		"",
	].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
