export const workspaceBackendStorageKey = "codex-bare.workspace-backend-url";

export type WorkspaceBackendUrlOptions = {
	envUrl?: string;
	location: Pick<Location, "host" | "protocol">;
	storage?: Pick<Storage, "getItem">;
};

export function initialWorkspaceBackendWsUrl(options: WorkspaceBackendUrlOptions): string {
	return options.storage?.getItem(workspaceBackendStorageKey) ??
		options.envUrl ??
		proxiedWorkspaceBackendWsUrl(options.location);
}

export function proxiedWorkspaceBackendWsUrl(
	location: Pick<Location, "host" | "protocol">,
): string {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}/__codex-workspace-backend`;
}
