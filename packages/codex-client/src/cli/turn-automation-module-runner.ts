import path from "node:path";
import { pathToFileURL } from "node:url";

const resultPrefix = "TURN_AUTOMATION ";
const scriptPath = process.argv[2];

try {
	if (!scriptPath) {
		throw new Error("Turn automation module runner requires a script path");
	}
	const context = JSON.parse(await readStdinText()) as unknown;
	const moduleUrl = pathToFileURL(path.resolve(scriptPath));
	moduleUrl.searchParams.set("automationRun", `${Date.now()}`);
	const module = await import(moduleUrl.href) as { default?: unknown };
	if (typeof module.default !== "function") {
		throw new Error("Turn automation module must export a default handler function");
	}
	const result = await module.default(context) as unknown;
	if (!isRecord(result) || typeof result.action !== "string") {
		throw new Error("Turn automation module must return an object with an action");
	}
	process.stdout.write(`${resultPrefix}${JSON.stringify(result)}\n`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	const stack = error instanceof Error ? error.stack : undefined;
	process.stderr.write(`${stack ?? message}\n`);
	process.exitCode = 1;
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
