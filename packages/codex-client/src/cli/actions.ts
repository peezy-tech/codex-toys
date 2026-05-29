export const COMMON_APP_SERVER_ACTIONS = [
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
	"account/login/start",
	"account/logout",
	"model/list",
	"remoteControl/status/read",
	"remoteControl/enable",
	"remoteControl/disable",
	"mcpServerStatus/list",
	"mcpServer/tool/call",
] as const;

export const COMMON_WORKSPACE_BACKEND_METHODS = [
	"workspace.initialize",
	"delegation.list",
	"delegation.start",
	"delegation.resume",
	"delegation.send",
	"delegation.read",
	"delegation.setPolicy",
	"delegation.flushResults",
	"delegation.listGroups",
	"functions.list",
	"functions.describe",
	"functions.call",
] as const;

export function validateMethodName(value: string, label: string): string {
	if (!/^[A-Za-z][A-Za-z0-9_./-]*$/.test(value)) {
		throw new Error(`${label} must be a JSON-RPC method name`);
	}
	return value;
}
