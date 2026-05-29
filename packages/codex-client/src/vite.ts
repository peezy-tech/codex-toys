import type { Plugin } from "vite";
import type { CodexWorkspaceBackendTransport } from "./workspace-backend/client.ts";
import {
	createCodexFlowsProxyHandler,
	type CodexFlowsProxyOptions,
} from "./proxy.ts";
import type { SshRemoteProviderOptions } from "./cli/remote-provider.ts";

export type CodexFlowsRemoteVitePluginOptions =
	Partial<SshRemoteProviderOptions> & {
		ssh?: string;
		sshTarget?: string;
		basePath?: string;
		transport?: CodexWorkspaceBackendTransport;
	};

export function codexFlowsRemote(
	options: CodexFlowsRemoteVitePluginOptions = {},
): Plugin {
	const basePath = normalizeBasePath(options.basePath ?? "/__codex_flows");
	const handler = createCodexFlowsProxyHandler({
		...options,
		sshTarget: options.sshTarget ?? options.ssh,
		apiBasePath: `${basePath}/api`,
	} satisfies CodexFlowsProxyOptions);
	return {
		name: "codex-flows-remote",
		configureServer(server) {
			server.middlewares.use(async (request, response, next) => {
				if (!request.url) {
					next();
					return;
				}
				const url = new URL(request.url, "http://codex-flows.local");
				if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
					next();
					return;
				}
				await handler(request, response, next);
			});
		},
	};
}

function normalizeBasePath(value: string): string {
	const path = value.startsWith("/") ? value : `/${value}`;
	return path.replace(/\/+$/, "") || "/__codex_flows";
}
