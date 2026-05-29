import path from "node:path";
import { pathToFileURL } from "node:url";

const resultPrefix = "TURN_AUTOMATION_MODULE_RESULT ";
const scriptPath = process.argv[2];
let nextHostRequestId = 1;
const pendingHostResponses = new Map<number, {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}>();
const contextPromise = new Promise<unknown>((resolve) => {
	process.on("message", (message) => {
		if (isContextMessage(message)) {
			resolve(message.context);
			return;
		}
		if (isHostResponseMessage(message)) {
			const pending = pendingHostResponses.get(message.id);
			if (!pending) {
				return;
			}
			pendingHostResponses.delete(message.id);
			if (message.error) {
				const error = new Error(message.error.message);
				if (message.error.stack) {
					error.stack = message.error.stack;
				}
				pending.reject(error);
				return;
			}
			pending.resolve(message.result);
		}
	});
});

try {
	if (!scriptPath) {
		throw new Error("Turn automation module runner requires a script path");
	}
	const context = await readContext();
	const moduleUrl = pathToFileURL(path.resolve(scriptPath));
	moduleUrl.searchParams.set("automationRun", `${Date.now()}`);
	const module = await import(moduleUrl.href) as { default?: unknown };
	if (typeof module.default !== "function") {
		throw new Error("Turn automation module must export a default handler function");
	}
	const result = await module.default(scriptContext(context)) as unknown;
	if (!isRecord(result)) {
		throw new Error("Turn automation module must return a JSON object");
	}
	process.stdout.write(`${resultPrefix}${JSON.stringify(result)}\n`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	const stack = error instanceof Error ? error.stack : undefined;
	process.stderr.write(`${stack ?? message}\n`);
	process.exitCode = 1;
} finally {
	process.disconnect?.();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scriptContext(context: unknown): unknown {
	if (!isRecord(context)) {
		return context;
	}
	return {
		...context,
		app: {
			call: async (method: string, params?: unknown) =>
				await callHost("app.call", { method, params }),
		},
		workspace: {
			call: async (method: string, params?: unknown) =>
				await callHost("workspace.call", { method, params }),
		},
		turn: {
			start: async (params: unknown) => await callHost("turn.start", params),
			read: async (turn: unknown) => await callHost("turn.read", turn),
			wait: async (turn: unknown, options?: unknown) =>
				await callHost("turn.wait", { turn, options }),
			waitAll: async (turns: unknown[], options?: unknown) =>
				await callHost("turn.waitAll", { turns, options }),
		},
		delegate: {
			list: async (params?: unknown) => await callHost("delegate.list", params),
			start: async (params: unknown) => await callHost("delegate.start", params),
			send: async (params: unknown) => await callHost("delegate.send", params),
			read: async (delegation: unknown) => await callHost("delegate.read", delegation),
			wait: async (delegation: unknown, options?: unknown) =>
				await callHost("delegate.wait", { delegation, options }),
		},
	};
}

function callHost(method: string, params?: unknown): Promise<unknown> {
	if (typeof process.send !== "function") {
		return Promise.reject(new Error("Turn automation host API requires IPC"));
	}
	const id = nextHostRequestId++;
	return new Promise((resolve, reject) => {
		pendingHostResponses.set(id, { resolve, reject });
		process.send?.({
			type: "turnAutomation.hostRequest",
			id,
			method,
			params,
		}, (error) => {
			if (!error) {
				return;
			}
			pendingHostResponses.delete(id);
			reject(error);
		});
	});
}

async function readContext(): Promise<unknown> {
	if (typeof process.send !== "function") {
		throw new Error("Turn automation module runner requires IPC");
	}
	return await contextPromise;
}

function isContextMessage(value: unknown): value is {
	type: "turnAutomation.context";
	context: unknown;
} {
	const message = isRecord(value) ? value : {};
	return message.type === "turnAutomation.context";
}

function isHostResponseMessage(value: unknown): value is {
	type: "turnAutomation.hostResponse";
	id: number;
	result?: unknown;
	error?: {
		message: string;
		stack?: string;
	};
} {
	const message = isRecord(value) ? value : {};
	const error = isRecord(message.error) ? message.error : undefined;
	return message.type === "turnAutomation.hostResponse" &&
		typeof message.id === "number" &&
		(
			message.error === undefined ||
			typeof error?.message === "string"
		);
}
