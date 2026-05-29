import type { Plugin } from "vite";
import type { CodexToyboxTransport } from "./toybox/client.ts";
import {
	createCodexToysProxyHandler,
	type CodexToysProxyOptions,
} from "./proxy.ts";
import type { SshRemoteProviderOptions } from "./cli/remote-provider.ts";

export type CodexToysRemoteVitePluginOptions =
	Partial<SshRemoteProviderOptions> & {
		ssh?: string;
		sshTarget?: string;
		basePath?: string;
		transport?: CodexToyboxTransport;
	};

export function codexToysRemote(
	options: CodexToysRemoteVitePluginOptions = {},
): Plugin {
	const basePath = normalizeBasePath(options.basePath ?? "/__codex_toys");
	const handler = createCodexToysProxyHandler({
		...options,
		sshTarget: options.sshTarget ?? options.ssh,
		apiBasePath: `${basePath}/api`,
	} satisfies CodexToysProxyOptions);
	return {
		name: "codex-toys-remote",
		configureServer(server) {
			server.middlewares.use(async (request, response, next) => {
				if (!request.url) {
					next();
					return;
				}
				const url = new URL(request.url, "http://codex-toys.local");
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
	return path.replace(/\/+$/, "") || "/__codex_toys";
}
