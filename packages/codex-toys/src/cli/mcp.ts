import type { CodexToyboxTransport } from "@codex-toys/toybox";
import {
	TOYBOX_INITIALIZE_METHOD,
} from "@codex-toys/toybox";
import {
	createLocalToyboxTransport,
	createSshToyboxTransport,
	hasSshRemote,
	type SshRemoteProviderOptions,
} from "@codex-toys/remote";

type JsonRpcId = string | number | null;

type JsonRpcMessage = {
	jsonrpc?: string;
	id?: JsonRpcId;
	method?: string;
	params?: unknown;
};

type McpToolDefinition = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
};

type McpServerOptions = {
	timeoutMs: number;
	sshTarget?: string;
	cwd?: string;
	toyboxCommand?: string;
	remoteCodexCommand?: string;
	remoteCodexArgs?: string[];
};

const jsonObjectSchema = {
	type: "object",
	additionalProperties: false,
};

const runtimeProperty = {
	timeoutMs: {
		type: "number",
		description: "Request timeout in milliseconds.",
	},
};

export const codexToysMcpTools: McpToolDefinition[] = [
	{
		name: "functions_list",
		description: "List JSON-in/JSON-out workspace functions declared by the current codex-toys runtime.",
		inputSchema: {
			...jsonObjectSchema,
			properties: {
				...runtimeProperty,
			},
		},
	},
	{
		name: "functions_describe",
		description: "Read metadata and schemas for one workspace function.",
		inputSchema: {
			...jsonObjectSchema,
			properties: {
				...runtimeProperty,
				name: { type: "string" },
			},
			required: ["name"],
		},
	},
	{
		name: "functions_call",
		description: "Call a workspace function with JSON params.",
		inputSchema: {
			...jsonObjectSchema,
			properties: {
				...runtimeProperty,
				name: { type: "string" },
				params: {},
			},
			required: ["name"],
		},
	},
];

export function serveCodexToysMcp(options: McpServerOptions): void {
	let buffer = Buffer.alloc(0);
	process.stdin.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
		while (true) {
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) {
				return;
			}
			const header = buffer.subarray(0, headerEnd).toString("utf8");
			const match = header.match(/content-length:\s*(\d+)/i);
			if (!match?.[1]) {
				throw new Error("MCP message missing Content-Length");
			}
			const length = Number(match[1]);
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + length;
			if (buffer.length < bodyEnd) {
				return;
			}
			const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
			buffer = buffer.subarray(bodyEnd);
			void handleRpcMessage(JSON.parse(body) as JsonRpcMessage, options);
		}
	});
}

async function handleRpcMessage(
	message: JsonRpcMessage,
	options: McpServerOptions,
): Promise<void> {
	if (message.id === undefined || message.id === null) {
		return;
	}
	try {
		if (message.method === "initialize") {
			writeRpc({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "codex-toys", version: "0.1.0" },
				},
			});
			return;
		}
		if (message.method === "tools/list") {
			writeRpc({
				jsonrpc: "2.0",
				id: message.id,
				result: { tools: codexToysMcpTools },
			});
			return;
		}
		if (message.method === "tools/call") {
			const params = record(message.params);
			const name = stringValue(params.name) ?? "";
			try {
				const result = await callCodexToysMcpTool(
					name,
					record(params.arguments),
					options,
				);
				writeRpc({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					},
				});
			} catch (error) {
				writeRpc({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						isError: true,
						content: [{ type: "text", text: errorMessage(error) }],
					},
				});
			}
			return;
		}
		if (message.method === "ping") {
			writeRpc({ jsonrpc: "2.0", id: message.id, result: {} });
			return;
		}
		writeRpc({
			jsonrpc: "2.0",
			id: message.id,
			error: { code: -32601, message: `method not found: ${message.method ?? "unknown"}` },
		});
	} catch (error) {
		writeRpc({
			jsonrpc: "2.0",
			id: message.id,
			error: { code: -32603, message: errorMessage(error) },
		});
	}
}

async function callCodexToysMcpTool(
	name: string,
	args: Record<string, unknown>,
	options: McpServerOptions,
): Promise<unknown> {
	const timeoutMs = numberValue(args.timeoutMs) ?? options.timeoutMs;
	return await withRuntimeTransport({ ...options, timeoutMs }, async (transport) => {
		if (name === "functions_list") {
			return await transport.request("functions.list", {});
		}
		if (name === "functions_describe") {
			return await transport.request("functions.describe", {
				name: requiredString(args.name, "name"),
			});
		}
		if (name === "functions_call") {
			return await transport.request("functions.call", compactUndefined({
				name: requiredString(args.name, "name"),
				params: args.params,
			}));
		}
		throw new Error(`unknown codex-toys tool: ${name}`);
	});
}

async function withRuntimeTransport<T>(
	options: { timeoutMs: number } & SshRemoteProviderOptions,
	callback: (transport: CodexToyboxTransport) => Promise<T>,
): Promise<T> {
	const transport = hasSshRemote(options)
		? createSshToyboxTransport(options)
		: createLocalToyboxTransport(options);
	try {
		transport.start();
		await transport.request(TOYBOX_INITIALIZE_METHOD, {
			clientInfo: {
				name: "codex-toys-mcp",
				title: "Codex Toys MCP",
				version: "0.1.0",
			},
			capabilities: { appPassThrough: true },
		});
		return await callback(transport);
	} finally {
		transport.close();
	}
}

function writeRpc(value: unknown): void {
	const body = JSON.stringify(value);
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function requiredString(value: unknown, name: string): string {
	const result = stringValue(value);
	if (!result) {
		throw new Error(`${name} is required`);
	}
	return result;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function compactUndefined<T extends Record<string, unknown>>(value: T): T {
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			result[key] = entry;
		}
	}
	return result as T;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
