import type {
	JsonRpcId,
	JsonRpcNotification,
	JsonRpcRequest,
} from "@codex-toys/bridge/rpc";

export const TOYBOX_INITIALIZE_METHOD = "toybox.initialize";
export const TOYBOX_EVENT_METHOD = "toybox.event";
export const APP_CALL_METHOD = "app.call";
export const APP_NOTIFY_METHOD = "app.notify";
export const APP_RESPOND_METHOD = "app.respond";
export const APP_RESPOND_ERROR_METHOD = "app.respondError";
export const APP_NOTIFICATION_METHOD = "app.notification";
export const APP_REQUEST_METHOD = "app.request";

export type ToyboxInitializeParams = {
	clientInfo?: {
		name?: string;
		title?: string | null;
		version?: string;
	};
	capabilities?: Record<string, unknown>;
};

export type ToyboxInitializeResponse = {
	ok: true;
	serverInfo: {
		name: string;
		version: string;
	};
	capabilities: {
		appPassThrough: true;
		toyboxMethods: string[];
		toyboxMethodMetadata: ToyboxMethodMetadata[];
	};
};

export type ToyboxMethodMetadata = {
	name: string;
	description?: string;
	paramsSchema?: unknown;
	resultSchema?: unknown;
	sideEffects?: "none" | "read-only" | "writes-local" | "external-write";
	category?: string;
};

export type AppCallParams = {
	method: string;
	params?: unknown;
};

export type AppNotifyParams = {
	method: string;
	params?: unknown;
};

export type AppRespondParams = {
	id: JsonRpcId;
	result: unknown;
};

export type AppRespondErrorParams = {
	id: JsonRpcId;
	code: number;
	message: string;
	data?: unknown;
};

export type AppNotificationParams = {
	message: JsonRpcNotification;
};

export type AppRequestParams = {
	message: JsonRpcRequest;
};

export type ToyboxEvent =
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
			type: "unsupportedToyboxMethod";
			at: string;
			method: string;
	  };

export type ToyboxEventParams = {
	event: ToyboxEvent;
};

export const toyboxOwnedMethodPrefixes = [
	"workflow.",
	"delegation.",
	"feed.",
	"functions.",
	"host.",
	"toybox.",
	"workbench.",
] as const;

export function isToyboxOwnedMethod(method: string): boolean {
	return toyboxOwnedMethodPrefixes.some((prefix) => method.startsWith(prefix));
}

export function appCallParams(
	value: unknown,
): AppCallParams | undefined {
	const input = record(value);
	const method = stringValue(input.method);
	if (!method) {
		return undefined;
	}
	return { method, params: input.params };
}

export function appNotifyParams(
	value: unknown,
): AppNotifyParams | undefined {
	const input = record(value);
	const method = stringValue(input.method);
	if (!method) {
		return undefined;
	}
	return { method, params: input.params };
}

export function appRespondParams(
	value: unknown,
): AppRespondParams | undefined {
	const input = record(value);
	const id = jsonRpcIdValue(input.id);
	if (id === undefined || !("result" in input)) {
		return undefined;
	}
	return { id, result: input.result };
}

export function appRespondErrorParams(
	value: unknown,
): AppRespondErrorParams | undefined {
	const input = record(value);
	const id = jsonRpcIdValue(input.id);
	const code = typeof input.code === "number" ? input.code : undefined;
	const message = stringValue(input.message);
	if (id === undefined || code === undefined || !message) {
		return undefined;
	}
	return { id, code, message, data: input.data };
}

export function appNotificationParams(
	value: unknown,
): AppNotificationParams | undefined {
	const input = record(value);
	const message = jsonRpcNotification(input.message);
	return message ? { message } : undefined;
}

export function appRequestParams(
	value: unknown,
): AppRequestParams | undefined {
	const input = record(value);
	const message = jsonRpcRequest(input.message);
	return message ? { message } : undefined;
}

export function toyboxEventParams(
	value: unknown,
): ToyboxEventParams | undefined {
	const input = record(value);
	const event = record(input.event);
	const type = stringValue(event.type);
	if (!type) {
		return undefined;
	}
	return { event: event as unknown as ToyboxEvent };
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
