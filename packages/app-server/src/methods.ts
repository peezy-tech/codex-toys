export const COMMON_APP_SERVER_METHODS = [
	"thread/list",
	"thread/read",
	"thread/start",
	"thread/resume",
	"thread/fork",
	"thread/name/set",
	"thread/goal/set",
	"thread/goal/get",
	"thread/goal/clear",
	"thread/inject_items",
	"turn/start",
	"turn/steer",
	"turn/interrupt",
	"account/read",
	"account/rateLimits/read",
	"account/login/start",
	"account/login/cancel",
	"account/logout",
	"model/list",
	"remoteControl/status/read",
	"remoteControl/enable",
	"remoteControl/disable",
	"mcpServerStatus/list",
	"mcpServer/tool/call",
] as const;

export function validateAppServerMethodName(value: string, label = "method"): string {
	if (!/^[A-Za-z][A-Za-z0-9_./-]*$/.test(value)) {
		throw new Error(`${label} must be a JSON-RPC method name`);
	}
	return value;
}
