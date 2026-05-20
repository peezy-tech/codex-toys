import path from "node:path";
import { pathToFileURL } from "node:url";
import { stringifyFlowResult } from "../result.ts";
import type { FlowResult, FlowRunContext } from "../types.ts";

const scriptPath = process.argv[2];

try {
	if (!scriptPath) {
		throw new Error("Node module runner requires a script path");
	}
	const context = JSON.parse(await readStdinText()) as FlowRunContext;
	const moduleUrl = pathToFileURL(path.resolve(scriptPath));
	moduleUrl.searchParams.set("flowRun", context.runtime.runId ?? `${Date.now()}`);
	const module = await import(moduleUrl.href) as { default?: unknown };
	if (typeof module.default !== "function") {
		throw new Error("Node module flow step must export a default handler function");
	}
	const result = await module.default(context) as unknown;
	if (!isFlowResult(result)) {
		throw new Error("Node module flow step must return a FlowResult object");
	}
	process.stdout.write(stringifyFlowResult(result));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	const stack = error instanceof Error ? error.stack : undefined;
	process.stderr.write(`${stack ?? message}\n`);
	process.stdout.write(stringifyFlowResult({ status: "failed", message }));
}

function isFlowResult(value: unknown): value is FlowResult {
	return isRecord(value) && typeof value.status === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStdinText(): Promise<string> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}
