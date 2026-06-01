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
import {
	startWorkbenchDelegationWithRequest,
	type WorkbenchDelegationListResult,
} from "@codex-toys/workbench";

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

const toyboxProperty = {
	timeoutMs: {
		type: "number",
		description: "Request timeout in milliseconds.",
	},
};

export const codexToysMcpTools: McpToolDefinition[] = [
	{
		name: "delegate_start",
		description: "Start a delegated Codex thread in another cwd through the current codex-toys toybox.",
		inputSchema: {
			...jsonObjectSchema,
			properties: {
				...toyboxProperty,
				cwd: {
					type: "string",
					description: "Target cwd. Use @/path for a path under the current workbench root.",
				},
				prompt: { type: "string" },
				title: { type: "string" },
				groupId: { type: "string" },
				returnMode: {
					type: "string",
					enum: ["detached", "record_only", "wake_on_done", "wake_on_group", "manual"],
				},
				wait: { type: "boolean" },
				allowAbsoluteCwd: { type: "boolean" },
				model: { type: "string" },
				sandbox: {
					type: "string",
					enum: ["danger-full-access", "workspace-write", "read-only"],
				},
				approvalPolicy: {
					type: "string",
					enum: ["never", "on-failure", "on-request", "untrusted"],
				},
				permissions: { type: "string" },
			},
			required: ["cwd"],
		},
	},
	{
		name: "delegate_list",
		description: "List workbench delegations and discovered @/workbenches and @/repos targets.",
		inputSchema: {
			...jsonObjectSchema,
			properties: {
				...toyboxProperty,
				includeTargets: { type: "boolean" },
			},
		},
	},
	{
		name: "delegate_read",
		description: "Read and refresh a delegated Codex thread record.",
		inputSchema: {
			...jsonObjectSchema,
			properties: {
				...toyboxProperty,
				delegationId: { type: "string" },
				id: { type: "string" },
				threadId: { type: "string" },
			},
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
	return await withWorkbenchTransport({ ...options, timeoutMs }, async (transport) => {
		if (name === "delegate_start") {
			return await startWorkbenchDelegationWithRequest(
				async (method, params) => await transport.request(method, params),
				{
					cwd: requiredString(args.cwd, "cwd"),
					prompt: stringValue(args.prompt),
					title: stringValue(args.title),
					groupId: stringValue(args.groupId),
					returnMode: returnModeValue(args.returnMode),
					wait: booleanValue(args.wait, false),
					timeoutMs,
					allowAbsoluteCwd: booleanValue(args.allowAbsoluteCwd, false),
					model: stringValue(args.model),
					sandbox: stringValue(args.sandbox),
					approvalPolicy: stringValue(args.approvalPolicy),
					permissions: stringValue(args.permissions),
				},
			);
		}
		if (name === "delegate_list") {
			return await transport.request<WorkbenchDelegationListResult>(
				"delegation.list",
				{ includeTargets: booleanValue(args.includeTargets, true) },
			);
		}
		if (name === "delegate_read") {
			return await transport.request("delegation.read", compactUndefined({
				delegationId: stringValue(args.delegationId),
				id: stringValue(args.id),
				threadId: stringValue(args.threadId),
			}));
		}
		throw new Error(`unknown codex-toys tool: ${name}`);
	});
}

async function withWorkbenchTransport<T>(
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

function booleanValue(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return value === "1" || value === "true" || value === "yes" || value === "on";
	}
	return fallback;
}

function returnModeValue(value: unknown): "detached" | "record_only" | "wake_on_done" | "wake_on_group" | "manual" | undefined {
	if (
		value === "detached" ||
		value === "record_only" ||
		value === "wake_on_done" ||
		value === "wake_on_group" ||
		value === "manual"
	) {
		return value;
	}
	if (value !== undefined) {
		throw new Error("returnMode must be detached, record_only, wake_on_done, wake_on_group, or manual");
	}
	return undefined;
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
