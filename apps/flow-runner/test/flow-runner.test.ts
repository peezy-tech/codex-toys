import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("fire preserves the existing event/results payload shape", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "flow-runner-"));
	try {
		await writeFlow(directory);
		const eventPath = path.join(directory, "event.json");
		await Bun.write(
			eventPath,
			JSON.stringify({
				id: "event-1",
				type: "demo.event",
				receivedAt: "2026-05-15T00:00:00.000Z",
				payload: { name: "Ada" },
			}),
		);

		const runner = path.resolve(import.meta.dir, "..", "src", "index.ts");
		const process = Bun.spawn({
			cmd: ["bun", runner, "--cwd", directory, "fire", "--event", eventPath],
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
			process.exited,
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

async function writeFlow(root: string): Promise<void> {
	const flowRoot = path.join(root, "flows/demo");
	await mkdir(path.join(flowRoot, "exec"), { recursive: true });
	await mkdir(path.join(flowRoot, "schemas"), { recursive: true });
	await Bun.write(
		path.join(flowRoot, "flow.toml"),
		[
			'name = "demo"',
			"version = 1",
			'description = "demo"',
			"",
			"[[steps]]",
			'name = "hello"',
			'runner = "bun"',
			'script = "exec/hello.ts"',
			"timeout_ms = 30000",
			"",
			"[steps.trigger]",
			'type = "demo.event"',
			'schema = "schemas/demo-event.schema.json"',
			"",
		].join("\n"),
	);
	await Bun.write(
		path.join(flowRoot, "schemas/demo-event.schema.json"),
		JSON.stringify({
			type: "object",
			required: ["name"],
			properties: {
				name: { type: "string" },
			},
		}),
	);
	await Bun.write(
		path.join(flowRoot, "exec/hello.ts"),
		[
			"const context = JSON.parse(await Bun.stdin.text());",
			"const name = context.flow.event.payload.name;",
			"console.log(`FLOW_RESULT ${JSON.stringify({ status: 'completed', message: `hello ${name}` })}`);",
			"",
		].join("\n"),
	);
}
