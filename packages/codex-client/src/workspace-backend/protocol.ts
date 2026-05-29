import type {
	JsonRpcId,
	JsonRpcNotification,
	JsonRpcRequest,
} from "../app-server/rpc.ts";

export const WORKSPACE_BACKEND_INITIALIZE_METHOD = "workspace.initialize";
export const WORKSPACE_BACKEND_EVENT_METHOD = "workspace.event";
export const APP_SERVER_CALL_METHOD = "appServer.call";
export const APP_SERVER_NOTIFY_METHOD = "appServer.notify";
export const APP_SERVER_RESPOND_METHOD = "appServer.respond";
export const APP_SERVER_RESPOND_ERROR_METHOD = "appServer.respondError";
export const APP_SERVER_NOTIFICATION_METHOD = "appServer.notification";
export const APP_SERVER_REQUEST_METHOD = "appServer.request";

export type WorkspaceBackendInitializeParams = {
	clientInfo?: {
		name?: string;
		title?: string | null;
		version?: string;
	};
	capabilities?: Record<string, unknown>;
};

export type WorkspaceBackendInitializeResponse = {
	ok: true;
	serverInfo: {
		name: string;
		version: string;
	};
	capabilities: {
		appServerPassThrough: true;
		workspaceMethods: string[];
		workspaceMethodMetadata: WorkspaceMethodMetadata[];
	};
};

export type WorkspaceMethodMetadata = {
	name: string;
	description?: string;
	paramsSchema?: unknown;
	resultSchema?: unknown;
	sideEffects?: "none" | "read-only" | "writes-local" | "external-write";
	category?: string;
};

export type AppServerCallParams = {
	method: string;
	params?: unknown;
};

export type AppServerNotifyParams = {
	method: string;
	params?: unknown;
};

export type AppServerRespondParams = {
	id: JsonRpcId;
	result: unknown;
};

export type AppServerRespondErrorParams = {
	id: JsonRpcId;
	code: number;
	message: string;
	data?: unknown;
};

export type AppServerNotificationParams = {
	message: JsonRpcNotification;
};

export type AppServerRequestParams = {
	message: JsonRpcRequest;
};

export type WorkspaceBackendEvent =
	| {
			type: "connected";
			at: string;
	  }
	| {
			type: "appServer.connected";
			at: string;
	  }
	| {
			type: "appServer.closed";
			at: string;
			code?: number | null;
			reason?: string | null;
	  }
	| {
			type: "appServer.error";
			at: string;
			message: string;
	  }
	| {
			type: "unsupportedWorkspaceBackendMethod";
			at: string;
			method: string;
	  };

export type WorkspaceBackendEventParams = {
	event: WorkspaceBackendEvent;
};

export const workspaceBackendOwnedMethodPrefixes = [
	"agent.",
	"automation.",
	"delegation.",
	"functions.",
	"workbench.",
] as const;

export function isWorkspaceBackendOwnedMethod(method: string): boolean {
	return workspaceBackendOwnedMethodPrefixes.some((prefix) => method.startsWith(prefix));
}

export function appServerCallParams(
	value: unknown,
): AppServerCallParams | undefined {
	const input = record(value);
	const method = stringValue(input.method);
	if (!method) {
		return undefined;
	}
	return { method, params: input.params };
}

export function appServerNotifyParams(
	value: unknown,
): AppServerNotifyParams | undefined {
	const input = record(value);
	const method = stringValue(input.method);
	if (!method) {
		return undefined;
	}
	return { method, params: input.params };
}

export function appServerRespondParams(
	value: unknown,
): AppServerRespondParams | undefined {
	const input = record(value);
	const id = jsonRpcIdValue(input.id);
	if (id === undefined || !("result" in input)) {
		return undefined;
	}
	return { id, result: input.result };
}

export function appServerRespondErrorParams(
	value: unknown,
): AppServerRespondErrorParams | undefined {
	const input = record(value);
	const id = jsonRpcIdValue(input.id);
	const code = typeof input.code === "number" ? input.code : undefined;
	const message = stringValue(input.message);
	if (id === undefined || code === undefined || !message) {
		return undefined;
	}
	return { id, code, message, data: input.data };
}

export function appServerNotificationParams(
	value: unknown,
): AppServerNotificationParams | undefined {
	const input = record(value);
	const message = jsonRpcNotification(input.message);
	return message ? { message } : undefined;
}

export function appServerRequestParams(
	value: unknown,
): AppServerRequestParams | undefined {
	const input = record(value);
	const message = jsonRpcRequest(input.message);
	return message ? { message } : undefined;
}

export function workspaceBackendEventParams(
	value: unknown,
): WorkspaceBackendEventParams | undefined {
	const input = record(value);
	const event = record(input.event);
	const type = stringValue(event.type);
	if (!type) {
		return undefined;
	}
	return { event: event as unknown as WorkspaceBackendEvent };
}

function jsonRpcNotification(value: unknown): JsonRpcNotification | undefined {
	const input = record(value);
	const method = stringValue(input.method);
	if (!method || "id" in input) {
		return undefined;
	}
	return { jsonrpc: "2.0", method, params: input.params };
}

function jsonRpcRequest(value: unknown): JsonRpcRequest | undefined {
	const input = record(value);
	const method = stringValue(input.method);
	const id = jsonRpcIdValue(input.id);
	if (!method || id === undefined) {
		return undefined;
	}
	return { jsonrpc: "2.0", id, method, params: input.params };
}

function jsonRpcIdValue(value: unknown): JsonRpcId | undefined {
	return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
