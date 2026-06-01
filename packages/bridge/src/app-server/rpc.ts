export type JsonRpcId = string | number;

export type JsonRpcRequest = {
	id: JsonRpcId;
	method: string;
	params?: unknown;
	jsonrpc?: "2.0";
};

export type JsonRpcNotification = {
	method: string;
	params?: unknown;
	jsonrpc?: "2.0";
};

export type JsonRpcResponse = {
	id: JsonRpcId;
	result?: unknown;
	error?: JsonRpcErrorObject;
	jsonrpc?: "2.0";
};

export type JsonRpcErrorObject = {
	code: number;
	message: string;
	data?: unknown;
};

export type JsonRpcMessage =
	| JsonRpcRequest
	| JsonRpcNotification
	| JsonRpcResponse;

export class JsonRpcError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(error: JsonRpcErrorObject) {
		super(error.message);
		this.name = "JsonRpcError";
		this.code = error.code;
		this.data = error.data;
	}
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
	return isRecord(value) && "id" in value && ("result" in value || "error" in value);
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
	return (
		isRecord(value) &&
		"id" in value &&
		typeof value.method === "string" &&
		!("result" in value) &&
		!("error" in value)
	);
}

export function isJsonRpcNotification(
	value: unknown,
): value is JsonRpcNotification {
	return (
		isRecord(value) &&
		!("id" in value) &&
		typeof value.method === "string" &&
		!("result" in value) &&
		!("error" in value)
	);
}

export function requireJsonRpcResult<T>(response: JsonRpcResponse): T {
	if (response.error) {
		throw new JsonRpcError(response.error);
	}
	return response.result as T;
}

export function stringifyJsonRpc(message: JsonRpcMessage): string {
	return `${JSON.stringify(message, (_key, value) =>
		typeof value === "bigint" ? value.toString() : value,
	)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
