import { describe, expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	WorkspaceFunctionRuntime,
	createWorkspaceFunctionMethods,
	defineFunctions,
	findFunctionsManifest,
} from "../src/functions.ts";

describe("workspace functions", () => {
	test("defineFunctions returns definitions unchanged", () => {
		const definitions = defineFunctions({
			ping: () => ({ ok: true }),
		});
		expect(Object.keys(definitions)).toEqual(["ping"]);
	});

	test("loads TypeScript manifest metadata and calls handlers", async () => {
		const root = await createWorkspace(`export default {
			greet: {
				description: "Greet a person.",
				inputSchema: { type: "object", properties: { name: { type: "string" } } },
				outputSchema: { type: "object" },
				tags: ["demo"],
				handler: async (params) => ({ message: "hello " + params.name })
			},
			snapshot: async () => ({ ok: true })
		};`);
		const runtime = new WorkspaceFunctionRuntime({ cwd: root });

		await expect(findFunctionsManifest(root)).resolves.toMatch(/functions\.ts$/);
		await expect(runtime.list()).resolves.toEqual({
			functions: [
				{
					name: "greet",
					description: "Greet a person.",
					inputSchema: { type: "object", properties: { name: { type: "string" } } },
					outputSchema: { type: "object" },
					tags: ["demo"],
					sideEffects: "read-only",
				},
				{
					name: "snapshot",
					description: "",
					sideEffects: "read-only",
				},
			],
		});
		await expect(runtime.describe("greet")).resolves.toMatchObject({
			function: { name: "greet", sideEffects: "read-only" },
		});
		await expect(runtime.call("greet", { name: "Ada" })).resolves.toEqual({
			result: { message: "hello Ada" },
		});
	});

	test("reports missing functions and handler failures", async () => {
		const root = await createWorkspace(`export default {
			fail: {
				description: "Always fails.",
				handler: async () => { throw new Error("boom"); }
			}
		};`);
		const runtime = new WorkspaceFunctionRuntime({ cwd: root });

		await expect(runtime.describe("missing")).rejects.toThrow("Workspace function not found: missing");
		await expect(runtime.call("fail")).rejects.toThrow("boom");
	});

	test("rejects non JSON-serializable results", async () => {
		const root = await createWorkspace(`export default {
			circular: () => {
				const value = {};
				value.self = value;
				return value;
			},
			empty: () => undefined
		};`);
		const runtime = new WorkspaceFunctionRuntime({ cwd: root });

		await expect(runtime.call("circular")).rejects.toThrow("Workspace function returned non-JSON data: circular");
		await expect(runtime.call("empty")).rejects.toThrow("Workspace function returned non-JSON data: empty");
	});

	test("creates workspace backend methods", async () => {
		const root = await createWorkspace(`export default {
			echo: {
				description: "Echo params.",
				handler: (params) => params
			}
		};`);
		const methods = createWorkspaceFunctionMethods({ cwd: root });

		await expect(methods["functions.list"]?.({}, rpcRequest("functions.list")))
			.resolves.toMatchObject({ functions: [{ name: "echo" }] });
		await expect(methods["functions.call"]?.(
			{ name: "echo", params: { ok: true } },
			rpcRequest("functions.call"),
		)).resolves.toEqual({ result: { ok: true } });
	});
});

async function createWorkspace(source: string): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "codex-functions-"));
	await mkdir(path.join(root, ".codex"), { recursive: true });
	await writeFile(path.join(root, ".codex", "functions.ts"), source);
	return root;
}

function rpcRequest(method: string) {
	return {
		jsonrpc: "2.0" as const,
		id: "test",
		method,
		params: {},
	};
}
