import { expect, test } from "vite-plus/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));

test("fire preserves the existing event/results payload shape", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "flow-runner-"));
	try {
		await writeFlow(directory);
		const eventPath = path.join(directory, "event.json");
		await writeFile(
			eventPath,
			JSON.stringify({
				id: "event-1",
				type: "demo.event",
				receivedAt: "2026-05-15T00:00:00.000Z",
				payload: { name: "Ada" },
			}),
		);

		const runner = path.resolve(testDir, "..", "src", "index.ts");
		const child = spawn(process.execPath, [
			"--import",
			import.meta.resolve("tsx"),
			runner,
			"--cwd",
			directory,
			"fire",
			"--event",
			eventPath,
		], { stdio: ["ignore", "pipe", "pipe"] });
		const [stdout, stderr, exitCode] = await Promise.all([
			collectText(child.stdout),
			collectText(child.stderr),
			exitCodeFor(child),
		]);

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			eventId: "event-1",
			results: [
				{
					flow: "demo",
					step: "hello",
					result: {
						status: "completed",
						message: "hello Ada",
					},
				},
			],
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("run passes runtime metadata flags into Node step context", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "flow-runner-"));
	try {
		await writeFlow(directory, [
			"export default async (context) => ({",
			"  status: 'completed',",
			"  artifacts: {",
			"    eventId: context.runtime.eventId,",
			"    runId: context.runtime.runId,",
			"    attemptId: context.runtime.attemptId,",
			"    replay: context.runtime.replay,",
			"    workspaceBackendUrl: context.runtime.workspaceBackendUrl,",
			"  },",
			"});",
			"",
		].join("\n"));
		const eventPath = path.join(directory, "event.json");
		await writeFile(
			eventPath,
			JSON.stringify({
				id: "event-1",
				type: "demo.event",
				receivedAt: "2026-05-15T00:00:00.000Z",
				payload: { name: "Ada" },
			}),
		);

		const runner = path.resolve(testDir, "..", "src", "index.ts");
		const child = spawn(process.execPath, [
			"--import",
			import.meta.resolve("tsx"),
			runner,
			"--cwd",
			directory,
			"run",
			"demo",
			"hello",
			"--event",
			eventPath,
			"--run-id",
			"run_123",
			"--attempt-id",
			"attempt_1",
			"--replay",
			"--workspace-backend-url",
			"ws://127.0.0.1:3586",
		], { stdio: ["ignore", "pipe", "pipe"] });
		const [stdout, stderr, exitCode] = await Promise.all([
			collectText(child.stdout),
			collectText(child.stderr),
			exitCodeFor(child),
		]);

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			flow: "demo",
			step: "hello",
			result: {
				status: "completed",
				artifacts: {
					eventId: "event-1",
					runId: "run_123",
					attemptId: "attempt_1",
					replay: true,
					workspaceBackendUrl: "ws://127.0.0.1:3586",
				},
			},
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

async function writeFlow(root: string, script?: string): Promise<void> {
	const flowRoot = path.join(root, "flows/demo");
	await mkdir(path.join(flowRoot, "exec"), { recursive: true });
	await mkdir(path.join(flowRoot, "schemas"), { recursive: true });
	await writeFile(
		path.join(flowRoot, "flow.toml"),
		[
			'name = "demo"',
			"version = 1",
			'description = "demo"',
			"",
			"[[steps]]",
			'name = "hello"',
			'runner = "node"',
			'script = "exec/hello.ts"',
			"timeout_ms = 30000",
			"",
			"[steps.trigger]",
			'type = "demo.event"',
			'schema = "schemas/demo-event.schema.json"',
			"",
		].join("\n"),
	);
	await writeFile(
		path.join(flowRoot, "schemas/demo-event.schema.json"),
		JSON.stringify({
			type: "object",
			required: ["name"],
			properties: {
				name: { type: "string" },
			},
		}),
	);
		await writeFile(
			path.join(flowRoot, "exec/hello.ts"),
			script ?? [
				"async function main() {",
				"  const chunks = [];",
				"  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);",
				"  const context = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
				"  const name = context.flow.event.payload.name;",
				"  console.log(`FLOW_RESULT ${JSON.stringify({ status: 'completed', message: `hello ${name}` })}`);",
				"}",
				"void main();",
				"",
			].join("\n"),
		);
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
